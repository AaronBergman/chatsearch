/** Minimal promise wrapper around IndexedDB (shared by the service worker, offscreen engine and UI). */
import type { ChunkRef, ConvContent, ConvMeta, IndexRec } from './types';

const DB_NAME = 'chatsearch';
const DB_VERSION = 1;

export const STORES = {
  meta: 'meta', // ConvMeta, key id
  content: 'content', // ConvContent, key id
  index: 'index', // IndexRec, key id
  chunks: 'chunks', // { id, u: updatedAt, list: ChunkRef[] } semantic chunks per conversation
  vectors: 'vectors', // { k: `${model}|${hash}`, v: Int8Array, s: dequantization scale }
  kv: 'kv', // { k, v } misc state
} as const;

let dbp: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.content)) db.createObjectStore(STORES.content, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.index)) db.createObjectStore(STORES.index, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.chunks)) db.createObjectStore(STORES.chunks, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.vectors)) db.createObjectStore(STORES.vectors, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv, { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      db.onclose = () => {
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
    req.onblocked = () => console.warn('[chatsearch] db open blocked');
  });
  return dbp;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('transaction aborted'));
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllKeys(store: string): Promise<string[]> {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).getAllKeys()) as Promise<string[]>;
}

/** Stream a store in batches (keeps peak memory lower than one huge getAll). */
export async function forEachBatch<T>(store: string, batch: number, fn: (items: T[]) => void | Promise<void>): Promise<void> {
  let lastKey: IDBValidKey | null = null;
  for (;;) {
    const db = await openDB();
    const range: IDBKeyRange | undefined = lastKey === null ? undefined : IDBKeyRange.lowerBound(lastKey, true);
    const items = (await reqP(db.transaction(store, 'readonly').objectStore(store).getAll(range, batch))) as T[];
    if (!items.length) return;
    await fn(items);
    if (items.length < batch) return;
    const last = items[items.length - 1] as any;
    lastKey = last.id ?? last.k;
  }
}

export async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function getMany<T>(store: string, keys: string[]): Promise<(T | undefined)[]> {
  if (!keys.length) return [];
  const db = await openDB();
  const os = db.transaction(store, 'readonly').objectStore(store);
  return Promise.all(keys.map((k) => reqP(os.get(k)) as Promise<T | undefined>));
}

export async function put(store: string, value: any): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

export async function putMany(store: string, values: any[]): Promise<void> {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return txDone(tx);
}

export async function del(store: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const k of keys) os.delete(k);
  return txDone(tx);
}

export async function clearStore(store: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return txDone(tx);
}

export async function count(store: string): Promise<number> {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).count());
}

/** Write a conversation's meta + content + index atomically. */
export async function putConversation(meta: ConvMeta, content: ConvContent | null, index: IndexRec | null, chunks?: { id: string; u: number; list: ChunkRef[] }): Promise<void> {
  const db = await openDB();
  const stores = [STORES.meta, ...(content ? [STORES.content] : []), ...(index ? [STORES.index] : []), ...(chunks ? [STORES.chunks] : [])];
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore(STORES.meta).put(meta);
  if (content) tx.objectStore(STORES.content).put(content);
  if (index) tx.objectStore(STORES.index).put(index);
  if (chunks) tx.objectStore(STORES.chunks).put(chunks);
  return txDone(tx);
}

/** Write many metas in one transaction (list sync). */
export async function putMetas(metas: ConvMeta[]): Promise<void> {
  return putMany(STORES.meta, metas);
}

export async function deleteConversations(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDB();
  const tx = db.transaction([STORES.meta, STORES.content, STORES.index, STORES.chunks], 'readwrite');
  for (const id of ids) {
    tx.objectStore(STORES.meta).delete(id);
    tx.objectStore(STORES.content).delete(id);
    tx.objectStore(STORES.index).delete(id);
    tx.objectStore(STORES.chunks).delete(id);
  }
  return txDone(tx);
}

export async function kvGet<T>(k: string): Promise<T | undefined> {
  const r = await get<{ k: string; v: T }>(STORES.kv, k);
  return r?.v;
}

export async function kvSet(k: string, v: any): Promise<void> {
  return put(STORES.kv, { k, v });
}

export async function wipeAll(): Promise<void> {
  for (const s of Object.values(STORES)) await clearStore(s);
}

export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

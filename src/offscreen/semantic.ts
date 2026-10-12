/**
 * Semantic index: embeds conversation chunks in the background (newest chats first), stores
 * int8-quantized vectors in IndexedDB keyed by model + chunk content hash (so nothing is ever
 * embedded twice), and answers queries with a brute-force dot product over all vectors.
 */
import * as db from '../shared/db';
import { chunkText, hash53 } from '../shared/indexer';
import type { ChunkRef, ConvContent, ConvMeta } from '../shared/types';

export type Mode = 'off' | 'local' | 'cloud';

interface ChunkRec {
  id: string;
  u: number;
  list: ChunkRef[];
}

interface VecRec {
  k: string;
  v: Int8Array;
  s: number;
}

export interface SemanticStatus {
  mode: Mode;
  state: 'off' | 'loading-model' | 'indexing' | 'ready' | 'error' | 'paused';
  done: number;
  total: number;
  device?: string;
  message?: string;
  rate?: number; // chunks per second
}

const MODEL_KEYS: Record<Exclude<Mode, 'off'>, { key: string; dims: number; bands: Bands }> = {
  // cosine bands from spot checks: a clearly on-topic chat scores ~0.5 (local) / ~0.65 (cloud), unrelated ~0.1-0.3
  local: { key: 'leaf-ir-256', dims: 256, bands: { strong: 0.42, weak: 0.31 } },
  cloud: { key: 'qwen3e8b-512', dims: 512, bands: { strong: 0.5, weak: 0.33 } },
};

export interface Bands {
  strong: number;
  weak: number;
}

const QUERY_CACHE_MAX = 200;

function quantize(v: Float32Array, off: number, dims: number): { q: Int8Array; s: number } {
  let max = 1e-9;
  for (let i = 0; i < dims; i++) max = Math.max(max, Math.abs(v[off + i]));
  const scale = 127 / max;
  const q = new Int8Array(dims);
  for (let i = 0; i < dims; i++) q[i] = Math.round(v[off + i] * scale);
  return { q, s: 1 / scale };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let batteryP: Promise<any> | null = null;
async function onBattery(): Promise<boolean> {
  try {
    batteryP ??= (navigator as any).getBattery?.() ?? Promise.resolve(null);
    const b = await batteryP;
    return !!b && b.charging === false;
  } catch {
    return false;
  }
}

export class Semantic {
  mode: Mode = 'off';
  relayUrl = '';
  clientId = '';
  status: SemanticStatus = { mode: 'off', state: 'off', done: 0, total: 0 };
  onStatus: ((s: SemanticStatus) => void) | null = null;

  private worker: Worker | null = null;
  private reqId = 0;
  private waiters = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  private device = '';

  // in-memory vector matrix
  private dims = 0;
  private key = '';
  private n = 0;
  private mat = new Int8Array(0);
  private scales = new Float32Array(0);
  private rowId: string[] = [];
  private rowChunk: ChunkRef[] = [];
  private have = new Set<string>(); // hashes with vectors (current model)
  private stale = new Set<string>(); // chunk hashes whose text changed since the chunk list was built
  private loaded = false;
  private loadingP: Promise<void> | null = null;
  private running = false;
  private kick = false;
  private queryCache = new Map<string, Float32Array>();
  private paused = false;
  lastUse = 0;

  configure(mode: Mode, relayUrl: string, clientId: string) {
    const changed = mode !== this.mode;
    this.mode = mode;
    this.relayUrl = relayUrl;
    this.clientId = clientId;
    if (changed) {
      this.unload();
      this.status = { mode, state: mode === 'off' ? 'off' : 'indexing', done: 0, total: 0 };
      this.emit();
    }
  }

  private emit() {
    this.onStatus?.({ ...this.status, mode: this.mode });
  }

  unload() {
    this.loaded = false;
    this.loadingP = null;
    this.n = 0;
    this.mat = new Int8Array(0);
    this.scales = new Float32Array(0);
    this.rowId = [];
    this.rowChunk = [];
    this.have.clear();
    this.queryCache.clear();
  }

  dropModel() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiters.values()) w.rej(new Error('worker stopped'));
    this.waiters.clear();
  }

  // ------------------------------------------------------------ embedding backends

  private workerCall(msg: any): Promise<any> {
    if (!this.worker) {
      this.worker = new Worker(chrome.runtime.getURL('embed-worker.js'), { type: 'module' });
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        const w = this.waiters.get(m.id);
        if (!w) return;
        this.waiters.delete(m.id);
        if (m.type === 'error') w.rej(new Error(m.error));
        else w.res(m);
      };
      this.worker.onerror = (e) => {
        for (const w of this.waiters.values()) w.rej(new Error(e.message || 'worker error'));
        this.waiters.clear();
        this.worker = null;
      };
    }
    const id = ++this.reqId;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.worker!.postMessage({ ...msg, id, base: chrome.runtime.getURL('') });
    });
  }

  private async embedLocal(texts: string[], query: boolean): Promise<Float32Array> {
    if (!this.device) {
      this.status.state = 'loading-model';
      this.emit();
      const r = await this.workerCall({ type: 'init' });
      this.device = `${r.device} ${r.dtype}`;
      this.status.device = this.device;
    }
    const r = await this.workerCall({ type: 'embed', texts, query });
    return r.vecs as Float32Array;
  }

  private async embedCloud(texts: string[], query: boolean): Promise<Float32Array> {
    const res = await fetch(`${this.relayUrl}/v1/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, type: query ? 'query' : 'document', client: this.clientId }),
    });
    if (!res.ok) {
      let msg = `relay error ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      const err: any = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    const bin = atob(j.data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Float32Array(buf.buffer);
  }

  private embed(texts: string[], query: boolean) {
    return this.mode === 'cloud' ? this.embedCloud(texts, query) : this.embedLocal(texts, query);
  }

  // ------------------------------------------------------------ index

  private ensureCap(rows: number) {
    if (rows * this.dims <= this.mat.length) return;
    let cap = Math.max(1024, this.scales.length * 2);
    while (cap < rows) cap *= 2;
    const m = new Int8Array(cap * this.dims);
    m.set(this.mat.subarray(0, this.n * this.dims));
    const s = new Float32Array(cap);
    s.set(this.scales.subarray(0, this.n));
    this.mat = m;
    this.scales = s;
  }

  private addRow(id: string, chunk: ChunkRef, v: Int8Array, s: number) {
    this.ensureCap(this.n + 1);
    this.mat.set(v, this.n * this.dims);
    this.scales[this.n] = s;
    this.rowId[this.n] = id;
    this.rowChunk[this.n] = chunk;
    this.n++;
  }

  load(): Promise<void> {
    if (this.mode === 'off') return Promise.resolve();
    if (this.loadingP) return this.loadingP;
    this.loadingP = (async () => {
      const { key, dims } = MODEL_KEYS[this.mode as 'local' | 'cloud'];
      this.key = key;
      this.dims = dims;
      this.n = 0;
      this.mat = new Int8Array(0);
      this.scales = new Float32Array(0);
      const vecs = new Map<string, VecRec>();
      const dbh = await db.openDB();
      await new Promise<void>((res, rej) => {
        const req = dbh.transaction(db.STORES.vectors, 'readonly').objectStore(db.STORES.vectors).getAll(IDBKeyRange.bound(key + '|', key + '|￿'));
        req.onsuccess = () => {
          for (const r of req.result as VecRec[]) vecs.set(r.k.slice(key.length + 1), r);
          res();
        };
        req.onerror = () => rej(req.error);
      });
      this.have = new Set(vecs.keys());
      const chunks = await db.getAll<ChunkRec>(db.STORES.chunks);
      let total = 0;
      this.ensureCap(vecs.size + 16);
      for (const c of chunks) {
        for (const ref of c.list) {
          total++;
          const v = vecs.get(ref.h);
          if (v) this.addRow(c.id, ref, v.v, v.s);
        }
      }
      this.status.total = total;
      this.status.done = this.n;
      this.loaded = true;
      this.status.state = this.n >= total ? 'ready' : 'indexing';
      this.emit();
    })();
    return this.loadingP;
  }

  /** Re-read chunk lists for these conversations (after sync) and drop rows that no longer exist. */
  async refresh(ids: string[]) {
    if (!this.loaded) return;
    const recs = await db.getMany<ChunkRec>(db.STORES.chunks, ids);
    const idSet = new Set(ids);
    // remove old rows for these ids (compact)
    let w = 0;
    for (let r = 0; r < this.n; r++) {
      if (idSet.has(this.rowId[r])) continue;
      if (w !== r) {
        this.mat.copyWithin(w * this.dims, r * this.dims, (r + 1) * this.dims);
        this.scales[w] = this.scales[r];
        this.rowId[w] = this.rowId[r];
        this.rowChunk[w] = this.rowChunk[r];
      }
      w++;
    }
    this.n = w;
    this.rowId.length = w;
    this.rowChunk.length = w;
    const need: string[] = [];
    recs.forEach((c) => c?.list.forEach((ref) => this.have.has(ref.h) && need.push(`${this.key}|${ref.h}`)));
    const vecs = await db.getMany<VecRec>(db.STORES.vectors, need);
    const byHash = new Map<string, VecRec>();
    vecs.forEach((v) => v && byHash.set(v.k.slice(this.key.length + 1), v));
    recs.forEach((c, i) => {
      if (!c) return;
      for (const ref of c.list) {
        const v = byHash.get(ref.h);
        if (v) this.addRow(ids[i], ref, v.v, v.s);
      }
    });
    this.kickQueue();
  }

  // ------------------------------------------------------------ query

  async query(q: string): Promise<{ hits: { id: string; sim: number; chunk: ChunkRef }[]; coverage: number; state: 'ok' | 'indexing' | 'off' | 'error'; message?: string; bands?: Bands }> {
    this.lastUse = Date.now();
    if (this.mode === 'off') return { hits: [], coverage: 0, state: 'off', message: 'Semantic search is off. Turn it on in settings.' };
    await this.load();
    const text = q.slice(0, 1000);
    let qv = this.queryCache.get(text);
    if (!qv) {
      try {
        qv = await this.embed([text], true);
      } catch (e: any) {
        return { hits: [], coverage: this.coverage(), state: 'error', message: e?.message || String(e) };
      }
      this.queryCache.set(text, qv);
      if (this.queryCache.size > QUERY_CACHE_MAX) this.queryCache.delete(this.queryCache.keys().next().value!);
    }
    const dims = this.dims;
    const K = 300;
    const topS = new Float32Array(K).fill(-2);
    const topI = new Int32Array(K).fill(-1);
    let minIdx = 0;
    const mat = this.mat;
    for (let r = 0; r < this.n; r++) {
      let dot = 0;
      const base = r * dims;
      for (let j = 0; j < dims; j++) dot += qv[j] * mat[base + j];
      const s = dot * this.scales[r];
      if (s > topS[minIdx]) {
        topS[minIdx] = s;
        topI[minIdx] = r;
        let m = 0;
        for (let k = 1; k < K; k++) if (topS[k] < topS[m]) m = k;
        minIdx = m;
      }
    }
    const hits: { id: string; sim: number; chunk: ChunkRef }[] = [];
    for (let k = 0; k < K; k++) if (topI[k] >= 0) hits.push({ id: this.rowId[topI[k]], sim: topS[k], chunk: this.rowChunk[topI[k]] });
    hits.sort((a, b) => b.sim - a.sim);
    const cov = this.coverage();
    return { hits, coverage: cov, state: cov < 0.999 ? 'indexing' : 'ok', bands: MODEL_KEYS[this.mode as 'local' | 'cloud'].bands };
  }

  coverage() {
    return this.status.total ? Math.min(1, this.n / this.status.total) : 1;
  }

  // ------------------------------------------------------------ background embedding

  kickQueue() {
    if (this.mode === 'off') return;
    this.kick = true;
    if (!this.running) this.runQueue();
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (!p) this.kickQueue();
  }

  isBusy() {
    return this.running;
  }

  private async runQueue() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.kick && this.mode !== 'off') {
        this.kick = false;
        await this.load();
        const chunks = await db.getAll<ChunkRec>(db.STORES.chunks);
        chunks.sort((a, b) => b.u - a.u);
        let total = 0;
        const pending: { id: string; ref: ChunkRef }[] = [];
        const queued = new Set<string>();
        for (const c of chunks) {
          for (const ref of c.list) {
            if (this.stale.has(ref.h)) continue;
            total++;
            if (!this.have.has(ref.h) && !queued.has(ref.h)) {
              queued.add(ref.h);
              pending.push({ id: c.id, ref });
            }
          }
        }
        this.status.total = total;
        this.status.done = total - pending.length;
        if (!pending.length) {
          this.status.state = 'ready';
          this.emit();
          break;
        }
        this.status.state = 'indexing';
        this.emit();
        const cloud = this.mode === 'cloud';
        const batchSize = cloud ? 96 : this.device.startsWith('webgpu') ? 24 : 6;
        let i = 0;
        let backoff = 0;
        const mode = this.mode;
        while (i < pending.length && this.mode === mode) {
          if (this.paused) {
            this.status.state = 'paused';
            this.emit();
            await sleep(5000);
            continue;
          }
          const batch = pending.slice(i, i + batchSize);
          const ids = [...new Set(batch.map((b) => b.id))];
          const [metas, contents] = await Promise.all([db.getMany<ConvMeta>(db.STORES.meta, ids), db.getMany<ConvContent>(db.STORES.content, ids)]);
          const byId = new Map<string, [ConvMeta | undefined, ConvContent | undefined]>();
          ids.forEach((id, k) => byId.set(id, [metas[k], contents[k]]));
          const texts: string[] = [];
          const items: { id: string; ref: ChunkRef }[] = [];
          for (const b of batch) {
            const [m, c] = byId.get(b.id)!;
            const t = m && c ? chunkText(m, c, b.ref) : '';
            if (!t || hash53(t) !== b.ref.h) {
              this.stale.add(b.ref.h); // chunk list is out of date; it is rebuilt on the next ingest
              continue;
            }
            texts.push(t.slice(0, 6000));
            items.push(b);
          }
          i += batch.length;
          if (!texts.length) continue;
          const t0 = performance.now();
          let vecs: Float32Array;
          try {
            vecs = await this.embed(texts, false);
            backoff = 0;
          } catch (e: any) {
            this.status.state = 'error';
            this.status.message = e?.message || String(e);
            this.emit();
            backoff = Math.min(600_000, backoff ? backoff * 2 : 15_000);
            if (e?.status === 429 || e?.status === 403) backoff = Math.max(backoff, 600_000);
            await sleep(backoff);
            i -= batch.length;
            if (this.device === '' && this.mode === 'local') this.dropModel();
            continue;
          }
          const dt = performance.now() - t0;
          const dims = this.dims;
          if (vecs.length !== items.length * dims || !vecs.every(Number.isFinite)) {
            // never store a bad vector: drop the model (next call re-initializes and self-tests)
            this.dropModel();
            this.device = '';
            i -= batch.length;
            await sleep(5000);
            continue;
          }
          const recs: VecRec[] = [];
          items.forEach((it, k) => {
            const { q, s } = quantize(vecs, k * dims, dims);
            recs.push({ k: `${this.key}|${it.ref.h}`, v: q, s });
            if (!this.have.has(it.ref.h)) {
              this.have.add(it.ref.h);
              this.addRow(it.id, it.ref, q, s);
            }
          });
          await db.putMany(db.STORES.vectors, recs);
          this.status.done = Math.min(total, this.status.done + items.length);
          this.status.rate = items.length / (dt / 1000);
          this.status.state = 'indexing';
          this.status.message = undefined;
          this.emit();
          // be a good citizen: local mode runs at ~50% duty cycle on power, ~20% on battery, and backs
          // off right after the user searched
          if (!cloud) {
            const busy = Date.now() - this.lastUse < 4000;
            const battery = await onBattery();
            await sleep(busy ? 400 + dt * 2 : dt * (battery ? 4 : 0.8));
          } else await sleep(150);
        }
        if (this.mode === mode && i >= pending.length) this.kick = true; // re-scan for anything new
        await this.gc();
      }
    } finally {
      this.running = false;
      if (this.mode !== 'off' && this.status.state !== 'error') {
        this.status.state = this.coverage() >= 0.999 ? 'ready' : 'indexing';
        this.emit();
      }
    }
  }

  private lastGc = 0;
  /** Delete vectors no conversation references any more (edited / deleted chats). */
  private async gc() {
    if (Date.now() - this.lastGc < 3600_000) return;
    this.lastGc = Date.now();
    const chunks = await db.getAll<ChunkRec>(db.STORES.chunks);
    const live = new Set<string>();
    for (const c of chunks) for (const r of c.list) live.add(r.h);
    const keys = await db.getAllKeys(db.STORES.vectors);
    const dead = keys.filter((k) => {
      const bar = k.indexOf('|');
      return !live.has(k.slice(bar + 1));
    });
    if (dead.length) await db.del(db.STORES.vectors, dead);
  }
}

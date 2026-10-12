/** Write fetched / captured / imported conversations into IndexedDB with their derived index. */
import * as db from './db';
import { buildChunks, buildIndexRec, type IndexOptions } from './indexer';
import type { ConvContent, ConvMeta, Message } from './types';

/** Timestamps closer than this are the same update seen through different sources. */
export const SAME_INSTANT_MS = 1500;

export interface IngestResult {
  id: string;
  changed: boolean;
}

/** Fields owned by sync bookkeeping that a fresh list/extract result should not clobber. */
export function mergeMeta(prev: ConvMeta | undefined, next: ConvMeta): ConvMeta {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    title: next.title && next.title !== 'Untitled' && next.title !== 'New chat' ? next.title : prev.title || next.title,
    summary: next.summary ?? prev.summary,
    project: next.project ?? prev.project,
    projectId: next.projectId ?? prev.projectId,
    model: next.model ?? prev.model,
    org: next.org ?? prev.org,
    createdAt: next.createdAt || prev.createdAt,
    updatedAt: Math.max(next.updatedAt || 0, prev.updatedAt || 0),
    fetchedUpdatedAt: prev.fetchedUpdatedAt,
    fetchedAt: prev.fetchedAt,
    msgCount: prev.msgCount,
    chars: prev.chars,
    errors: prev.errors,
    lastError: prev.lastError,
    capturedAt: (prev as any).capturedAt,
  } as ConvMeta;
}

export async function ingest(meta: ConvMeta, content: ConvContent, opts: IndexOptions, how: 'api' | 'capture' | 'import' = 'api'): Promise<IngestResult> {
  const prev = await db.get<ConvMeta>(db.STORES.meta, meta.id);
  // exports store float seconds, the APIs ISO strings: the same instant can round 1 ms apart
  if (prev?.updatedAt && meta.updatedAt && Math.abs(prev.updatedAt - meta.updatedAt) < SAME_INSTANT_MS) meta.updatedAt = Math.max(prev.updatedAt, meta.updatedAt);
  const m = mergeMeta(prev, meta);
  m.fetchedUpdatedAt = Math.max(meta.updatedAt || 0, how === 'import' ? 0 : prev?.fetchedUpdatedAt || 0) || meta.updatedAt;
  if (how === 'import' && prev?.fetchedUpdatedAt && prev.fetchedUpdatedAt > (meta.updatedAt || 0)) {
    // we already have a newer copy than the export
    return { id: m.id, changed: false };
  }
  m.fetchedAt = Date.now();
  m.msgCount = content.messages.length;
  m.chars = content.messages.reduce((a, x) => a + x.text.length, 0);
  m.errors = 0;
  m.lastError = undefined;
  if (how === 'capture') (m as any).capturedAt = Date.now();
  const rec = buildIndexRec(m, content, opts);
  const chunks = { id: m.id, u: m.updatedAt, list: buildChunks(m, content) };
  await db.putConversation(m, content, rec, chunks);
  return { id: m.id, changed: true };
}

/** Merge partial captured messages (DOM / paginated API) into whatever we already have. */
export async function mergeCaptured(meta: ConvMeta, incoming: Message[], opts: IndexOptions): Promise<IngestResult> {
  const prevContent = await db.get<ConvContent>(db.STORES.content, meta.id);
  let messages: Message[];
  if (!prevContent) messages = incoming;
  else {
    messages = prevContent.messages.slice();
    const byMid = new Map<string, number>();
    messages.forEach((m, i) => m.mid && byMid.set(m.mid + '|' + (m.kind || 'text'), i));
    let changed = false;
    for (const m of incoming) {
      const key = m.mid ? m.mid + '|' + (m.kind || 'text') : '';
      const at = key ? byMid.get(key) : undefined;
      if (at !== undefined) {
        // keep the existing (usually exact API) text unless the new one is clearly more complete
        if (m.text.length > messages[at].text.length * 1.2 + 20) {
          messages[at] = { ...messages[at], text: m.text };
          changed = true;
        }
      } else {
        messages.push(m);
        changed = true;
      }
    }
    if (!changed) return { id: meta.id, changed: false };
  }
  // caller sets meta.updatedAt (stream end = now; page capture = newest message time)
  return ingest(meta, { id: meta.id, messages }, opts, 'capture');
}

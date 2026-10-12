/** Build the derived search record (IndexRec) for one conversation. */
import { buildBloom } from './bloom';
import { normalize } from './normalize';
import type { ChunkRef, ConvContent, ConvMeta, IndexRec, Message } from './types';

export const INDEX_VERSION = 3;

export interface IndexOptions {
  includeThinking: boolean;
  includeAttachments: boolean;
}

export function messageIncluded(m: Message, o: IndexOptions): boolean {
  if (m.kind === 'thinking') return o.includeThinking;
  if (m.kind === 'attachment') return o.includeAttachments;
  return true;
}

export function roleCode(m: Message): number {
  return m.role === 'user' ? 0 : m.role === 'assistant' ? 1 : 2;
}

/** cyrb53-style 53-bit hash -> base36 string */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function buildIndexRec(meta: ConvMeta, content: ConvContent, o: IndexOptions): IndexRec {
  const parts: string[] = [];
  const n = content.messages.length;
  const starts = new Int32Array(n);
  const roles = new Uint8Array(n);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const m = content.messages[i];
    starts[i] = off;
    roles[i] = roleCode(m);
    const t = messageIncluded(m, o) ? normalize(m.text) : '';
    parts.push(t);
    off += t.length + 1;
  }
  const norm = parts.join('\u0000');
  const bloom = buildBloom([normalize(meta.title), norm]);
  return { id: meta.id, v: INDEX_VERSION, norm, starts, roles, bloom };
}

// ------------------------------------------------------------- semantic chunks

const CHUNK_CHARS = 1400;
const MIN_CHUNK = 24;
const MAX_CHUNKS = 64;

/** Split text into ~CHUNK_CHARS pieces at paragraph / sentence / word boundaries. Returns [start,end) ranges. */
export function splitRanges(text: string, size = CHUNK_CHARS): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let end = Math.min(n, i + size);
    if (end < n) {
      const window = text.slice(i + Math.floor(size * 0.5), end);
      let cut = window.lastIndexOf('\n\n');
      if (cut < 0) cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (cut < 0) cut = window.lastIndexOf(' ');
      if (cut >= 0) end = i + Math.floor(size * 0.5) + cut + 1;
    }
    out.push([i, end]);
    i = end;
  }
  return out;
}

/** Text that gets embedded for a chunk (also hashed, so it must be deterministic). */
export function chunkText(meta: ConvMeta, content: ConvContent, c: ChunkRef): string {
  if (c.m < 0) return gistText(meta, content);
  const m = content.messages[c.m];
  if (!m) return '';
  const body = m.text.slice(c.s, c.e);
  // pair a user's question with the start of the answer for context
  if (m.role === 'user' && c.s === 0) {
    const next = content.messages[c.m + 1];
    if (next && next.role === 'assistant' && next.kind === 'text') return `${body.slice(0, 900)}\n\n${next.text.slice(0, 500)}`;
  }
  return body;
}

function gistText(meta: ConvMeta, content: ConvContent): string {
  const firstUser = content.messages.find((m) => m.role === 'user' && m.kind === 'text');
  const bits = [meta.title];
  if (meta.summary) bits.push(meta.summary.slice(0, 1200));
  else if (firstUser) bits.push(firstUser.text.slice(0, 900));
  return bits.join('\n');
}

export function buildChunks(meta: ConvMeta, content: ConvContent): ChunkRef[] {
  const out: ChunkRef[] = [];
  const seen = new Set<string>();
  const push = (c: Omit<ChunkRef, 'h'>) => {
    const t = chunkText(meta, content, c as ChunkRef);
    if (t.trim().length < MIN_CHUNK) return;
    const h = hash53(t);
    if (seen.has(h)) return;
    seen.add(h);
    out.push({ ...c, h });
  };
  push({ m: -1, s: 0, e: 0 });
  // priority tiers: each user turn, then the start of each answer / artifact, then the rest
  const tiers: Omit<ChunkRef, 'h'>[][] = [[], [], []];
  content.messages.forEach((m, i) => {
    if (m.main === false || m.kind === 'thinking') return;
    splitRanges(m.text).forEach(([s, e], k) => {
      tiers[k === 0 ? (m.role === 'user' ? 0 : 1) : 2].push({ m: i, s, e });
    });
  });
  for (const tier of tiers) {
    for (const c of tier) {
      if (out.length >= MAX_CHUNKS) break;
      push(c);
    }
  }
  return out.slice(0, MAX_CHUNKS);
}

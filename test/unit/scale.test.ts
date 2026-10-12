/**
 * Scale test sized like a heavy user (~10k chats, ~100 MB of text): ingest time, engine load time,
 * memory, and query latency. Uses fake-indexeddb, so absolute IDB timings are pessimistic.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as db from '../../src/shared/db';
import { buildChunks, buildIndexRec } from '../../src/shared/indexer';
import type { ConvContent, ConvMeta } from '../../src/shared/types';
import { Engine } from '../../src/offscreen/engine';

const N = Number(process.env.SCALE_N || 10000);
const AVG_CHARS = Number(process.env.SCALE_CHARS || 10000);

test(`scale: ${N} chats x ~${AVG_CHARS} chars`, async () => {
  const words = readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => w.length > 2);
  // Zipf-ish vocabulary of 30k words
  const vocab = Array.from({ length: 30000 }, (_, i) => words[(i * 7919) % words.length].toLowerCase());
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const word = () => vocab[Math.floor(Math.pow(rnd(), 2.2) * vocab.length)];
  const sentence = (n: number) => {
    const ws: string[] = [];
    for (let i = 0; i < n; i++) ws.push(word());
    ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
    return ws.join(' ') + '. ';
  };
  const now = Date.now();
  const t0 = performance.now();
  let totalChars = 0;
  const batchM: ConvMeta[] = [];
  const batchC: ConvContent[] = [];
  const batchI: any[] = [];
  const batchK: any[] = [];
  const flush = async () => {
    await db.putMany(db.STORES.meta, batchM.splice(0));
    await db.putMany(db.STORES.content, batchC.splice(0));
    await db.putMany(db.STORES.index, batchI.splice(0));
    await db.putMany(db.STORES.chunks, batchK.splice(0));
  };
  let indexMs = 0;
  for (let i = 0; i < N; i++) {
    const id = `claude:${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const target = AVG_CHARS * (0.2 + rnd() * 1.6) * (rnd() < 0.03 ? 8 : 1);
    const messages: ConvContent['messages'] = [];
    let chars = 0;
    let turn = 0;
    while (chars < target) {
      const u = sentence(8 + Math.floor(rnd() * 20));
      let a = '';
      for (let k = 0; k < 3 + rnd() * 10; k++) a += sentence(10 + Math.floor(rnd() * 15)) + (rnd() < 0.2 ? '\n\n' : '');
      if (i === 4242 && turn === 1) a += ' The Blue Angels headline Fleet Week over the bay. ';
      messages.push({ role: 'user', text: u, kind: 'text', main: true }, { role: 'assistant', text: a + ' — “done”', kind: 'text', main: true });
      chars += u.length + a.length;
      turn++;
    }
    totalChars += chars;
    const meta: ConvMeta = { id, source: i % 3 ? 'claude' : 'chatgpt', nativeId: id.slice(7), title: sentence(4).slice(0, 50), createdAt: now - i * 3600_000, updatedAt: now - i * 3600_000, url: 'https://claude.ai/chat/x', fetchedUpdatedAt: now - i * 3600_000 };
    const content = { id, messages };
    const ti = performance.now();
    batchI.push(buildIndexRec(meta, content, { includeThinking: false, includeAttachments: true }));
    batchK.push({ id, u: meta.updatedAt, list: buildChunks(meta, content) });
    indexMs += performance.now() - ti;
    batchM.push(meta);
    batchC.push(content);
    if (batchM.length >= 250) await flush();
  }
  await flush();
  const genMs = performance.now() - t0;
  const mb = (totalChars / 1e6).toFixed(1);
  console.log(`  corpus: ${N} chats, ${mb}M chars; index build ${Math.round(indexMs)} ms (${((totalChars / 1e6) / (indexMs / 1000)).toFixed(1)} M chars/s); total gen+write ${Math.round(genMs)} ms`);

  const heap0 = process.memoryUsage().heapUsed;
  const e = new Engine();
  const tl = performance.now();
  await e.load();
  const loadMs = performance.now() - tl;
  (globalThis as any).gc?.();
  const heap1 = process.memoryUsage().heapUsed;
  let bloomBytes = 0;
  for (const d of e.docs.values()) bloomBytes += (d.bloom?.byteLength || 0);
  console.log(`  engine load ${Math.round(loadMs)} ms (fake-indexeddb), heap +${((heap1 - heap0) / 1e6).toFixed(0)} MB, blooms ${(bloomBytes / 1e6).toFixed(1)} MB`);

  const queries = ['blue angels', 'fleet week', '"headline fleet"', vocab[5], vocab[200], vocab[5000], vocab[29000], 'zzqxj', 'th', vocab[100] + ' ' + vocab[3000], 'abc'];
  for (const q of queries) {
    const ts: number[] = [];
    let res: any;
    for (let k = 0; k < 3; k++) {
      const t = performance.now();
      res = await e.search({ q, limit: 40 });
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    const ls = e.lastStats;
    console.log(`  q=${JSON.stringify(q).padEnd(26)} total=${String(res.total).padStart(5)}  median ${ts[1].toFixed(1)} ms  (match phase ${ls.ms.toFixed(1)} ms, scanned ${ls.scanned} docs / ${(ls.bytes / 1e6).toFixed(1)} MB)`);
  }
  const r = (await e.search({ q: 'blue angels' }))!;
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].id, `claude:${(4242).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`.replace('claude:', r.hits[0].id.startsWith('chatgpt') ? 'chatgpt:' : 'claude:'));
});

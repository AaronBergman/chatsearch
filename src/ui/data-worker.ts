/**
 * Data worker (runs inside the full-page app): imports official ChatGPT / Claude data exports
 * (zip or conversations.json, streamed so multi-GB exports never sit in memory at once) and
 * builds the "export everything" Markdown zip.
 */
import { Unzip, UnzipInflate, Zip, ZipDeflate, strToU8 } from 'fflate';
import * as db from '../shared/db';
import { chatgptConversation, claudeConversation, toMarkdown } from '../shared/extract';
import { ingest } from '../shared/ingest';
import type { ConvContent, ConvMeta } from '../shared/types';

const post = (m: any) => (self as any).postMessage(m);

/** Incrementally split a top-level JSON array into element strings. */
class ArraySplitter {
  private buf = '';
  private pos = 0;
  private depth = 0;
  private inStr = false;
  private esc = false;
  private start = -1;
  constructor(private onElement: (s: string) => void) {}
  push(text: string) {
    this.buf += text;
    const b = this.buf;
    for (let i = this.pos; i < b.length; i++) {
      const c = b.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92) this.esc = true;
        else if (c === 34) this.inStr = false;
        continue;
      }
      if (c === 34) this.inStr = true;
      else if (c === 123 || c === 91) {
        if (this.depth === 1 && c === 123) this.start = i;
        this.depth++;
      } else if (c === 125 || c === 93) {
        this.depth--;
        if (this.depth === 1 && c === 125 && this.start >= 0) {
          this.onElement(b.slice(this.start, i + 1));
          this.start = -1;
        }
      }
    }
    // drop consumed text
    if (this.start >= 0) {
      this.buf = b.slice(this.start);
      this.pos = b.length - this.start;
      this.start = 0;
    } else {
      this.buf = '';
      this.pos = 0;
    }
  }
}

async function importFile(file: File, opts: { includeThinking: boolean; includeAttachments: boolean }) {
  let count = 0;
  let skipped = 0;
  let failed = 0;
  const ids: string[] = [];
  const queue: string[] = [];
  let projects = new Map<string, string>();
  let processing = Promise.resolve();
  const total = file.size;
  let readBytes = 0;
  let lastPost = 0;

  const handle = async (json: string) => {
    let c: any;
    try {
      c = JSON.parse(json);
    } catch {
      failed++;
      return;
    }
    try {
      let r;
      if (c && c.mapping) {
        const { meta, content } = chatgptConversation(c);
        if (meta.projectId && projects.has(meta.projectId)) meta.project = projects.get(meta.projectId);
        if (!content.messages.length) {
          skipped++;
          return;
        }
        r = await ingest(meta, content, opts, 'import');
      } else if (c && Array.isArray(c.chat_messages)) {
        const { meta, content } = claudeConversation(c, undefined);
        if (!content.messages.length) {
          skipped++;
          return;
        }
        r = await ingest(meta, content, opts, 'import');
      } else {
        skipped++;
        return;
      }
      if (r.changed) ids.push(r.id);
      else skipped++;
      count++;
    } catch (e) {
      failed++;
    }
  };

  const splitter = new ArraySplitter((s) => queue.push(s));
  const drainQueue = async () => {
    while (queue.length) await handle(queue.shift()!);
    if (Date.now() - lastPost > 250) {
      lastPost = Date.now();
      post({ type: 'progress', count, skipped, failed, frac: total ? readBytes / total : 0 });
    }
  };

  const isZip = /\.zip$/i.test(file.name) || file.type.includes('zip');
  const reader = file.stream().getReader();
  if (!isZip) {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      readBytes += value.length;
      splitter.push(dec.decode(value, { stream: true }));
      await drainQueue();
    }
    splitter.push(dec.decode());
    await drainQueue();
  } else {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    const dec = new TextDecoder();
    let found = 0;
    unzip.onfile = (f) => {
      const name = f.name.split('/').pop() || '';
      if (/^projects\.json$/i.test(name)) {
        let txt = '';
        const d2 = new TextDecoder();
        f.ondata = (err, chunk, final) => {
          if (err) return;
          txt += d2.decode(chunk, { stream: !final });
          if (final) {
            try {
              const arr = JSON.parse(txt);
              projects = new Map((Array.isArray(arr) ? arr : []).map((p: any) => [String(p.uuid || p.id || ''), String(p.name || p.title || '')] as [string, string]).filter((x) => x[0]));
            } catch {}
          }
        };
        f.start();
        return;
      }
      if (!/^conversations.*\.json$/i.test(name)) return;
      found++;
      const sp = new ArraySplitter((s) => queue.push(s));
      f.ondata = (err, chunk, final) => {
        if (err) {
          failed++;
          return;
        }
        sp.push(dec.decode(chunk, { stream: !final }));
      };
      f.start();
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      readBytes += value.length;
      unzip.push(value);
      processing = processing.then(drainQueue);
      await processing;
    }
    await drainQueue();
    if (!found) throw new Error('No conversations.json found in that zip. Is it a ChatGPT or Claude data export?');
  }
  await drainQueue();
  post({ type: 'progress', count, skipped, failed, frac: 1 });
  return { count, skipped, failed, ids };
}

async function exportAll(filter: string[] | null) {
  const metas = new Map((await db.getAll<ConvMeta>(db.STORES.meta)).map((m) => [m.id, m]));
  const chunks: Uint8Array[] = [];
  let done = false;
  const zip = new Zip((err, data, final) => {
    if (err) throw err;
    chunks.push(data);
    if (final) done = true;
  });
  const want = filter ? new Set(filter) : null;
  const used = new Set<string>();
  let n = 0;
  const index: any[] = [];
  await db.forEachBatch<ConvContent>(db.STORES.content, 100, (batch) => {
    for (const c of batch) {
      if (want && !want.has(c.id)) continue;
      const m = metas.get(c.id);
      if (!m) continue;
      const date = new Date(m.createdAt || m.updatedAt).toISOString().slice(0, 10);
      let base = `${m.source}/${date} ${(m.title || 'chat').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 70)}`;
      let name = `${base}.md`;
      for (let k = 2; used.has(name); k++) name = `${base} (${k}).md`;
      used.add(name);
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      f.push(strToU8(toMarkdown(m, c.messages)), true);
      index.push({ file: name, id: m.nativeId, source: m.source, title: m.title, url: m.url, created: m.createdAt, updated: m.updatedAt, model: m.model, project: m.project });
      n++;
    }
    post({ type: 'progress', count: n });
  });
  const f = new ZipDeflate('index.json', { level: 6 });
  zip.add(f);
  f.push(strToU8(JSON.stringify(index, null, 1)), true);
  zip.end();
  while (!done) await new Promise((r) => setTimeout(r, 10));
  return { blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }), count: n };
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'import') {
      const r = await importFile(m.file, m.opts);
      post({ type: 'done', ...r });
    } else if (m.type === 'export') {
      const r = await exportAll(m.ids || null);
      post({ type: 'done', ...r });
    }
  } catch (e: any) {
    post({ type: 'error', error: String(e?.message || e) });
  }
};

/**
 * The in-memory search engine. Lives in the offscreen document so it stays warm between popup
 * opens, and unloads itself after a period of inactivity.
 *
 * Exact search: per-term trigram Bloom prefilter -> substring verification on normalized text.
 * Ranking: idf-weighted log term frequency, title / whole-word / your-message / phrase boosts,
 * multiplied by a recency factor. Fuzzy: fzf-style subsequence matching on titles plus
 * "did you mean" typo correction against a vocabulary built in the background.
 */
import { bloomHasAll, queryTrigrams } from '../shared/bloom';
import * as db from '../shared/db';
import { INDEX_VERSION } from '../shared/indexer';
import { normalize, normalizeQuery, tables } from '../shared/normalize';
import { parseQuery, type ParsedQuery, type Term } from '../shared/query';
import type { ChunkRef, ConvContent, ConvMeta, IndexRec, Role, SearchHit, SearchRequest, SearchResponse, Snippet, Source, Stats } from '../shared/types';

export interface Doc {
  meta: ConvMeta;
  titleN: string;
  norm: string;
  starts: Int32Array;
  roles: Uint8Array;
  bloom: Uint32Array | null;
  chunks?: ChunkRef[];
  stale?: boolean;
}

interface TermStat {
  title: number;
  body: number;
  word: number;
  user: number;
  pos: number[];
}

interface Match {
  doc: Doc;
  stats: TermStat[];
  score: number;
  phrase: boolean;
}

const HIT_CAP = 60;
const POS_CAP = 8;
const DAY = 86400000;
const EMPTY_I32 = new Int32Array(0);
const EMPTY_U8 = new Uint8Array(0);

let channel: MessageChannel | null = null;
const pending: (() => void)[] = [];
/** Yield to the event loop (MessageChannel is much faster than setTimeout's 4 ms clamp). */
export function yieldNow(): Promise<void> {
  const si = (globalThis as any).setImmediate;
  if (typeof si === 'function') return new Promise((r) => si(r)); // Node (tests)
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => pending.shift()?.();
  }
  return new Promise((r) => {
    pending.push(r);
    channel!.port2.postMessage(0);
  });
}

class ContentCache {
  private map = new Map<string, { c: ConvContent; size: number }>();
  private bytes = 0;
  constructor(private max = 40_000_000) {}
  get(id: string) {
    const e = this.map.get(id);
    if (!e) return undefined;
    this.map.delete(id);
    this.map.set(id, e);
    return e.c;
  }
  set(id: string, c: ConvContent) {
    const size = c.messages.reduce((a, m) => a + m.text.length * 2, 0) + 200;
    const old = this.map.get(id);
    if (old) this.bytes -= old.size;
    this.map.set(id, { c, size });
    this.bytes += size;
    while (this.bytes > this.max && this.map.size > 1) {
      const k = this.map.keys().next().value!;
      this.bytes -= this.map.get(k)!.size;
      this.map.delete(k);
    }
  }
  delete(id: string) {
    const e = this.map.get(id);
    if (e) {
      this.bytes -= e.size;
      this.map.delete(id);
    }
  }
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

export type SemanticQuery = (q: string, docs: Map<string, Doc>) => Promise<{ hits: { id: string; sim: number; chunk: ChunkRef }[]; coverage: number; state: 'ok' | 'indexing' | 'off' | 'error'; message?: string; bands?: { strong: number; weak: number } }>;

// words not worth highlighting in a by-meaning result (the match is about the idea, not these words)
const STOP = new Set('the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get got let put say she too use what when where which while with from have this that they them then than there their these those would could should about into your just like some been were does doing done also more most much many very only over such will want need know make made really thing things something'.split(' '));

export class Engine {
  docs = new Map<string, Doc>();
  private arr: Doc[] = [];
  private arrDirty = true;
  state: 'empty' | 'meta' | 'ready' = 'empty';
  private loading: Promise<void> | null = null;
  loadMs = 0;
  content = new ContentCache();
  vocab: { byLen: string[][]; freq: Map<string, number> } | null = null;
  private vocabBuilding = false;
  semantic: SemanticQuery | null = null;
  onReady: (() => void) | null = null;
  /** ids whose index records need rebuilding (old INDEX_VERSION); handled by the service worker */
  staleIds: string[] = [];
  /** counters from the last exact search (for tuning / debugging) */
  lastStats = { scanned: 0, bytes: 0, ms: 0 };

  list(): Doc[] {
    if (this.arrDirty) {
      this.arr = [...this.docs.values()].sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
      this.arrDirty = false;
    }
    return this.arr;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const t0 = performance.now();
      const metas = await db.getAll<ConvMeta>(db.STORES.meta);
      for (const meta of metas) {
        this.docs.set(meta.id, { meta, titleN: normalize(meta.title), norm: '', starts: EMPTY_I32, roles: EMPTY_U8, bloom: null });
      }
      this.arrDirty = true;
      this.state = 'meta';
      this.onReady?.();
      await db.forEachBatch<IndexRec>(db.STORES.index, 400, (recs) => {
        for (const r of recs) {
          const d = this.docs.get(r.id);
          if (!d) continue;
          this.applyRec(d, r);
        }
      });
      this.state = 'ready';
      this.loadMs = performance.now() - t0;
      this.onReady?.();
      setTimeout(() => this.buildVocab(), 1500);
    })();
    return this.loading;
  }

  private applyRec(d: Doc, r: IndexRec) {
    d.norm = r.norm;
    d.starts = r.starts;
    d.roles = r.roles;
    d.bloom = r.bloom;
    d.stale = r.v !== INDEX_VERSION;
    if (d.stale) this.staleIds.push(r.id);
  }

  /** Re-read the given conversations from IndexedDB (called after sync writes). */
  async refresh(ids: string[]) {
    if (this.state === 'empty') return;
    const metas = await db.getMany<ConvMeta>(db.STORES.meta, ids);
    const recs = await db.getMany<IndexRec>(db.STORES.index, ids);
    ids.forEach((id, i) => {
      const meta = metas[i];
      this.content.delete(id);
      if (!meta) {
        this.docs.delete(id);
        return;
      }
      let d = this.docs.get(id);
      if (!d) {
        d = { meta, titleN: '', norm: '', starts: EMPTY_I32, roles: EMPTY_U8, bloom: null };
        this.docs.set(id, d);
      }
      d.meta = meta;
      d.titleN = normalize(meta.title);
      const r = recs[i];
      if (r) this.applyRec(d, r);
    });
    this.arrDirty = true;
  }

  remove(ids: string[]) {
    for (const id of ids) {
      this.docs.delete(id);
      this.content.delete(id);
    }
    this.arrDirty = true;
  }

  unload() {
    this.docs.clear();
    this.arr = [];
    this.arrDirty = true;
    this.state = 'empty';
    this.loading = null;
    this.content.clear();
    this.vocab = null;
  }

  stats(): Stats {
    const bySource: Stats['bySource'] = { claude: { convs: 0, withContent: 0 }, chatgpt: { convs: 0, withContent: 0 } };
    let withContent = 0,
      messages = 0,
      chars = 0;
    for (const d of this.docs.values()) {
      const s = bySource[d.meta.source];
      s.convs++;
      if (d.meta.fetchedUpdatedAt) {
        s.withContent++;
        withContent++;
      }
      messages += d.starts.length;
      chars += d.norm.length;
    }
    return { convs: this.docs.size, withContent, messages, chars, vectors: 0, vectorTarget: 0, bySource, engineLoaded: this.state === 'ready', loadMs: Math.round(this.loadMs) };
  }

  async getContent(id: string): Promise<ConvContent | undefined> {
    let c = this.content.get(id);
    if (c) return c;
    c = await db.get<ConvContent>(db.STORES.content, id);
    if (c) this.content.set(id, c);
    return c;
  }

  private async getContents(ids: string[]): Promise<Map<string, ConvContent>> {
    const out = new Map<string, ConvContent>();
    const missing: string[] = [];
    for (const id of ids) {
      const c = this.content.get(id);
      if (c) out.set(id, c);
      else missing.push(id);
    }
    if (missing.length) {
      const got = await db.getMany<ConvContent>(db.STORES.content, missing);
      got.forEach((c, i) => {
        if (c) {
          out.set(missing[i], c);
          this.content.set(missing[i], c);
        }
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ search

  async search(req: SearchRequest, isStale: () => boolean = () => false): Promise<SearchResponse | null> {
    const t0 = performance.now();
    if (this.state === 'empty') this.load();
    const pq = parseQuery(req.q || '');
    const f = req.filters || {};
    const sources: Source[] | undefined = pq.sources || f.sources;
    const role = pq.role || (f.mine ? 'user' : undefined);
    const since = pq.since ?? f.since;
    const until = pq.until ?? f.until;
    const starred = pq.starred || f.starred;
    const limit = req.limit ?? 40;
    const offset = req.offset ?? 0;
    const sort = req.sort || 'best';
    const partial = this.state !== 'ready';

    const pass = (d: Doc) =>
      (!sources || sources.includes(d.meta.source)) &&
      (since === undefined || d.meta.updatedAt >= since) &&
      (until === undefined || d.meta.createdAt < until) &&
      (!starred || !!d.meta.starred);

    const base: SearchResponse = { qid: req.qid, q: req.q, hits: [], total: 0, ms: 0, partial, terms: pq.terms.map((t) => t.norm) };

    // ---- semantic
    if (req.semantic && pq.text) {
      return this.semanticSearch(req, pq, pass, base, t0, role);
    }

    // ---- empty query: recent chats
    if (!pq.terms.length) {
      let docs = this.list().filter(pass);
      if (sort === 'oldest') docs = [...docs].reverse();
      base.total = docs.length;
      const page = docs.slice(offset, offset + limit);
      base.hits = await this.recentHits(page);
      base.ms = performance.now() - t0;
      return base;
    }

    const res = await this.exactSearch(pq, pass, role, sort, isStale);
    if (!res) return null;
    let { matches } = res;
    let corrected: string | undefined;
    let suggestion: string | undefined;

    // ---- typo correction when nothing matched
    if (!matches.length && !pq.hasOperators && pq.terms.every((t) => !t.phrase) && this.vocab) {
      const fixed = this.correct(pq.terms);
      if (fixed) {
        const pq2 = parseQuery(fixed);
        const res2 = await this.exactSearch(pq2, pass, role, sort, isStale);
        if (!res2) return null;
        if (res2.matches.length) {
          matches = res2.matches;
          corrected = fixed;
          base.terms = pq2.terms.map((t) => t.norm);
        }
      }
    } else if (matches.length && matches.length < 3 && this.vocab && pq.terms.every((t) => !t.phrase)) {
      // only suggest a spelling that finds clearly more (rare real words can look like typos)
      const fixed = this.correct(pq.terms);
      if (fixed && fixed !== pq.rawText) {
        const res2 = await this.exactSearch(parseQuery(fixed), pass, role, sort, isStale);
        if (!res2) return null;
        if (res2.matches.length >= Math.max(3, matches.length * 3)) suggestion = fixed;
      }
    }

    base.total = matches.length;
    const page = matches.slice(offset, offset + limit);
    const terms = (corrected ? parseQuery(corrected) : pq).terms;
    base.hits = await this.buildHits(page, terms, role, corrected ? 'fuzzy' : 'exact');

    // ---- fuzzy title matches when there are few exact results
    if (offset === 0 && matches.length < 8 && pq.text.length >= 3 && !pq.titleOnly) {
      const have = new Set(matches.map((m) => m.doc.meta.id));
      const negs = pq.neg.map((t) => t.norm);
      const fz = this.fuzzyTitles(pq.text, (d) => pass(d) && !negs.some((n) => d.titleN.includes(n) || d.norm.includes(n)), have, 8 - Math.min(matches.length, 6));
      base.hits.push(...fz);
    }
    base.corrected = corrected;
    base.suggestion = suggestion;
    base.ms = performance.now() - t0;
    if (isStale()) return null;
    return base;
  }

  private async exactSearch(pq: ParsedQuery, pass: (d: Doc) => boolean, role: 'user' | 'assistant' | undefined, sort: string, isStale: () => boolean): Promise<{ matches: Match[] } | null> {
    const terms = [...pq.terms].sort((a, b) => b.norm.length - a.norm.length);
    const order = pq.terms.map((t) => terms.indexOf(t));
    const hashes = terms.map((t) => (t.norm.length >= 3 ? queryTrigrams(t.norm) : null));
    const negs = pq.neg.map((t) => t.norm);
    const roleCode = role === 'user' ? 0 : role === 'assistant' ? 1 : -1;
    const mayBody: boolean[] = new Array(terms.length).fill(false);
    const matches: Match[] = [];
    const docs = this.list();
    let sliceStart = performance.now();
    const tStart = sliceStart;
    this.lastStats = { scanned: 0, bytes: 0, ms: 0 };
    for (let di = 0; di < docs.length; di++) {
      if ((di & 127) === 0 && performance.now() - sliceStart > 10) {
        await yieldNow();
        if (isStale()) return null;
        sliceStart = performance.now();
      }
      const d = docs[di];
      if (!pass(d)) continue;
      // cheap pre-pass over every term before scanning any body: a doc is out as soon as one term is
      // neither in the title nor (per the bloom) possibly in the body
      const body = !pq.titleOnly && !!d.norm;
      let possible = true;
      for (let ti = 0; ti < terms.length; ti++) {
        const inTitle = d.titleN.includes(terms[ti].norm);
        mayBody[ti] = body && (!hashes[ti] || !d.bloom || bloomHasAll(d.bloom, hashes[ti]!));
        if (!inTitle && !mayBody[ti]) {
          possible = false;
          break;
        }
      }
      if (!possible) continue;
      const stats: TermStat[] = [];
      let ok = true;
      for (let ti = 0; ti < terms.length; ti++) {
        const t = terms[ti].norm;
        const st: TermStat = { title: 0, body: 0, word: 0, user: 0, pos: [] };
        let p = d.titleN.indexOf(t);
        while (p >= 0 && st.title < 5) {
          st.title++;
          p = d.titleN.indexOf(t, p + t.length);
        }
        if (body) {
          if (mayBody[ti]) {
            this.lastStats.scanned++;
            this.lastStats.bytes += d.norm.length;
            scanBody(d, t, st, roleCode);
          }
        }
        if (st.title === 0 && st.body === 0) {
          ok = false;
          break;
        }
        stats.push(st);
      }
      if (!ok) continue;
      if (negs.length && negs.some((n) => d.titleN.includes(n) || d.norm.includes(n))) continue;
      matches.push({ doc: d, stats: order.map((i) => stats[i]), score: 0, phrase: false });
    }

    this.lastStats.ms = performance.now() - tStart;
    // idf + score
    const N = Math.max(1, docs.length);
    const df = pq.terms.map((_, i) => matches.reduce((a, m) => a + (m.stats[i].title || m.stats[i].body ? 1 : 0), 0));
    const multi = pq.terms.length > 1 && pq.text.length > 0;
    const now = Date.now();
    for (const m of matches) {
      let s = 0;
      m.stats.forEach((st, i) => {
        const idf = Math.log(1 + N / (df[i] + 1));
        const body = st.body ? Math.log2(1 + st.body) * (st.word ? 1.4 : 1) : 0;
        s += idf * ((st.title ? 2.6 : 0) + body + (st.user ? 0.6 : 0));
      });
      if (multi) {
        const inTitle = m.doc.titleN.includes(pq.text);
        m.phrase = inTitle || (m.doc.norm.length > 0 && m.doc.norm.includes(pq.text));
        if (m.phrase) s *= inTitle ? 1.9 : 1.5;
      }
      const age = Math.max(0, now - m.doc.meta.updatedAt) / DAY;
      s *= 1 + 0.8 * Math.pow(2, -age / 45);
      if (m.doc.meta.starred) s *= 1.1;
      m.score = s;
    }
    if (sort === 'newest') matches.sort((a, b) => b.doc.meta.updatedAt - a.doc.meta.updatedAt);
    else if (sort === 'oldest') matches.sort((a, b) => a.doc.meta.updatedAt - b.doc.meta.updatedAt);
    else matches.sort((a, b) => b.score - a.score || b.doc.meta.updatedAt - a.doc.meta.updatedAt);
    return { matches };
  }

  private hitBase(d: Doc, kind: SearchHit['kind']): SearchHit {
    const m = d.meta;
    return {
      id: m.id,
      source: m.source,
      title: m.title,
      titleHl: [],
      url: m.url,
      updatedAt: m.updatedAt,
      createdAt: m.createdAt,
      project: m.project,
      model: m.model,
      starred: m.starred,
      archived: m.archived,
      hits: 0,
      snippets: [],
      kind,
      score: 0,
      pending: !m.fetchedUpdatedAt,
    };
  }

  private async recentHits(page: Doc[]): Promise<SearchHit[]> {
    const contents = await this.getContents(page.filter((d) => d.meta.fetchedUpdatedAt).map((d) => d.meta.id));
    return page.map((d) => {
      const h = this.hitBase(d, 'recent');
      const c = contents.get(d.meta.id);
      const first = c?.messages.find((m) => m.role === 'user' && m.kind === 'text');
      if (first) {
        const text = first.text.replace(/\*+|`+|__|^#{1,6}\s/gm, '').replace(/\s+/g, ' ').trim().slice(0, 220);
        h.snippets = [{ text, hl: [], role: 'user', msgIdx: c!.messages.indexOf(first), post: first.text.length > 220 }];
      } else if (d.meta.summary) {
        h.snippets = [{ text: d.meta.summary.replace(/\*+|`+|__|^#{1,6}\s/gm, '').replace(/\s+/g, ' ').slice(0, 220), hl: [], role: 'assistant', msgIdx: -1, post: true }];
      }
      return h;
    });
  }

  private async buildHits(page: Match[], terms: Term[], role: 'user' | 'assistant' | undefined, kind: SearchHit['kind']): Promise<SearchHit[]> {
    const contents = await this.getContents(page.filter((m) => m.doc.norm).map((m) => m.doc.meta.id));
    const tnorms = terms.map((t) => t.norm);
    return page.map((m) => {
      const h = this.hitBase(m.doc, kind);
      h.score = m.score;
      h.hits = m.stats.reduce((a, s) => a + s.body + s.title, 0);
      h.titleHl = highlightRanges(m.doc.titleN, tnorms);
      const c = contents.get(m.doc.meta.id);
      if (c) h.snippets = makeSnippets(m.doc, c, m.stats, tnorms, role);
      return h;
    });
  }

  // ------------------------------------------------------------------ fuzzy

  fuzzyTitles(text: string, pass: (d: Doc) => boolean, exclude: Set<string>, max: number): SearchHit[] {
    const needle = text.replace(/\s+/g, ' ');
    if (needle.replace(/ /g, '').length < 3) return [];
    const scored: { d: Doc; s: number; pos: number[] }[] = [];
    for (const d of this.list()) {
      if (exclude.has(d.meta.id) || !pass(d)) continue;
      const r = fuzzyMatch(needle, d.titleN);
      if (r) scored.push({ d, s: r.score, pos: r.pos });
    }
    scored.sort((a, b) => b.s - a.s || b.d.meta.updatedAt - a.d.meta.updatedAt);
    return scored.slice(0, max).map(({ d, s, pos }) => {
      const h = this.hitBase(d, 'title');
      h.score = s;
      h.titleHl = posToRanges(pos);
      return h;
    });
  }

  /** Build the vocabulary used for typo correction (in slices, off the critical path). */
  async buildVocab() {
    if (this.vocab || this.vocabBuilding || this.state !== 'ready') return;
    this.vocabBuilding = true;
    const freq = new Map<string, number>();
    const re = /[a-z0-9À-ɏ]{3,24}/g;
    let slice = performance.now();
    for (const d of this.list()) {
      for (const s of [d.titleN, d.norm]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s))) {
          const w = m[0];
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
      if (performance.now() - slice > 8) {
        await yieldNow();
        slice = performance.now();
        if (this.state !== 'ready') {
          this.vocabBuilding = false;
          return;
        }
      }
    }
    const byLen: string[][] = [];
    for (const [w, c] of freq) {
      if (c < 2) {
        freq.delete(w);
        continue;
      }
      (byLen[w.length] ||= []).push(w);
    }
    this.vocab = { byLen, freq };
    this.vocabBuilding = false;
  }

  /** "Did you mean": fix each unknown term to the most frequent word within edit distance 1-2. */
  correct(terms: Term[]): string | null {
    if (!this.vocab) return null;
    const { byLen, freq } = this.vocab;
    let changed = false;
    const out = terms.map((t) => {
      const w = t.norm;
      if (w.length < 4 || w.includes(' ') || freq.has(w)) return t.raw;
      const maxD = w.length <= 5 ? 1 : 2;
      let best: string | null = null;
      let bestD = maxD + 1;
      let bestF = 0;
      for (let L = w.length - maxD; L <= w.length + maxD; L++) {
        const list = byLen[L];
        if (!list) continue;
        for (const cand of list) {
          const dist = boundedDL(w, cand, Math.min(maxD, bestD));
          if (dist < 0) continue;
          const f = freq.get(cand)!;
          if (dist < bestD || (dist === bestD && f > bestF)) {
            best = cand;
            bestD = dist;
            bestF = f;
          }
        }
      }
      if (best) {
        changed = true;
        return best;
      }
      return t.raw;
    });
    return changed ? out.join(' ') : null;
  }

  // ------------------------------------------------------------------ semantic

  private async semanticSearch(req: SearchRequest, pq: ParsedQuery, pass: (d: Doc) => boolean, base: SearchResponse, t0: number, role: 'user' | 'assistant' | undefined): Promise<SearchResponse | null> {
    if (!this.semantic) {
      base.semantic = { state: 'off', message: 'Semantic search is turned off in settings.' };
      return base;
    }
    if (this.state !== 'ready') await this.load();
    const r = await this.semantic(pq.rawText || req.q, this.docs);
    base.semantic = { state: r.state, message: r.message, coverage: r.coverage };
    // best chunk per conversation
    const best = new Map<string, { sim: number; chunk: ChunkRef }>();
    for (const h of r.hits) {
      const d = this.docs.get(h.id);
      if (!d || !pass(d)) continue;
      if (role && h.chunk.m >= 0 && d.roles[h.chunk.m] !== (role === 'user' ? 0 : 1)) continue;
      const cur = best.get(h.id);
      if (!cur || h.sim > cur.sim) best.set(h.id, h);
    }
    // keyword signal for fusion
    const kw = await this.exactSearch(pq, pass, role, 'best', () => false);
    const kwRank = new Map<string, number>();
    kw?.matches.slice(0, 200).forEach((m, i) => kwRank.set(m.doc.meta.id, i));
    const ranked = [...best.entries()]
      .sort((a, b) => b[1].sim - a[1].sim)
      .map(([id, v], i) => {
        const k = kwRank.get(id);
        const score = 1 / (20 + i) + (k !== undefined ? 0.5 / (20 + k) : 0);
        return { id, sim: v.sim, chunk: v.chunk, score, kw: k !== undefined };
      })
      .sort((a, b) => b.score - a.score);
    base.total = ranked.length;
    const limit = req.limit ?? 40;
    const offset = req.offset ?? 0;
    const page = ranked.slice(offset, offset + limit);
    const contents = await this.getContents(page.map((p) => p.id));
    const tnorms = pq.terms.map((t) => t.norm).filter((t) => t.length >= 3 && !STOP.has(t));
    base.terms = tnorms;
    base.hits = page.map((p) => {
      const d = this.docs.get(p.id)!;
      const h = this.hitBase(d, 'semantic');
      h.sim = p.sim;
      h.score = p.score;
      if (r.bands) h.band = p.sim >= r.bands.strong ? 'strong' : p.sim >= r.bands.weak ? 'related' : 'weak';
      h.titleHl = highlightRanges(d.titleN, tnorms);
      const c = contents.get(p.id);
      if (c) {
        if (p.chunk.m < 0) {
          const first = c.messages.find((m) => m.role === 'user' && m.kind === 'text');
          const text = (d.meta.summary || first?.text || '').replace(/\*+|`+|__|^#{1,6}\s/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);
          if (text) h.snippets = [{ text, hl: highlightRanges(normalize(text), tnorms), role: d.meta.summary ? 'assistant' : 'user', msgIdx: d.meta.summary ? -1 : c.messages.indexOf(first!), post: true }];
        } else {
          const m = c.messages[p.chunk.m];
          if (m) {
            const raw = m.text.slice(p.chunk.s, Math.min(p.chunk.e, p.chunk.s + 260));
            const text = raw.replace(/\*+|`+|__|^#{1,6}\s/gm, '').replace(/\s+/g, ' ').trim();
            h.snippets = [{ text, hl: highlightRanges(normalize(text), tnorms), role: m.role, kind: m.kind, msgIdx: p.chunk.m, pre: p.chunk.s > 0, post: p.chunk.e > p.chunk.s + 260 || p.chunk.e < m.text.length }];
          }
        }
      }
      return h;
    });
    base.ms = performance.now() - t0;
    return base;
  }
}

// ---------------------------------------------------------------------- helpers

function scanBody(d: Doc, t: string, st: TermStat, roleCode: number) {
  const s = d.norm;
  const W = tables().W;
  const starts = d.starts;
  const roles = d.roles;
  const tl = t.length;
  let p = s.indexOf(t);
  let seg = 0;
  while (p >= 0 && st.body < HIT_CAP) {
    while (seg + 1 < starts.length && starts[seg + 1] <= p) seg++;
    const r = roles[seg];
    if (roleCode < 0 || r === roleCode) {
      st.body++;
      if (r === 0) st.user++;
      const before = p > 0 ? s.charCodeAt(p - 1) : 32;
      let after = p + tl < s.length ? s.charCodeAt(p + tl) : 32;
      // treat simple plurals as whole words ("plane" in "planes")
      if (after === 115 && (p + tl + 1 >= s.length || !W[s.charCodeAt(p + tl + 1)])) after = 32;
      if (!W[before] && !W[after]) st.word++;
      if (st.pos.length < POS_CAP) st.pos.push(p);
    }
    p = s.indexOf(t, p + tl);
  }
}

function msgAt(starts: Int32Array, p: number): number {
  let lo = 0,
    hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= p) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function highlightRanges(normText: string, terms: string[]): [number, number][] {
  const r: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    let p = normText.indexOf(t);
    let guard = 0;
    while (p >= 0 && guard++ < 200) {
      r.push([p, p + t.length]);
      p = normText.indexOf(t, p + t.length);
    }
  }
  r.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

const ROLE_OF: Role[] = ['user', 'assistant', 'system'];

function makeSnippets(d: Doc, c: ConvContent, stats: TermStat[], terms: string[], role?: 'user' | 'assistant'): Snippet[] {
  const all: number[] = [];
  stats.forEach((s) => all.push(...s.pos));
  all.sort((a, b) => a - b);
  if (!all.length) return [];
  // anchor preference: a spot where all terms co-occur nearby, then hits in your own messages
  const anchors: number[] = [];
  if (terms.length > 1) {
    for (const p of stats[0].pos) {
      const ok = stats.every((s) => s.pos.some((q) => Math.abs(q - p) < 220));
      if (ok) {
        anchors.push(p);
        break;
      }
    }
  }
  const userHit = all.find((p) => d.roles[msgAt(d.starts, p)] === 0);
  if (userHit !== undefined && !role) anchors.push(userHit);
  anchors.push(...all);
  const out: Snippet[] = [];
  const usedMsgs = new Set<number>();
  for (const p of anchors) {
    if (out.length >= 2) break;
    const mi = msgAt(d.starts, p);
    if (usedMsgs.has(mi)) continue;
    const msg = c.messages[mi];
    if (!msg) continue;
    usedMsgs.add(mi);
    const segStart = d.starts[mi];
    let local = p - segStart;
    let normMsg = d.norm.slice(segStart, segStart + msg.text.length);
    if (normMsg.length !== msg.text.length || normMsg.indexOf('\u0000') >= 0) {
      normMsg = normalize(msg.text);
      local = Math.max(0, normMsg.indexOf(terms[0]));
    }
    out.push(snippetAt(msg.text, normMsg, local, terms, ROLE_OF[d.roles[mi]] || 'assistant', mi, msg.kind));
  }
  return out;
}

const W_BEFORE = 70;
const W_AFTER = 190;

function snippetAt(text: string, normText: string, at: number, terms: string[], role: Role, msgIdx: number, kind: Snippet['kind']): Snippet {
  let from = Math.max(0, at - W_BEFORE);
  let to = Math.min(text.length, at + W_AFTER);
  if (from > 0) {
    const sp = text.indexOf(' ', from);
    if (sp >= 0 && sp < at) from = sp + 1;
  }
  if (to < text.length) {
    const sp = text.lastIndexOf(' ', to);
    if (sp > at + 20) to = sp;
  }
  // collapse whitespace in lockstep so highlight offsets stay aligned
  let disp = '';
  let dispN = '';
  let lastSpace = true;
  for (let i = from; i < to; i++) {
    const n = normText[i];
    if (n === ' ' || n === '\u0000' || isMarkup(text, i)) {
      if (lastSpace) continue;
      disp += ' ';
      dispN += ' ';
      lastSpace = true;
    } else {
      disp += text[i];
      dispN += n;
      lastSpace = false;
    }
  }
  disp = disp.trimEnd();
  dispN = dispN.slice(0, disp.length);
  return { text: disp, hl: highlightRanges(dispN, terms), role, msgIdx, kind, pre: from > 0, post: to < text.length };
}

/** Markdown syntax that reads as noise in a one-line snippet (**bold**, `code`, # headings, __x__). */
function isMarkup(t: string, i: number): boolean {
  const c = t[i];
  if (c === '*' || c === '`') return true;
  if (c === '_') return t[i + 1] === '_' || t[i - 1] === '_';
  if (c === '#') {
    let j = i;
    while (j > 0 && t[j - 1] === '#') j--;
    return j === 0 || t[j - 1] === '\n';
  }
  return false;
}

function posToRanges(pos: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pos) {
    const last = out[out.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}

/** fzf-ish subsequence match. Returns null for no / poor matches. */
export function fuzzyMatch(needle: string, hay: string): { score: number; pos: number[] } | null {
  const n = needle.replace(/ /g, '');
  if (!n.length || n.length > hay.length) return null;
  const W = tables().W;
  let best: { score: number; pos: number[] } | null = null;
  // try a few start positions for the first char
  let start = hay.indexOf(n[0]);
  let tries = 0;
  while (start >= 0 && tries++ < 6) {
    const pos: number[] = [];
    let hi = start;
    let score = 0;
    let prev = -2;
    for (let i = 0; i < n.length; i++) {
      const ch = n[i];
      const j = hay.indexOf(ch, hi);
      if (j < 0) {
        pos.length = 0;
        break;
      }
      const wordStart = j === 0 || !W[hay.charCodeAt(j - 1)];
      score += 1 + (j === prev + 1 ? 2 : 0) + (wordStart ? 1.5 : 0);
      if (prev >= 0 && j > prev + 1) score -= Math.min(2, (j - prev - 1) * 0.15);
      pos.push(j);
      prev = j;
      hi = j + 1;
    }
    if (pos.length === n.length) {
      const span = pos[pos.length - 1] - pos[0] + 1;
      if (span <= n.length * 3 + 4) {
        score -= span * 0.05;
        if (!best || score > best.score) best = { score, pos };
      }
    }
    start = hay.indexOf(n[0], start + 1);
  }
  if (!best) return null;
  // require a reasonably tight match: average >= 2 points per char
  if (best.score < n.length * 1.5) return null;
  return best;
}

/** Damerau-Levenshtein distance if <= max, else -1. */
export function boundedDL(a: string, b: string, max: number): number {
  const la = a.length,
    lb = b.length;
  if (Math.abs(la - lb) > max) return -1;
  let prev2 = new Array(lb + 1).fill(0);
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return -1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb] <= max ? prev[lb] : -1;
}

export function normalizeForHighlight(s: string) {
  return normalizeQuery(s);
}

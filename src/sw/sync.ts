/**
 * Background sync. Claude has no practical rate limit, so it backfills quickly (3 parallel
 * requests). ChatGPT allows roughly one full-conversation read per minute after a ~200 burst and
 * shares that allowance with the user's own browsing, so it uses a small private token bucket
 * (25 burst, 1 per 80 s), pauses while the user is actively on chatgpt.com, and backs off for 30+
 * minutes on any 429. Most ChatGPT content arrives for free instead: from the official data export
 * (import), from conversations the page itself loads, and from the live DOM after each reply.
 */
import * as db from '../shared/db';
import { chatgptConversation, chatgptMeta, claudeConversation, claudeMeta, toMs } from '../shared/extract';
import { ingest, mergeMeta, SAME_INSTANT_MS } from '../shared/ingest';
import { getSettings, setStatus } from '../shared/settings';
import type { ConvMeta, Source } from '../shared/types';
import { claudeFetch, claudeListPage, claudeOrgs } from './claude';
import { chatgptFetch, chatgptListPage, chatgptProjectConversations, chatgptProjects, chatgptToken } from './chatgpt';
import { HttpError, keepAlive, sleep } from './net';

const MIN = 60_000;
const DAY = 86_400_000;

interface ListCursor {
  watermark: number;
  fullOffset: number;
  fullDone: boolean;
  lastFull: number;
  fullStarted: number;
  lastCheck: number;
}

interface SrcState {
  pausedUntil: number;
  backoff: number;
  lists: Record<string, ListCursor>; // claude: per org; chatgpt: 'main' | 'archived'
  orgs?: { uuid: string; name: string }[];
  orgsAt?: number;
  projects?: { id: string; name: string }[];
  projectsAt?: number;
  tokens?: number;
  tokensAt?: number;
  lastRun?: number;
}

const BUCKET_CAP = 25;
const BUCKET_REFILL = 80_000;

async function loadState(src: Source): Promise<SrcState> {
  const r = await chrome.storage.local.get(`sync:${src}`);
  return (r[`sync:${src}`] as SrcState) || { pausedUntil: 0, backoff: 0, lists: {}, tokens: BUCKET_CAP, tokensAt: Date.now() };
}
async function saveState(src: Source, s: SrcState) {
  await chrome.storage.local.set({ [`sync:${src}`]: s });
}

function cursor(s: SrcState, key: string): ListCursor {
  return (s.lists[key] ||= { watermark: 0, fullOffset: 0, fullDone: false, lastFull: 0, fullStarted: 0, lastCheck: 0 });
}

export type Notify = (ids: string[], removed?: boolean) => void;

export class Syncer {
  private running = new Set<Source>();
  private again = new Set<Source>();
  priority = new Set<string>();
  /** last time the user was seen on chatgpt.com (page events) */
  chatgptActiveAt = 0;

  constructor(private notify: Notify) {}

  async run(reason: string, only?: Source) {
    const settings = await getSettings();
    const srcs = (['claude', 'chatgpt'] as Source[]).filter((s) => (!only || s === only));
    await Promise.all(
      srcs.map(async (src) => {
        if (!settings.sources[src]) {
          await setStatus(src, { state: 'disabled', message: undefined });
          return;
        }
        if (this.running.has(src)) {
          this.again.add(src);
          return;
        }
        this.running.add(src);
        const stop = keepAlive();
        try {
          do {
            this.again.delete(src);
            if (src === 'claude') await this.syncClaude(reason);
            else await this.syncChatgpt(reason);
          } while (this.again.has(src));
        } catch (e) {
          console.warn('[chatsearch] sync error', src, e);
          await setStatus(src, { state: 'error', message: String((e as any)?.message || e).slice(0, 200) });
        } finally {
          stop();
          this.running.delete(src);
        }
      }),
    );
  }

  isRunning() {
    return this.running.size > 0;
  }

  // ---------------------------------------------------------------- shared helpers

  private async metasFor(src: Source): Promise<Map<string, ConvMeta>> {
    const all = await db.getAll<ConvMeta>(db.STORES.meta);
    const m = new Map<string, ConvMeta>();
    for (const x of all) if (x.source === src) m.set(x.id, x);
    return m;
  }

  /** Upsert list items as metas. Returns ids whose meta changed. */
  private async upsertList(metas: Map<string, ConvMeta>, fresh: ConvMeta[]): Promise<string[]> {
    const writes: ConvMeta[] = [];
    for (const f of fresh) {
      const prev = metas.get(f.id);
      if (prev && Math.abs(prev.updatedAt - f.updatedAt) < SAME_INSTANT_MS) f.updatedAt = prev.updatedAt;
      if (prev && prev.updatedAt === f.updatedAt && prev.title === f.title && !!prev.starred === !!f.starred && !!prev.archived === !!f.archived && (prev.project || '') === (f.project || prev.project || '')) continue;
      const m = mergeMeta(prev, f);
      // content captured from the page within ~10 minutes of this update counts as current
      if (prev?.capturedAt && prev.fetchedUpdatedAt && f.updatedAt <= prev.capturedAt + 10 * MIN) m.fetchedUpdatedAt = Math.max(prev.fetchedUpdatedAt, f.updatedAt);
      metas.set(m.id, m);
      writes.push(m);
    }
    if (writes.length) await db.putMetas(writes);
    return writes.map((w) => w.id);
  }

  private async report(src: Source, metas: Map<string, ConvMeta>, patch: Parameters<typeof setStatus>[1] = {}) {
    let fetched = 0;
    for (const m of metas.values()) if (m.fetchedUpdatedAt && m.fetchedUpdatedAt >= m.updatedAt) fetched++;
    await setStatus(src, { total: metas.size, fetched, ...patch });
  }

  private queue(metas: Map<string, ConvMeta>): ConvMeta[] {
    const q = [...metas.values()].filter((m) => (!m.fetchedUpdatedAt || m.fetchedUpdatedAt < m.updatedAt) && (m.errors || 0) < 4);
    q.sort((a, b) => (this.priority.has(b.id) ? 1 : 0) - (this.priority.has(a.id) ? 1 : 0) || b.updatedAt - a.updatedAt);
    return q;
  }

  private async fail(src: Source, st: SrcState, e: unknown, metas: Map<string, ConvMeta>): Promise<boolean> {
    if (e instanceof HttpError && (e.rateLimited || e.status === 0)) {
      const base = src === 'chatgpt' ? 30 * MIN : 2 * MIN;
      st.backoff = Math.min(src === 'chatgpt' ? 4 * 60 * MIN : 30 * MIN, st.backoff ? st.backoff * 2 : base);
      if (e.status === 0) st.backoff = Math.min(st.backoff, 5 * MIN);
      st.pausedUntil = Date.now() + Math.max(st.backoff, e.retryAfter || 0);
      if (src === 'chatgpt') st.tokens = 0;
      await saveState(src, st);
      await this.report(src, metas, { state: 'paused', pausedUntil: st.pausedUntil, message: e.status === 0 ? 'Network problem, retrying soon' : `${src === 'chatgpt' ? 'ChatGPT' : 'Claude'} asked us to slow down; resuming automatically` });
      return true;
    }
    if (e instanceof HttpError && e.authFailed) {
      await this.report(src, metas, { state: 'signed-out', message: `Sign in to ${src === 'chatgpt' ? 'chatgpt.com' : 'claude.ai'} in this browser` });
      return true;
    }
    return false;
  }

  private async ingestRaw(src: Source, raw: any, org: string | undefined, prev: ConvMeta | undefined): Promise<string> {
    const settings = await getSettings();
    const opts = { includeThinking: settings.includeThinking, includeAttachments: settings.includeAttachments };
    const { meta, content } = src === 'claude' ? claudeConversation(raw, org) : chatgptConversation(raw);
    if (prev) {
      meta.project ??= prev.project;
      meta.projectId ??= prev.projectId;
      if (!meta.updatedAt || meta.updatedAt < prev.updatedAt) meta.updatedAt = prev.updatedAt;
    }
    await ingest(meta, content, opts, 'api');
    return meta.id;
  }

  // ---------------------------------------------------------------- Claude

  private async syncClaude(reason: string) {
    const st = await loadState('claude');
    const now = Date.now();
    const metas = await this.metasFor('claude');
    if (st.pausedUntil > now && reason !== 'user') {
      await this.report('claude', metas, { state: 'paused', pausedUntil: st.pausedUntil });
      return;
    }
    try {
      if (!st.orgs || !st.orgsAt || now - st.orgsAt > 6 * 3600_000 || reason === 'user') {
        st.orgs = await claudeOrgs();
        st.orgsAt = now;
      }
    } catch (e) {
      if (await this.fail('claude', st, e, metas)) return;
      throw e;
    }
    if (!st.orgs!.length) {
      await this.report('claude', metas, { state: 'signed-out', message: 'Sign in to claude.ai in this browser' });
      return;
    }
    const orgName = (uuid: string) => st.orgs!.find((o) => o.uuid === uuid)?.name;
    await this.report('claude', metas, { state: 'listing', message: undefined, account: st.orgs!.length === 1 ? orgName(st.orgs![0].uuid) : `${st.orgs!.length} organizations` });
    try {
      for (const org of st.orgs!) {
        const c = cursor(st, org.uuid);
        // incremental: newest first until we reach what we have
        const interval = reason === 'alarm' ? 90_000 : 0;
        if (c.fullDone && now - c.lastCheck > interval) {
          await this.claudeIncremental(org.uuid, c, metas);
          c.lastCheck = Date.now();
          await saveState('claude', st);
        }
        // full listing: first run, then weekly (deletions)
        if (!c.fullDone || now - c.lastFull > 7 * DAY) {
          await this.claudeFullList(org.uuid, c, st, metas);
        }
      }
      st.backoff = 0;
      await saveState('claude', st);
    } catch (e) {
      if (await this.fail('claude', st, e, metas)) return;
      throw e;
    }
    await this.fetchClaude(st, metas);
  }

  private async claudeIncremental(org: string, c: ListCursor, metas: Map<string, ConvMeta>) {
    let offset = 0;
    const limit = 25;
    let newest = c.watermark;
    for (let guard = 0; guard < 400; guard++) {
      const { items, hasMore } = await claudeListPage(org, offset, limit);
      const fresh = items.filter((x) => !x.is_temporary).map((x) => claudeMeta(x, org));
      const changed = await this.upsertList(metas, fresh);
      if (changed.length) this.notify(changed);
      for (const f of fresh) newest = Math.max(newest, f.updatedAt);
      const reachedOld = fresh.some((f) => f.updatedAt <= c.watermark && metas.get(f.id)?.updatedAt === f.updatedAt);
      if (reachedOld || !hasMore || !items.length) break;
      offset += items.length;
    }
    c.watermark = newest;
  }

  private async claudeFullList(org: string, c: ListCursor, st: SrcState, metas: Map<string, ConvMeta>) {
    const seenKey = `seen:claude:${org}`;
    let seen = new Set<string>(c.fullOffset ? (await db.kvGet<string[]>(seenKey)) || [] : []);
    if (!c.fullOffset) {
      c.fullStarted = Date.now();
      seen = new Set();
    }
    const limit = 100;
    for (let guard = 0; guard < 1000; guard++) {
      const { items, hasMore } = await claudeListPage(org, c.fullOffset, limit);
      const fresh = items.filter((x) => !x.is_temporary).map((x) => claudeMeta(x, org));
      for (const f of fresh) {
        seen.add(f.id);
        c.watermark = Math.max(c.watermark, f.updatedAt);
      }
      const changed = await this.upsertList(metas, fresh);
      if (changed.length) this.notify(changed);
      c.fullOffset += items.length;
      await db.kvSet(seenKey, [...seen]);
      await saveState('claude', st);
      await this.report('claude', metas, { state: 'listing' });
      if (!hasMore || !items.length) break;
    }
    // catch anything that moved to the top while we paged, then delete what's gone
    await this.claudeIncremental(org, c, metas);
    for (const m of metas.values()) if (m.updatedAt >= c.fullStarted) seen.add(m.id);
    const gone = [...metas.values()].filter((m) => m.org === org && !seen.has(m.id) && m.updatedAt < c.fullStarted).map((m) => m.id);
    if (gone.length && gone.length < Math.max(50, metas.size * 0.3)) {
      await db.deleteConversations(gone);
      for (const id of gone) metas.delete(id);
      this.notify(gone, true);
    }
    c.fullDone = true;
    c.lastFull = Date.now();
    c.fullOffset = 0;
    c.lastCheck = Date.now();
    await db.kvSet(seenKey, []);
    await saveState('claude', st);
  }

  private async fetchClaude(st: SrcState, metas: Map<string, ConvMeta>) {
    const q = this.queue(metas);
    if (!q.length) {
      st.lastRun = Date.now();
      await saveState('claude', st);
      await this.report('claude', metas, { state: 'idle', lastSync: Date.now(), message: undefined, pausedUntil: undefined });
      return;
    }
    await this.report('claude', metas, { state: 'fetching' });
    const deadline = Date.now() + 4 * MIN;
    let i = 0;
    let stopped: unknown = null;
    let lastReport = 0;
    const worker = async () => {
      while (i < q.length && !stopped && Date.now() < deadline) {
        const m = q[i++];
        try {
          const raw = await claudeFetch(m.org!, m.nativeId);
          await this.ingestRaw('claude', raw, m.org, m);
          const fresh = await db.get<ConvMeta>(db.STORES.meta, m.id);
          if (fresh) metas.set(m.id, fresh);
          this.priority.delete(m.id);
          this.notify([m.id]);
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) {
            await db.deleteConversations([m.id]);
            metas.delete(m.id);
            this.notify([m.id], true);
          } else if (e instanceof HttpError && (e.rateLimited || e.authFailed || e.status === 0)) {
            stopped = e;
          } else {
            m.errors = (m.errors || 0) + 1;
            m.lastError = String((e as any)?.message || e).slice(0, 200);
            await db.put(db.STORES.meta, m);
          }
        }
        if (Date.now() - lastReport > 1500) {
          lastReport = Date.now();
          await this.report('claude', metas, { state: 'fetching' });
        }
        await sleep(120);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (stopped && (await this.fail('claude', st, stopped, metas))) return;
    st.lastRun = Date.now();
    await saveState('claude', st);
    const left = this.queue(metas).length;
    await this.report('claude', metas, { state: left ? 'fetching' : 'idle', lastSync: Date.now(), message: undefined, pausedUntil: undefined });
    if (left) this.again.add('claude');
  }

  // ---------------------------------------------------------------- ChatGPT

  private async syncChatgpt(reason: string) {
    const st = await loadState('chatgpt');
    const now = Date.now();
    const metas = await this.metasFor('chatgpt');
    if (st.pausedUntil > now) {
      await this.report('chatgpt', metas, { state: 'paused', pausedUntil: st.pausedUntil });
      return;
    }
    try {
      const tok = await chatgptToken();
      if (!tok) {
        await this.report('chatgpt', metas, { state: 'signed-out', message: 'Sign in to chatgpt.com in this browser' });
        return;
      }
    } catch (e) {
      if (await this.fail('chatgpt', st, e, metas)) return;
      throw e;
    }
    await this.report('chatgpt', metas, { state: 'listing', message: undefined });
    try {
      // projects (names + their chats, which may not appear in the main list)
      if (!st.projectsAt || now - st.projectsAt > (reason === 'user' ? 5 * MIN : 30 * MIN)) {
        try {
          st.projects = await chatgptProjects();
        } catch (e) {
          if (e instanceof HttpError && (e.rateLimited || e.authFailed)) throw e;
          st.projects = st.projects || [];
        }
        st.projectsAt = now;
        await this.chatgptProjectsSync(st, metas);
      }
      const main = cursor(st, 'main');
      const interval = reason === 'alarm' ? 4 * MIN : 20_000;
      if (main.fullDone && now - main.lastCheck > interval) {
        await this.chatgptIncremental(main, metas, st);
        main.lastCheck = Date.now();
      }
      if (!main.fullDone || now - main.lastFull > 7 * DAY) await this.chatgptFullList(st, metas);
      st.backoff = 0;
      await saveState('chatgpt', st);
    } catch (e) {
      if (await this.fail('chatgpt', st, e, metas)) return;
      throw e;
    }
    await this.fetchChatgpt(st, metas);
  }

  private projectName(st: SrcState, gizmo?: string) {
    return gizmo ? st.projects?.find((p) => p.id === gizmo)?.name : undefined;
  }

  private gptMeta(st: SrcState, item: any): ConvMeta {
    const m = chatgptMeta(item);
    m.project = this.projectName(st, item.gizmo_id) || undefined;
    if (!m.updatedAt) m.updatedAt = toMs(item.update_time) || toMs(item.create_time);
    return m;
  }

  private async chatgptIncremental(c: ListCursor, metas: Map<string, ConvMeta>, st: SrcState) {
    let offset = 0;
    let newest = c.watermark;
    for (let guard = 0; guard < 60; guard++) {
      const { items, hasMore } = await chatgptListPage(offset, 28);
      const fresh = items.map((x) => this.gptMeta(st, x));
      const changed = await this.upsertList(metas, fresh);
      if (changed.length) this.notify(changed);
      for (const f of fresh) newest = Math.max(newest, f.updatedAt);
      const reachedOld = fresh.some((f) => f.updatedAt <= c.watermark && metas.get(f.id)?.updatedAt === f.updatedAt);
      if (reachedOld || !hasMore || !items.length) break;
      offset += items.length;
    }
    c.watermark = newest;
  }

  private async chatgptFullList(st: SrcState, metas: Map<string, ConvMeta>) {
    const c = cursor(st, 'main');
    const a = cursor(st, 'archived');
    const seenKey = 'seen:chatgpt';
    let seen = new Set<string>(c.fullOffset || a.fullOffset ? (await db.kvGet<string[]>(seenKey)) || [] : []);
    if (!c.fullOffset && !a.fullOffset) {
      c.fullStarted = Date.now();
      seen = new Set();
    }
    for (const [cur, archived] of [
      [c, false],
      [a, true],
    ] as [ListCursor, boolean][]) {
      if (archived && cur.fullDone && cur.lastFull >= c.fullStarted) continue;
      for (let guard = 0; guard < 400; guard++) {
        const { items, hasMore } = await chatgptListPage(cur.fullOffset, 100, archived);
        const fresh = items.map((x) => this.gptMeta(st, x));
        for (const f of fresh) {
          seen.add(f.id);
          if (!archived) c.watermark = Math.max(c.watermark, f.updatedAt);
        }
        const changed = await this.upsertList(metas, fresh);
        if (changed.length) this.notify(changed);
        cur.fullOffset += items.length;
        await db.kvSet(seenKey, [...seen]);
        await saveState('chatgpt', st);
        await this.report('chatgpt', metas, { state: 'listing' });
        if (!hasMore || !items.length) break;
        await sleep(400);
      }
      cur.fullOffset = 0;
      cur.fullDone = true;
      cur.lastFull = Date.now();
      await saveState('chatgpt', st);
    }
    await this.chatgptIncremental(c, metas, st);
    for (const m of metas.values()) if (m.updatedAt >= c.fullStarted || m.projectId) seen.add(m.id);
    const gone = [...metas.values()].filter((m) => !seen.has(m.id) && m.updatedAt < c.fullStarted).map((m) => m.id);
    if (gone.length && gone.length < Math.max(50, metas.size * 0.3)) {
      await db.deleteConversations(gone);
      for (const id of gone) metas.delete(id);
      this.notify(gone, true);
    }
    c.lastCheck = Date.now();
    await db.kvSet(seenKey, []);
    await saveState('chatgpt', st);
  }

  private async chatgptProjectsSync(st: SrcState, metas: Map<string, ConvMeta>) {
    for (const p of st.projects || []) {
      let cur = '0';
      for (let guard = 0; guard < 40; guard++) {
        const { items, cursor: next } = await chatgptProjectConversations(p.id, cur);
        const fresh = items.map((x) => {
          const m = this.gptMeta(st, { ...x, gizmo_id: x.gizmo_id || p.id });
          m.project = p.name;
          m.projectId = p.id;
          return m;
        });
        const changed = await this.upsertList(metas, fresh);
        if (changed.length) this.notify(changed);
        // stop paging once a page brings nothing new (projects are re-checked every 30 min)
        if (!next || !items.length || (!changed.length && guard > 0)) break;
        cur = next;
        await sleep(300);
      }
    }
  }

  private async userOnChatgpt(): Promise<boolean> {
    if (Date.now() - this.chatgptActiveAt < 2 * MIN) return true;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
      return tabs.length > 0;
    } catch {
      return false;
    }
  }

  private async fetchChatgpt(st: SrcState, metas: Map<string, ConvMeta>) {
    const q = this.queue(metas);
    const now = Date.now();
    st.tokens = Math.min(BUCKET_CAP, (st.tokens ?? BUCKET_CAP) + (now - (st.tokensAt || now)) / BUCKET_REFILL);
    st.tokensAt = now;
    if (!q.length) {
      await saveState('chatgpt', st);
      await this.report('chatgpt', metas, { state: 'idle', lastSync: now, message: undefined, pausedUntil: undefined });
      return;
    }
    if (await this.userOnChatgpt()) {
      await saveState('chatgpt', st);
      await this.report('chatgpt', metas, { state: 'idle', lastSync: now, message: 'Waiting while you use ChatGPT (it shares a rate limit with you)' });
      return;
    }
    let done = 0;
    for (const m of q) {
      if ((st.tokens ?? 0) < 1) break;
      st.tokens! -= 1;
      await saveState('chatgpt', st);
      await this.report('chatgpt', metas, { state: 'fetching', message: undefined });
      try {
        const raw = await chatgptFetch(m.nativeId);
        await this.ingestRaw('chatgpt', raw, undefined, m);
        const fresh = await db.get<ConvMeta>(db.STORES.meta, m.id);
        if (fresh) metas.set(m.id, fresh);
        this.notify([m.id]);
        done++;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404 && /not.?found|does not exist/i.test(e.body || '')) {
          await db.deleteConversations([m.id]);
          metas.delete(m.id);
          this.notify([m.id], true);
        } else if (e instanceof HttpError && (e.rateLimited || e.authFailed || e.status === 0)) {
          if (await this.fail('chatgpt', st, e, metas)) return;
        } else {
          m.errors = (m.errors || 0) + 1;
          m.lastError = String((e as any)?.message || e).slice(0, 200);
          await db.put(db.STORES.meta, m);
        }
      }
      await sleep(1500 + Math.random() * 1500);
    }
    const left = this.queue(metas).length;
    const nextIn = left ? Math.ceil(BUCKET_REFILL / 1000) : 0;
    await this.report('chatgpt', metas, {
      state: 'idle',
      lastSync: Date.now(),
      message: left ? `${left.toLocaleString()} chats left to download at ChatGPT's pace (about ${Math.max(1, Math.round((left * BUCKET_REFILL) / 3600_000))} h). Import your ChatGPT data export to finish instantly.` : undefined,
      pausedUntil: undefined,
    });
    void nextIn;
    void done;
  }

  /** Fetch one conversation right away (used after a Claude reply finishes streaming). */
  async fetchNow(src: Source, nativeId: string, org?: string) {
    const id = `${src}:${nativeId}`;
    const prev = await db.get<ConvMeta>(db.STORES.meta, id);
    try {
      if (src === 'claude') {
        const o = org || prev?.org || (await loadState('claude')).orgs?.[0]?.uuid;
        if (!o) return;
        const raw = await claudeFetch(o, nativeId);
        await this.ingestRaw('claude', raw, o, prev);
      } else {
        const raw = await chatgptFetch(nativeId);
        await this.ingestRaw('chatgpt', raw, undefined, prev);
      }
      this.notify([id]);
    } catch (e) {
      console.warn('[chatsearch] fetchNow failed', e);
    }
  }
}

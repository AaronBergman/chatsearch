/** Service worker: sync scheduling, page-capture ingest, omnibox, offscreen engine lifecycle. */
import * as db from '../shared/db';
import { chatgptConversation, chatgptMeta, claudeConversation, toMs } from '../shared/extract';
import { buildChunks, buildIndexRec, INDEX_VERSION } from '../shared/indexer';
import { ingest, mergeCaptured } from '../shared/ingest';
import { getClientId, getSettings, setSettings } from '../shared/settings';
import type { ConvContent, ConvMeta, Message, Settings, Source } from '../shared/types';
import { keepAlive } from './net';
import { Syncer } from './sync';

// ------------------------------------------------------------------ change notifications

let pendingIds = new Set<string>();
let pendingRemoved = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify(ids: string[], removed = false) {
  for (const id of ids) (removed ? pendingRemoved : pendingIds).add(id);
  if (!flushTimer) flushTimer = setTimeout(flush, 350);
}

async function flush() {
  flushTimer = null;
  const ids = [...pendingIds];
  const removed = [...pendingRemoved];
  pendingIds = new Set();
  pendingRemoved = new Set();
  if (!ids.length && !removed.length) return;
  broadcast({ type: 'docs-changed', ids, removed });
  const s = await getSettings();
  if (s.semantic !== 'off' && ids.length) {
    await ensureOffscreen();
    broadcast({ type: 'embed-kick' });
  }
}

function broadcast(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => void 0);
}

const syncer = new Syncer(notify);

// ------------------------------------------------------------------ offscreen engine

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const ctx = await (chrome.runtime as any).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return Array.isArray(ctx) && ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Keeps the chat search index warm between searches and runs on-device embeddings.',
      })
      .catch((e) => {
        if (!String(e?.message || e).includes('single offscreen')) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => void 0);
}

// ------------------------------------------------------------------ setup

async function applyActionBehavior(s?: Settings) {
  s ??= await getSettings();
  const side = s.iconOpens === 'sidepanel';
  await chrome.action.setPopup({ popup: side ? '' : 'popup.html' });
  await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: side }).catch(() => void 0);
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'search-selection', title: 'Search my chats for "%s"', contexts: ['selection'] });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.alarms.create('tick', { periodInMinutes: 1 });
  setupMenus();
  await applyActionBehavior();
  await getClientId();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html#welcome') });
  }
  syncer.run('install');
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('tick', { periodInMinutes: 1 });
  await applyActionBehavior();
  syncer.run('startup');
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tick') {
    syncer.run('alarm');
    maybeReindex();
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'search-selection' && info.selectionText) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`app.html?q=${encodeURIComponent(info.selectionText.slice(0, 200))}`) });
  }
});

// ------------------------------------------------------------------ reindex (settings change / version bump)

let reindexing = false;
async function reindexAll(force = false) {
  if (reindexing) return;
  reindexing = true;
  const stop = keepAlive();
  try {
    const s = await getSettings();
    const opts = { includeThinking: s.includeThinking, includeAttachments: s.includeAttachments };
    const metas = new Map((await db.getAll<ConvMeta>(db.STORES.meta)).map((m) => [m.id, m]));
    let ids: string[] = [];
    await db.forEachBatch<ConvContent>(db.STORES.content, 200, async (batch) => {
      const recs = [];
      const chunks = [];
      for (const c of batch) {
        const m = metas.get(c.id);
        if (!m) continue;
        recs.push(buildIndexRec(m, c, opts));
        chunks.push({ id: m.id, u: m.updatedAt, list: buildChunks(m, c) });
        ids.push(c.id);
      }
      await db.putMany(db.STORES.index, recs);
      await db.putMany(db.STORES.chunks, chunks);
      if (ids.length > 500) {
        notify(ids);
        ids = [];
      }
    });
    notify(ids);
    await db.kvSet('indexVersion', INDEX_VERSION);
    await db.kvSet('indexOpts', opts);
    void force;
  } finally {
    stop();
    reindexing = false;
  }
}

async function maybeReindex() {
  const v = await db.kvGet<number>('indexVersion');
  if (v === undefined) {
    await db.kvSet('indexVersion', INDEX_VERSION);
    return;
  }
  if (v !== INDEX_VERSION) reindexAll();
}

// ------------------------------------------------------------------ page capture

const touchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function fingerprint(t: string) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
}

async function onCapture(msg: any, sender: chrome.runtime.MessageSender) {
  const s = await getSettings();
  const opts = { includeThinking: s.includeThinking, includeAttachments: s.includeAttachments };
  const src = msg.source as Source;
  if (!s.sources[src]) return;
  if (src === 'chatgpt') syncer.chatgptActiveAt = Date.now();

  if (msg.type === 'cap' && src === 'claude' && msg.data?.uuid && Array.isArray(msg.data.chat_messages)) {
    const prev = await db.get<ConvMeta>(db.STORES.meta, `claude:${msg.data.uuid}`);
    const { meta, content } = claudeConversation(msg.data, msg.org || prev?.org);
    if (prev) {
      meta.project ??= prev.project;
      meta.projectId ??= prev.projectId;
    }
    if (prev?.fetchedUpdatedAt && prev.fetchedUpdatedAt >= meta.updatedAt && prev.msgCount === content.messages.length) return;
    await ingest(meta, content, opts, 'api');
    notify([meta.id]);
  } else if (msg.type === 'cap' && src === 'chatgpt' && msg.data?.mapping) {
    const { meta, content } = chatgptConversation(msg.data);
    const prev = await db.get<ConvMeta>(db.STORES.meta, meta.id);
    if (prev) {
      meta.project ??= prev.project;
      meta.projectId ??= prev.projectId;
    }
    if (prev?.fetchedUpdatedAt && prev.fetchedUpdatedAt >= meta.updatedAt && prev.msgCount === content.messages.length) return;
    await ingest(meta, content, opts, 'api');
    notify([meta.id]);
  } else if ((msg.type === 'cap-page' || msg.type === 'dom') && src === 'chatgpt' && msg.id) {
    const id = `chatgpt:${msg.id}`;
    const prev = await db.get<ConvMeta>(db.STORES.meta, id);
    const meta: ConvMeta = prev
      ? { ...prev }
      : chatgptMeta({ id: msg.id, title: msg.title || 'New chat', create_time: Date.now() / 1000, update_time: Date.now() / 1000 });
    if (msg.title && msg.title !== 'ChatGPT') meta.title = msg.title;
    const incoming: Message[] = (msg.messages || []).filter((m: Message) => m && typeof m.text === 'string' && m.text.trim());
    if (!incoming.length) return;
    const newest = Math.max(0, ...incoming.map((m) => m.ts || 0));
    meta.updatedAt = msg.type === 'dom' ? Math.max(meta.updatedAt || 0, Date.now() - 2000) : Math.max(meta.updatedAt || 0, newest);
    // drop DOM messages we already have (ids can differ from the API's merged nodes)
    const existing = await db.get<ConvContent>(db.STORES.content, id);
    const fps = new Set((existing?.messages || []).map((m) => fingerprint(m.text)));
    const fresh = incoming.filter((m) => !fps.has(fingerprint(m.text)));
    if (!fresh.length && prev) return;
    const r = await mergeCaptured(meta, fresh.length ? fresh : incoming, opts);
    if (r.changed) notify([id]);
  } else if (msg.type === 'touched') {
    if (src === 'claude' && msg.id) {
      const key = `claude:${msg.id}`;
      clearTimeout(touchTimers.get(key));
      touchTimers.set(
        key,
        setTimeout(() => {
          touchTimers.delete(key);
          syncer.fetchNow('claude', msg.id, msg.org);
        }, 1500),
      );
    }
  } else if (msg.type === 'deleted' && msg.id) {
    const id = `${src}:${msg.id}`;
    await db.deleteConversations([id]);
    notify([id], true);
  } else if (msg.type === 'renamed' && msg.id && msg.title) {
    const id = `${src}:${msg.id}`;
    const prev = await db.get<ConvMeta>(db.STORES.meta, id);
    if (prev) {
      prev.title = msg.title;
      // the title is part of the index and the summary chunk, so rebuild both from the stored text
      const content = await db.get<ConvContent>(db.STORES.content, id);
      if (content) {
        const opts = { includeThinking: s.includeThinking, includeAttachments: s.includeAttachments };
        await db.putConversation(prev, content, buildIndexRec(prev, content, opts), { id, u: prev.updatedAt, list: buildChunks(prev, content) });
      } else await db.put(db.STORES.meta, prev);
      notify([id]);
    }
  }
  void sender;
}

// ------------------------------------------------------------------ highlight hand-off for "open at match"

const highlights = new Map<string, any>();
function chatKey(url: string): string | null {
  const m = /\/c(?:hat)?\/([0-9a-f-]{36})/.exec(url);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.to === 'offscreen') return; // engine traffic
  switch (msg.type) {
    case 'cap':
    case 'cap-page':
    case 'dom':
    case 'touched':
    case 'deleted':
    case 'renamed':
      onCapture(msg, sender).catch((e) => console.warn('[chatsearch] capture failed', e));
      return;
    case 'active':
      if (msg.source === 'chatgpt') syncer.chatgptActiveAt = Date.now();
      return;
    case 'page-hello':
      // a claude.ai / chatgpt.com tab loaded: good moment for a cheap incremental check
      syncer.run('page', msg.source);
      return;
    case 'get-highlight': {
      const key = chatKey(sender.url || sender.tab?.url || '');
      if (!key) {
        sendResponse(null);
        return;
      }
      // memory first, then session storage (survives a service-worker restart between click and page load)
      const mem = highlights.get(key);
      highlights.delete(key);
      chrome.storage.session.get(`hl:${key}`).then((r) => {
        const stored = r[`hl:${key}`] as { intent: any; at: number } | undefined;
        chrome.storage.session.remove(`hl:${key}`);
        sendResponse(mem || (stored && Date.now() - stored.at < 60_000 ? stored.intent : null));
      });
      return true;
    }
    case 'set-highlight': {
      const key = chatKey(msg.intent?.url || '');
      if (key) {
        highlights.set(key, msg.intent);
        setTimeout(() => highlights.delete(key), 60_000);
        chrome.storage.session.set({ [`hl:${key}`]: { intent: msg.intent, at: Date.now() } });
      }
      sendResponse(true);
      return;
    }
    case 'ensure-engine':
      ensureOffscreen().then(
        () => sendResponse(true),
        (e) => sendResponse({ error: String(e) }),
      );
      return true;
    case 'offscreen-idle':
      closeOffscreen();
      return;
    case 'get-config':
      Promise.all([getSettings(), getClientId()]).then(([settings, clientId]) => sendResponse({ settings, clientId }));
      return true;
    case 'sync-now':
      syncer.run('user', msg.source);
      sendResponse(true);
      return;
    case 'settings':
      (async () => {
        const prev = await getSettings();
        const next = await setSettings(msg.patch || {});
        await applyActionBehavior(next);
        if (prev.includeThinking !== next.includeThinking || prev.includeAttachments !== next.includeAttachments) reindexAll(true);
        if (prev.semantic !== next.semantic || prev.relayUrl !== next.relayUrl) {
          if (next.semantic !== 'off') await ensureOffscreen();
          broadcast({ type: 'semantic-config' });
        }
        if (JSON.stringify(prev.sources) !== JSON.stringify(next.sources)) syncer.run('user');
        sendResponse(next);
      })();
      return true;
    case 'reindex':
      reindexAll(true).then(() => sendResponse(true));
      return true;
    case 'imported':
      notify(msg.ids || []);
      if (msg.reload) broadcast({ type: 'reload-all' });
      return;
    case 'wipe':
      (async () => {
        await closeOffscreen();
        await db.wipeAll();
        await chrome.storage.local.remove(['sync:claude', 'sync:chatgpt', 'status', 'history']);
        sendResponse(true);
        syncer.run('user');
      })();
      return true;
  }
});

// ------------------------------------------------------------------ omnibox

let omniSeq = 0;
function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
function ago(t: number) {
  const d = (Date.now() - t) / 86400000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

chrome.omnibox.setDefaultSuggestion({ description: 'Search your Claude and ChatGPT chats' });
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const seq = ++omniSeq;
  if (text.trim().length < 2) return;
  await ensureOffscreen();
  const res: any = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'search', req: { q: text, limit: 6 } }).catch(() => null);
  if (seq !== omniSeq || !res?.hits) return;
  chrome.omnibox.setDefaultSuggestion({ description: `Search chats for <match>${xmlEscape(text)}</match> <dim>(${res.total.toLocaleString()} matches)</dim>` });
  suggest(
    res.hits.slice(0, 6).map((h: any) => {
      const src = h.source === 'claude' ? 'Claude' : 'ChatGPT';
      const snip = h.snippets?.[0]?.text ? ` - ${xmlEscape(h.snippets[0].text.slice(0, 90))}` : '';
      return { content: h.url, description: `<match>${xmlEscape(h.title)}</match> <dim>${src} · ${ago(h.updatedAt)}${snip}</dim>` };
    }),
  );
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  const url = /^https:\/\/(claude\.ai|chatgpt\.com)\//.test(text) ? text : chrome.runtime.getURL(`app.html?q=${encodeURIComponent(text)}`);
  if (disposition === 'currentTab') chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});

void toMs;

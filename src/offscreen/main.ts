/** Offscreen document: hosts the warm search engine and the semantic index. */
import * as db from '../shared/db';
import type { ConvMeta, Settings } from '../shared/types';
import { Engine } from './engine';
import { Semantic, type SemanticStatus } from './semantic';

const engine = new Engine();
const semantic = new Semantic();
let lastActivity = Date.now();
let uiPorts = 0;
const latestQid = new Map<string, number>();

function broadcast(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => void 0);
}

engine.onReady = () => broadcast({ type: 'engine-state', state: engine.state });
engine.semantic = async (q) => semantic.query(q);
semantic.onStatus = (s: SemanticStatus) => broadcast({ type: 'semantic-status', status: s });

async function configureSemantic() {
  const r: { settings: Settings; clientId: string } | null = await chrome.runtime.sendMessage({ type: 'get-config' }).catch(() => null);
  if (!r) return;
  semantic.configure(r.settings.semantic, r.settings.relayUrl, r.clientId);
  if (r.settings.semantic !== 'off') semantic.kickQueue();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  uiPorts++;
  lastActivity = Date.now();
  if (engine.state === 'empty') engine.load();
  port.onDisconnect.addListener(() => {
    uiPorts--;
    lastActivity = Date.now();
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  // broadcasts from the service worker
  if (msg.type === 'docs-changed') {
    if (msg.removed?.length) {
      engine.remove(msg.removed);
      semantic.refresh(msg.removed);
    }
    if (msg.ids?.length) {
      engine.refresh(msg.ids).then(() => broadcast({ type: 'engine-updated', ids: msg.ids }));
      semantic.refresh(msg.ids);
    }
    return;
  }
  if (msg.type === 'reload-all') {
    engine.unload();
    engine.load();
    semantic.unload();
    semantic.kickQueue();
    return;
  }
  if (msg.type === 'embed-kick') {
    semantic.kickQueue();
    return;
  }
  if (msg.type === 'semantic-config') {
    configureSemantic();
    return;
  }
  if (msg.to !== 'offscreen') return;
  lastActivity = Date.now();
  switch (msg.type) {
    case 'search': {
      const cid = msg.cid || 'default';
      const qid = msg.req?.qid ?? 0;
      latestQid.set(cid, qid);
      engine
        .search(msg.req, () => latestQid.get(cid) !== qid)
        .then(
          (r) => sendResponse(r),
          (e) => sendResponse({ error: String(e?.message || e) }),
        );
      return true;
    }
    case 'conversation':
      (async () => {
        const meta = engine.docs.get(msg.id)?.meta || (await db.get<ConvMeta>(db.STORES.meta, msg.id));
        const content = await engine.getContent(msg.id);
        sendResponse({ meta, content });
      })();
      return true;
    case 'stats':
      (async () => {
        if (engine.state === 'empty') await engine.load();
        const s = engine.stats();
        const usage = await db.estimateUsage();
        sendResponse({ ...s, vectors: semantic.status.done, vectorTarget: semantic.status.total, semantic: semantic.status, usage });
      })();
      return true;
    case 'semantic-status':
      sendResponse(semantic.status);
      return;
    case 'ping':
      sendResponse({ state: engine.state });
      return;
  }
});

// unload the heavy index when nobody has searched for a while; close entirely when fully idle
setInterval(() => {
  const idle = Date.now() - lastActivity;
  if (uiPorts > 0) return;
  if (idle > 8 * 60_000 && engine.state !== 'empty') {
    engine.unload();
    if (!semantic.isBusy()) semantic.unload();
  }
  if (idle > 10 * 60_000 && !semantic.isBusy()) {
    semantic.dropModel();
    broadcast({ type: 'offscreen-idle' });
  }
}, 30_000);

configureSemantic();

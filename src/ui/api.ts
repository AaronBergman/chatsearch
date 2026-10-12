import type { ConvContent, ConvMeta, SearchRequest, SearchResponse, Settings, Stats } from '../shared/types';

export const CID = Math.random().toString(36).slice(2);

let engineReady: Promise<void> | null = null;
let port: chrome.runtime.Port | null = null;

/** Make sure the offscreen engine exists, and hold a port so it knows a UI is open. */
export function ensureEngine(): Promise<void> {
  if (!engineReady) {
    engineReady = (async () => {
      await chrome.runtime.sendMessage({ type: 'ensure-engine' });
      connectPort();
    })().catch((e) => {
      engineReady = null;
      throw e;
    });
  }
  return engineReady;
}

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'ui' });
    port.onDisconnect.addListener(() => {
      port = null;
      engineReady = null;
    });
  } catch {
    port = null;
  }
}

async function toEngine<T>(msg: any, retry = true): Promise<T> {
  await ensureEngine();
  try {
    const r = await chrome.runtime.sendMessage({ to: 'offscreen', cid: CID, ...msg });
    if (r === undefined && retry) throw new Error('no engine');
    return r as T;
  } catch (e) {
    if (!retry) throw e;
    engineReady = null;
    await ensureEngine();
    return toEngine<T>(msg, false);
  }
}

export function search(req: SearchRequest): Promise<SearchResponse | null> {
  return toEngine<SearchResponse | null>({ type: 'search', req });
}

export function getConversation(id: string): Promise<{ meta?: ConvMeta; content?: ConvContent }> {
  return toEngine({ type: 'conversation', id });
}

export function getStats(): Promise<Stats & { semantic?: any; usage?: { usage: number; quota: number } }> {
  return toEngine({ type: 'stats' });
}

export function getSemanticStatus(): Promise<any> {
  return toEngine({ type: 'semantic-status' });
}

export function syncNow(source?: string) {
  return chrome.runtime.sendMessage({ type: 'sync-now', source });
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return chrome.runtime.sendMessage({ type: 'settings', patch });
}

export async function openChat(url: string, opts: { newTab?: boolean; terms?: string[]; snippet?: string; openIn: 'current' | 'new' }) {
  const intent = opts.terms?.length ? { url, terms: opts.terms, snippet: opts.snippet } : null;
  if (intent) await chrome.runtime.sendMessage({ type: 'set-highlight', intent });
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const reuse = !opts.newTab && opts.openIn === 'current' && active && (isChatTab(active.url) || isBlank(active.url));
  if (reuse && active?.id !== undefined) await chrome.tabs.update(active.id, { url, active: true });
  else await chrome.tabs.create({ url, active: !opts.newTab });
}

function isChatTab(url?: string) {
  return !!url && /^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com)\//.test(url);
}
function isBlank(url?: string) {
  // without the "tabs" permission an unknown page reports no url: treat it as not blank (never hijack it)
  return !!url && (url === 'chrome://newtab/' || url.startsWith('chrome://new-tab-page') || url === 'about:blank');
}

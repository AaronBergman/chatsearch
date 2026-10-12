import { DEFAULT_SETTINGS, type Settings, type SourceStatus, type Source } from './types';

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get('settings');
  const s = (r.settings || {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...s, sources: { ...DEFAULT_SETTINGS.sources, ...(s.sources || {}) } };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch, sources: { ...cur.sources, ...(patch.sources || {}) } };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getClientId(): Promise<string> {
  const r = await chrome.storage.local.get('clientId');
  if (r.clientId) return r.clientId as string;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ clientId: id });
  return id;
}

export type StatusMap = Partial<Record<Source, SourceStatus>>;

export async function getStatus(): Promise<StatusMap> {
  const r = await chrome.storage.local.get('status');
  return (r.status || {}) as StatusMap;
}

let statusCache: StatusMap | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

/** Merge a status update (debounced writes so UIs see changes ~4x/second at most). */
export async function setStatus(source: Source, patch: Partial<SourceStatus>) {
  if (!statusCache) statusCache = await getStatus();
  statusCache[source] = { ...(statusCache[source] || { source, state: 'idle' }), ...patch, source };
  if (!statusTimer) {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      chrome.storage.local.set({ status: statusCache });
    }, 250);
  }
}

export interface HistoryItem {
  q: string;
  t: number;
  n: number;
}

export async function getHistory(): Promise<HistoryItem[]> {
  const r = await chrome.storage.local.get('history');
  return (r.history || []) as HistoryItem[];
}

export async function addHistory(q: string) {
  q = q.trim();
  if (q.length < 2) return;
  const h = await getHistory();
  const i = h.findIndex((x) => x.q.toLowerCase() === q.toLowerCase());
  const item = i >= 0 ? { ...h[i], q, t: Date.now(), n: h[i].n + 1 } : { q, t: Date.now(), n: 1 };
  if (i >= 0) h.splice(i, 1);
  // drop prefixes of this query typed moments ago ("pla" -> "plane")
  const filtered = h.filter((x) => !(q.toLowerCase().startsWith(x.q.toLowerCase()) && Date.now() - x.t < 60_000));
  filtered.unshift(item);
  await chrome.storage.local.set({ history: filtered.slice(0, 50) });
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

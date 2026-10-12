import { getJSON, HttpError } from './net';

const BASE = 'https://chatgpt.com';

let token: { value: string; exp: number } | null = null;

function jwtExp(t: string): number {
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (p.exp || 0) * 1000;
  } catch {
    return Date.now() + 10 * 60_000;
  }
}

export async function chatgptToken(force = false): Promise<string | null> {
  if (!force && token && token.exp - Date.now() > 60_000) return token.value;
  if (!force) {
    const s = await chrome.storage.session.get('gptToken');
    const t = s.gptToken as typeof token;
    if (t && t.exp - Date.now() > 60_000) {
      token = t;
      return t.value;
    }
  }
  const j = await getJSON<any>(`${BASE}/api/auth/session`);
  if (!j?.accessToken) {
    token = null;
    return null;
  }
  token = { value: j.accessToken, exp: Math.min(jwtExp(j.accessToken), j.expires ? Date.parse(j.expires) : Infinity) };
  await chrome.storage.session.set({ gptToken: token });
  return token.value;
}

async function api<T = any>(path: string): Promise<T> {
  let t = await chatgptToken();
  if (!t) throw new HttpError(401, 'signed out of ChatGPT');
  const headers = { Authorization: `Bearer ${t}`, 'oai-language': 'en-US' };
  try {
    return await getJSON<T>(`${BASE}${path}`, { headers });
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      t = await chatgptToken(true);
      if (!t) throw e;
      return getJSON<T>(`${BASE}${path}`, { headers: { ...headers, Authorization: `Bearer ${t}` } });
    }
    throw e;
  }
}

export async function chatgptListPage(offset: number, limit: number, archived = false): Promise<{ items: any[]; hasMore: boolean }> {
  const j = await api<any>(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated${archived ? '&is_archived=true' : ''}`);
  const items = Array.isArray(j?.items) ? j.items : [];
  return { items, hasMore: items.length >= limit };
}

export interface GptProject {
  id: string;
  name: string;
}

export async function chatgptProjects(): Promise<GptProject[]> {
  const out: GptProject[] = [];
  let cursor = '';
  for (let guard = 0; guard < 50; guard++) {
    const j = await api<any>(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const it of j?.items || []) {
      const g = it?.gizmo?.gizmo || it?.gizmo;
      if (g?.id) out.push({ id: g.id, name: g.display?.name || g.name || 'Project' });
    }
    if (!j?.cursor || !(j.items || []).length) break;
    cursor = j.cursor;
  }
  return out;
}

export async function chatgptProjectConversations(gizmoId: string, cursor: string): Promise<{ items: any[]; cursor: string | null }> {
  const j = await api<any>(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${encodeURIComponent(cursor || '0')}`);
  return { items: Array.isArray(j?.items) ? j.items : [], cursor: j?.cursor || null };
}

export async function chatgptFetch(id: string): Promise<any> {
  return api(`/backend-api/conversation/${id}`);
}

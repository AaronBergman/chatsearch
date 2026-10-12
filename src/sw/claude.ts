import { getJSON, HttpError } from './net';

const BASE = 'https://claude.ai';

export interface ClaudeOrg {
  uuid: string;
  name: string;
}

export async function claudeOrgs(): Promise<ClaudeOrg[]> {
  const orgs = await getJSON<any[]>(`${BASE}/api/organizations`);
  if (!Array.isArray(orgs)) throw new HttpError(401, 'not signed in');
  return orgs.filter((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')).map((o) => ({ uuid: o.uuid, name: o.name || '' }));
}

let useV1 = false;

/** One page of conversations, most recently updated first. */
export async function claudeListPage(org: string, offset: number, limit: number): Promise<{ items: any[]; hasMore: boolean }> {
  if (!useV1) {
    try {
      const j = await getJSON<any>(`${BASE}/api/organizations/${org}/chat_conversations_v2?limit=${limit}&offset=${offset}&consistency=eventual`);
      if (j && Array.isArray(j.data)) return { items: j.data, hasMore: !!j.has_more };
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 400)) throw e;
    }
    useV1 = true;
  }
  const arr = await getJSON<any[]>(`${BASE}/api/organizations/${org}/chat_conversations?limit=${limit}&offset=${offset}`);
  return { items: Array.isArray(arr) ? arr : [], hasMore: Array.isArray(arr) && arr.length >= limit };
}

export async function claudeFetch(org: string, uuid: string): Promise<any> {
  return getJSON(`${BASE}/api/organizations/${org}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
    public body?: string,
    /** a bot-check / challenge page (Cloudflare) instead of the API: visiting the site in a tab clears it */
    public blocked = false,
  ) {
    super(message);
  }
  get rateLimited() {
    return this.status === 429;
  }
  get authFailed() {
    return !this.blocked && (this.status === 401 || this.status === 403);
  }
}

export async function getJSON<T = any>(url: string, init: RequestInit = {}, timeoutMs = 45_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'no-store', ...init, signal: ctl.signal });
  } catch (e: any) {
    throw new HttpError(0, e?.name === 'AbortError' ? 'timeout' : `network: ${e?.message || e}`);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    // Cloudflare challenge pages come back as HTML (usually 403): not a login problem and not a throttle
    const blocked = /^\s*</.test(text) || res.headers.get('cf-mitigated') === 'challenge';
    throw new HttpError(res.status, `${res.status} ${text.slice(0, 200)}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined, text.slice(0, 2000), blocked && res.status !== 429);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(res.status, `bad json from ${new URL(url).pathname}: ${text.slice(0, 120)}`, undefined, text.slice(0, 2000), /^\s*</.test(text));
  }
}

/** Keep the MV3 service worker alive during long syncs (any extension API call resets the idle timer). */
export function keepAlive(): () => void {
  const iv = setInterval(() => chrome.runtime.getPlatformInfo(() => void 0), 20_000);
  return () => clearInterval(iv);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

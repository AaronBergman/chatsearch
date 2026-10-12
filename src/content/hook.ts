/**
 * MAIN-world script on claude.ai / chatgpt.com. Observes (never modifies) the page's own fetches so
 * conversations you open or chat in get indexed without any extra requests to the site.
 */
(() => {
  const w = window as any;
  if (w.__chatsearchHooked) return;
  w.__chatsearchHooked = true;
  const TAG = '__chatsearch__';
  const host = location.hostname;
  const isClaude = host === 'claude.ai' || host.endsWith('.claude.ai');
  const origFetch = window.fetch;

  const post = (payload: any) => {
    try {
      window.postMessage({ [TAG]: 1, ...payload }, location.origin);
    } catch {}
  };

  const drain = (res: Response) => {
    const body = res.clone().body;
    if (!body) return Promise.resolve();
    const r = body.getReader();
    return (async () => {
      try {
        for (;;) if ((await r.read()).done) break;
      } catch {}
    })();
  };

  const json = (res: Response, cb: (j: any) => void) => {
    if (!res.ok) return;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return;
    res
      .clone()
      .json()
      .then(cb)
      .catch(() => void 0);
  };

  const bodyJSON = (init?: RequestInit): any => {
    try {
      return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      return null;
    }
  };

  function inspect(input: RequestInfo | URL, init: RequestInit | undefined, res: Response) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return;
    const p = u.pathname;
    if (isClaude) {
      let m = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([0-9a-f-]{36})$/.exec(p);
      if (m) {
        const [, org, id] = m;
        if (method === 'GET' && u.searchParams.get('tree')) json(res, (data) => post({ type: 'cap', source: 'claude', org, data }));
        else if (method === 'DELETE' && res.ok) post({ type: 'deleted', source: 'claude', id });
        else if ((method === 'PUT' || method === 'PATCH') && res.ok) post({ type: 'touched', source: 'claude', id, org });
        return;
      }
      m = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([0-9a-f-]{36})\/(completion|retry_completion|title)$/.exec(p);
      if (m && method === 'POST') {
        const [, org, id] = m;
        drain(res).then(() => post({ type: 'touched', source: 'claude', id, org }));
      }
      return;
    }
    // ChatGPT
    let m = /^\/backend-api\/conversation\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      const id = m[1];
      if (method === 'GET') json(res, (data) => data?.mapping && post({ type: 'cap', source: 'chatgpt', data: { ...data, conversation_id: data.conversation_id || id } }));
      else if (method === 'PATCH' && res.ok) {
        const b = bodyJSON(init);
        if (b?.is_visible === false) post({ type: 'deleted', source: 'chatgpt', id });
        else if (typeof b?.title === 'string') post({ type: 'renamed', source: 'chatgpt', id, title: b.title });
      }
      return;
    }
    m = /^\/backend-api\/conversations\/([0-9a-f-]{36})$/.exec(p);
    if (m && method === 'GET') {
      const id = m[1];
      json(res, (data) => post({ type: 'cap-page-raw', source: 'chatgpt', id, data }));
      return;
    }
    if (/^\/backend-api\/(f\/)?conversation$/.test(p) && method === 'POST') {
      drain(res).then(() => post({ type: 'stream-done', source: 'chatgpt' }));
    }
  }

  const patched = function (this: any, input: RequestInfo | URL, init?: RequestInit) {
    const p = origFetch.call(this, input as any, init);
    p.then(
      (res) => {
        try {
          inspect(input, init, res);
        } catch {}
      },
      () => void 0,
    );
    return p;
  };
  try {
    Object.defineProperty(patched, 'name', { value: 'fetch' });
  } catch {}
  window.fetch = patched as typeof fetch;

  // SPA navigations
  for (const k of ['pushState', 'replaceState'] as const) {
    const orig = history[k];
    history[k] = function (this: History, ...args: any[]) {
      const r = orig.apply(this, args as any);
      post({ type: 'nav' });
      return r;
    } as any;
  }
  window.addEventListener('popstate', () => post({ type: 'nav' }));
})();

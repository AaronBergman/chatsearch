import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addHistory, clearHistory, getHistory, getSettings, getStatus, type HistoryItem, type StatusMap } from '../shared/settings';
import { DEFAULT_SETTINGS, type SearchHit, type SearchRequest, type SearchResponse, type Settings, type Source } from '../shared/types';
import { ensureEngine, getSemanticStatus, openChat, search } from './api';
import { IconClock, IconExpand, IconPanel, IconPreview, IconSearch, IconSliders, IconSparkles, IconUser, IconX, LogoChatGPT, LogoClaude } from './icons';
import { Preview, ResultItem } from './results';
import { ImportView, SettingsView, statusLine, Welcome } from './settings';
import { ago, fmtNum, MOD } from './util';

type Mode = 'popup' | 'panel' | 'tab';
type View = 'search' | 'settings' | 'import' | 'welcome';
type TimeF = 'any' | 'week' | 'month' | 'year';

const MODE = (document.body.dataset.mode || 'tab') as Mode;
const DAY = 86400000;
const PAGE = 40;

interface UIState {
  q: string;
  src: 'all' | Source;
  mine: boolean;
  time: TimeF;
  sort: 'best' | 'newest' | 'oldest';
  sem: boolean;
  selId?: string;
  at: number;
}

function initialView(): View {
  const h = location.hash.slice(1);
  if (MODE === 'tab' && (h === 'settings' || h === 'import' || h === 'welcome')) return h;
  return 'search';
}

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>(initialView());
  const [q, setQ] = useState('');
  const [src, setSrc] = useState<'all' | Source>('all');
  const [mine, setMine] = useState(false);
  const [time, setTime] = useState<TimeF>('any');
  const [sort, setSort] = useState<'best' | 'newest' | 'oldest'>('best');
  const [sem, setSem] = useState(false);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusMap>({});
  const [semStatus, setSemStatus] = useState<any>(null);
  const [history, setHistoryState] = useState<HistoryItem[]>([]);
  const [wide, setWide] = useState(window.innerWidth >= 640);
  const [showPreview, setShowPreview] = useState(true);
  const [narrowPreview, setNarrowPreview] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const qid = useRef(0);
  const restored = useRef(false);
  const [booted, setBooted] = useState(false);
  const typed = useRef(false); // the user started typing before saved state loaded: keep their input
  const selIdRef = useRef<string | undefined>(undefined);
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSemTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSemFor = useRef('');

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setShowPreview((localStorage.getItem('cs.preview') ?? '1') === '1');
    });
    getStatus().then(setStatus);
    getHistory().then(setHistoryState);
    ensureEngine()
      .then(() => getSemanticStatus().then(setSemStatus))
      .catch((e) => setEngineErr(String(e?.message || e)));
    const onStore = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.status) setStatus((changes.status.newValue as StatusMap) || {});
      if (changes.settings) setSettings({ ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Settings) });
      if (changes.history) setHistoryState((changes.history.newValue as HistoryItem[]) || []);
    };
    chrome.storage.onChanged.addListener(onStore);
    const mq = () => setWide(window.innerWidth >= 640);
    window.addEventListener('resize', mq);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onHash = () => setView(initialView());
    window.addEventListener('hashchange', onHash);
    return () => {
      chrome.storage.onChanged.removeListener(onStore);
      window.removeEventListener('resize', mq);
      window.removeEventListener('hashchange', onHash);
      clearInterval(tick);
    };
  }, []);

  // theme
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // restore last state (makes the dropdown feel persistent) or read ?q=
  useEffect(() => {
    (async () => {
      const urlQ = new URLSearchParams(location.search).get('q');
      if (urlQ) {
        if (!typed.current) setQ(urlQ);
      } else if (MODE !== 'tab') {
        const r = await chrome.storage.session.get('ui');
        const st = r.ui as UIState | undefined;
        if (st && Date.now() - st.at < 30 * 60_000 && !typed.current) {
          setQ(st.q);
          setSrc(st.src);
          setMine(st.mine);
          setTime(st.time);
          setSort(st.sort);
          setSem(st.sem && !!st.q);
          selIdRef.current = st.selId;
        }
      }
      restored.current = true;
      setBooted(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        if (!typed.current) inputRef.current?.select();
      });
    })();
  }, []);

  const hits = res?.hits || [];
  const selected: SearchHit | undefined = hits[sel];

  // persist UI state
  useEffect(() => {
    if (!restored.current || MODE === 'tab') return;
    const st: UIState = { q, src, mine, time, sort, sem, selId: selected?.id, at: Date.now() };
    chrome.storage.session.set({ ui: st });
  }, [q, src, mine, time, sort, sem, selected?.id]);

  // ---------------------------------------------------------------- searching
  const buildReq = useCallback(
    (offset = 0, semantic = sem): SearchRequest => {
      const since = time === 'week' ? Date.now() - 7 * DAY : time === 'month' ? Date.now() - 30 * DAY : time === 'year' ? Date.now() - 365 * DAY : undefined;
      return { q, filters: { sources: src === 'all' ? undefined : [src], mine, since }, sort, limit: PAGE, offset, semantic: semantic && !!q.trim(), qid: ++qid.current };
    },
    [q, src, mine, time, sort, sem],
  );

  const run = useCallback(
    async (opts: { keepSel?: boolean; semantic?: boolean } = {}) => {
      const req = buildReq(0, opts.semantic ?? sem);
      const myQid = req.qid;
      setLoading(true);
      try {
        const r = await search(req);
        if (!r || myQid !== qid.current) return;
        if ((r as any).error) throw new Error((r as any).error);
        setEngineErr(null);
        setRes(r);
        const keepId = opts.keepSel ? selIdRef.current : undefined;
        const idx = keepId ? r.hits.findIndex((h) => h.id === keepId) : -1;
        setSel(idx >= 0 ? idx : 0);
        if (!opts.keepSel && listRef.current) listRef.current.scrollTop = 0;
      } catch (e: any) {
        setEngineErr(String(e?.message || e));
      } finally {
        if (myQid === qid.current) setLoading(false);
      }
    },
    [buildReq, sem],
  );

  useEffect(() => {
    if (!booted) return;
    run({ keepSel: !!selIdRef.current });
    selIdRef.current = undefined;
  }, [booted, q, src, mine, time, sort, sem]);

  // live updates from sync / engine
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onMsg = (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'semantic-status') setSemStatus(msg.status);
      if (msg.type === 'engine-updated' || msg.type === 'engine-state' || msg.type === 'docs-changed') {
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          selIdRef.current = hits[sel]?.id;
          run({ keepSel: true });
        }, msg.type === 'engine-state' ? 0 : 700);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      if (t) clearTimeout(t);
    };
  }, [run, hits, sel]);

  // remember searches the user dwelt on
  useEffect(() => {
    if (histTimer.current) clearTimeout(histTimer.current);
    if (!settings.history || q.trim().length < 3) return;
    histTimer.current = setTimeout(() => {
      if (res && res.total > 0) addHistory(q);
    }, 2500);
  }, [q, res?.total]);

  // zero exact results: try meaning automatically (once per query, after a pause)
  useEffect(() => {
    if (autoSemTimer.current) clearTimeout(autoSemTimer.current);
    if (sem || !res || res.q !== q || res.total > 0 || q.trim().length < 4 || settings.semantic === 'off' || autoSemFor.current === q) return;
    autoSemTimer.current = setTimeout(() => {
      autoSemFor.current = q;
      setSem(true);
    }, 650);
  }, [res, q, sem, settings.semantic]);

  const loadMore = async () => {
    if (!res || loading || res.hits.length >= res.total) return;
    const req = buildReq(res.hits.filter((h) => h.kind !== 'title').length);
    const myQid = req.qid;
    const r = await search(req);
    if (!r || myQid !== qid.current) return;
    setRes({ ...res, hits: [...res.hits, ...r.hits.filter((h) => !res.hits.some((x) => x.id === h.id))] });
  };

  const open = async (hit: SearchHit | undefined, newTab: boolean) => {
    if (!hit) return;
    if (settings.history && q.trim().length >= 2) addHistory(q);
    const snip = hit.snippets[0];
    await openChat(hit.url, { newTab, terms: res?.terms || [], snippet: snip?.text, openIn: settings.openIn });
    if (MODE === 'popup' && !newTab) window.close();
  };

  const semantic = () => {
    if (!q.trim()) return;
    if (settings.semantic === 'off') {
      setView('settings');
      return;
    }
    if (sem) run({ semantic: true });
    else setSem(true);
  };

  // ---------------------------------------------------------------- keyboard
  const onKey = (e: KeyboardEvent) => {
    if (view !== 'search') {
      if (e.key === 'Escape' && view === 'settings') {
        e.preventDefault();
        setView('search');
      }
      return;
    }
    const n = hits.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(n - 1, s + 1));
      if (sel > n - 8) loadMore();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) semantic();
      else open(selected, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (narrowPreview) setNarrowPreview(false);
      else if (q) {
        setQ('');
        setSem(false);
      } else if (MODE === 'popup') window.close();
    } else if (e.key === 'ArrowRight' && !wide && selected && (e.target as HTMLInputElement).selectionStart === q.length) {
      setNarrowPreview(true);
    } else if (e.key === 'ArrowLeft' && narrowPreview) {
      setNarrowPreview(false);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t === inputRef.current) return;
      if (view === 'search' && (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) && !(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'Escape') onKey(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // ---------------------------------------------------------------- derived UI bits
  const totalChats = (status.claude?.total || 0) + (status.chatgpt?.total || 0);
  const syncing = (['claude', 'chatgpt'] as Source[]).filter((s) => status[s] && (status[s]!.state === 'listing' || status[s]!.state === 'fetching'));
  const footerStatus = useMemo(() => {
    if (syncing.length) return syncing.map((s) => `${s === 'claude' ? 'Claude' : 'ChatGPT'} ${fmtNum(status[s]!.fetched || 0)}/${fmtNum(status[s]!.total || 0)}`).join(' · ');
    const last = Math.max(status.claude?.lastSync || 0, status.chatgpt?.lastSync || 0);
    return `${fmtNum(totalChats)} chats${last ? ` · synced ${ago(last, now)}${ago(last, now) === 'just now' ? '' : ' ago'}` : ''}`;
  }, [status, now]);
  const signedOut = (['claude', 'chatgpt'] as Source[]).filter((s) => settings.sources[s] && status[s]?.state === 'signed-out');
  const semPct = semStatus && semStatus.total ? Math.floor((semStatus.done / semStatus.total) * 100) : null;
  const placeholder = totalChats ? `Search ${fmtNum(totalChats)} chats…` : 'Search your Claude and ChatGPT chats…';
  const showPv = wide && showPreview && view === 'search' && !!selected;

  if (view === 'welcome') return <Welcome status={status} onStart={() => (location.hash = '')} />;

  return (
    <div class={`app mode-${MODE}${wide ? ' wide' : ' narrow'}`} onKeyDown={onKey as any}>
      {view === 'settings' ? (
        <SettingsView settings={settings} setSettings={setSettings} status={status} semantic={semStatus} onBack={() => (MODE === 'tab' && location.hash ? (location.hash = '') : setView('search'))} mode={MODE} />
      ) : view === 'import' ? (
        <div class="page-wrap">
          <ImportView settings={settings} onDone={() => (location.hash = '')} />
        </div>
      ) : (
        <>
          <header class="top">
            <div class={`searchbox${loading ? ' busy' : ''}`}>
              <IconSearch size={17} class="sb-icon" />
              <input
                ref={inputRef}
                autoFocus
                value={q}
                placeholder={placeholder}
                spellcheck={false}
                autocomplete="off"
                onInput={(e) => {
                  typed.current = true;
                  setQ((e.target as HTMLInputElement).value);
                  if (sem) setSem(false);
                  setNarrowPreview(false);
                }}
              />
              {q ? (
                <button class="icon-btn sm clear" title="Clear (Esc)" onClick={() => (setQ(''), setSem(false), inputRef.current?.focus())}>
                  <IconX size={14} />
                </button>
              ) : null}
              <button class={`sem-btn${sem ? ' on' : ''}`} title={`Search by meaning (Shift+Enter)${settings.semantic === 'off' ? ' - turn on in settings' : ''}`} onClick={semantic} disabled={!q.trim()}>
                <IconSparkles size={15} />
                {wide ? <span>Meaning</span> : null}
              </button>
            </div>
            <div class="top-actions">
              {MODE === 'popup' ? (
                <button
                  class="icon-btn"
                  title="Dock in side panel (stays open while you browse)"
                  onClick={async () => {
                    const w = await chrome.windows.getCurrent();
                    await chrome.sidePanel.open({ windowId: w.id! });
                    window.close();
                  }}
                >
                  <IconPanel size={16} />
                </button>
              ) : null}
              {MODE !== 'tab' ? (
                <button class="icon-btn" title="Open in a full tab" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${q ? `?q=${encodeURIComponent(q)}` : ''}`) })}>
                  <IconExpand size={15} />
                </button>
              ) : null}
              <button class="icon-btn" title="Settings" onClick={() => setView('settings')}>
                <IconSliders size={16} />
              </button>
            </div>
          </header>
          <div class="filters">
            <div class="seg small">
              <button class={src === 'all' ? 'on' : ''} onClick={() => setSrc('all')}>
                All
              </button>
              <button class={src === 'claude' ? 'on' : ''} onClick={() => setSrc(src === 'claude' ? 'all' : 'claude')} title="Only Claude">
                <LogoClaude size={13} /> Claude
              </button>
              <button class={src === 'chatgpt' ? 'on' : ''} onClick={() => setSrc(src === 'chatgpt' ? 'all' : 'chatgpt')} title="Only ChatGPT">
                <LogoChatGPT size={13} /> ChatGPT
              </button>
            </div>
            <button class={`chip${mine ? ' on' : ''}`} onClick={() => setMine(!mine)} title="Only match words you wrote">
              <IconUser size={13} /> Mine
            </button>
            <label class={`chip select${time !== 'any' ? ' on' : ''}`}>
              <IconClock size={13} />
              <select value={time} onChange={(e) => setTime((e.target as HTMLSelectElement).value as TimeF)}>
                <option value="any">Any time</option>
                <option value="week">Past week</option>
                <option value="month">Past month</option>
                <option value="year">Past year</option>
              </select>
            </label>
            <div class="grow" />
            {res && q ? (
              <span class="count">
                {sem ? 'by meaning' : `${fmtNum(res.total)} ${res.total === 1 ? 'chat' : 'chats'}`}
                {!sem && res.ms < 1000 ? <span class="ms"> · {Math.max(1, Math.round(res.ms))} ms</span> : null}
              </span>
            ) : null}
            <label class="chip select plain">
              <select value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as any)} title="Sort">
                <option value="best">Best match</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </label>
            {wide ? (
              <button class={`icon-btn sm${showPreview ? ' on' : ''}`} title="Toggle preview" onClick={() => (setShowPreview(!showPreview), localStorage.setItem('cs.preview', showPreview ? '0' : '1'))}>
                <IconPreview size={15} />
              </button>
            ) : null}
          </div>
          {signedOut.length && !q ? (
            <div class="banner">
              {signedOut.map((s) => (
                <a href={s === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com'} target="_blank">
                  Sign in to {s === 'claude' ? 'claude.ai' : 'chatgpt.com'} to index those chats
                </a>
              ))}
            </div>
          ) : null}
          <main class={`body${showPv ? ' split' : ''}`}>
            <div
              class="list"
              ref={listRef}
              role="listbox"
              onScroll={(e) => {
                const el = e.currentTarget as HTMLDivElement;
                if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) loadMore();
              }}
            >
              {res?.corrected ? (
                <div class="note">
                  Showing results for <b>{res.corrected}</b>.{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), setQ(`"${q.replace(/"/g, '')}"`))}>
                    Search for “{q}” instead
                  </a>
                </div>
              ) : null}
              {res?.suggestion && !res.corrected ? (
                <div class="note">
                  Did you mean{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), setQ(res.suggestion!))}>
                    {res.suggestion}
                  </a>
                  ?
                </div>
              ) : null}
              {sem && res?.semantic ? (
                <div class="note sem">
                  <IconSparkles size={13} /> Related by meaning
                  {res.semantic.state === 'indexing' && res.semantic.coverage !== undefined ? <span class="muted"> · {Math.floor(res.semantic.coverage * 100)}% of passages embedded so far</span> : null}
                  {res.semantic.state === 'error' ? <span class="err"> · {res.semantic.message}</span> : null}
                  {res.semantic.state === 'off' ? <span class="muted"> · {res.semantic.message}</span> : null}
                  <button class="link-btn" onClick={() => setSem(false)}>
                    back to exact
                  </button>
                </div>
              ) : null}
              {!q && history.length && settings.history ? (
                <div class="history">
                  <span class="h-label">Recent</span>
                  {history.slice(0, 8).map((h) => (
                    <button class="hchip" onClick={() => setQ(h.q)} title={`Searched ${ago(h.t, now)} ago`}>
                      {h.q}
                    </button>
                  ))}
                  <button class="link-btn" onClick={() => clearHistory()}>
                    clear
                  </button>
                </div>
              ) : null}
              {!q && hits.length ? <div class="section-label">Recent chats</div> : null}
              {hits.map((h, i) => (
                <ResultItem key={h.id} hit={h} selected={i === sel} now={now} wide={wide && showPreview} onSelect={() => setSel(i)} onOpen={(e) => open(h, e.metaKey || e.ctrlKey || (e as any).button === 1)} />
              ))}
              {res && res.hits.length < res.total && !sem ? (
                <button class="more" onClick={loadMore}>
                  Load more ({fmtNum(res.total - res.hits.length)} more)
                </button>
              ) : null}
              {res && q && !hits.length && !loading ? (
                <div class="empty">
                  {sem ? (
                    <>
                      <div class="empty-title">Nothing related found yet</div>
                      <div class="muted">{semStatus && semStatus.total && semStatus.done < semStatus.total ? `Still embedding your chats (${semPct}%). Try again in a bit.` : 'Try different words.'}</div>
                    </>
                  ) : (
                    <>
                      <div class="empty-title">No chats contain “{q}”</div>
                      {settings.semantic !== 'off' ? (
                        <button class="btn primary sm" onClick={semantic}>
                          <IconSparkles size={14} /> Search by meaning
                        </button>
                      ) : null}
                      <div class="tips-small">
                        Tips: <code>"exact phrase"</code> <code>-exclude</code> <code>from:me</code> <code>in:title</code> <code>after:2026-01</code> <code>claude:</code>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {!res && !engineErr ? <div class="empty muted">Loading your index…</div> : null}
              {engineErr ? <div class="empty err">Search engine problem: {engineErr}</div> : null}
              {res && !q && !hits.length ? (
                <div class="empty">
                  <div class="empty-title">{syncing.length ? 'Indexing your chats…' : 'No chats indexed yet'}</div>
                  <div class="muted">{syncing.length ? footerStatus : 'Sign in to claude.ai or chatgpt.com in this browser; ChatSearch picks up your login automatically.'}</div>
                </div>
              ) : null}
            </div>
            {showPv && selected ? <Preview key={selected.id} hit={selected} terms={res?.terms || []} onOpen={(nt) => open(selected, nt)} settingsThinking={settings.includeThinking} /> : null}
            {!wide && narrowPreview && selected ? (
              <div class="overlay">
                <Preview key={selected.id} hit={selected} terms={res?.terms || []} onOpen={(nt) => open(selected, nt)} onBack={() => setNarrowPreview(false)} settingsThinking={settings.includeThinking} />
              </div>
            ) : null}
          </main>
          <footer class="foot">
            <button class={`status${syncing.length ? ' active' : ''}`} onClick={() => setView('settings')} title={(['claude', 'chatgpt'] as Source[]).map((s) => `${s === 'claude' ? 'Claude' : 'ChatGPT'}: ${statusLine(status[s], now)}`).join('\n')}>
              <span class="dot" />
              {footerStatus}
              {semStatus && settings.semantic !== 'off' && semPct !== null && semPct < 100 ? <span class="sem-pct"> · ✨ {semPct}%</span> : null}
            </button>
            {wide ? (
              <div class="keys">
                <kbd>↑</kbd>
                <kbd>↓</kbd> select <kbd>↵</kbd> open <kbd>{MOD}↵</kbd> new tab <kbd>⇧↵</kbd> meaning
              </div>
            ) : null}
          </footer>
        </>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);

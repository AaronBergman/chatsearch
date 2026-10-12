import { useEffect, useRef, useState } from 'preact/hooks';
import type { StatusMap } from '../shared/settings';
import type { Settings, Source, SourceStatus } from '../shared/types';
import { getStats, syncNow, updateSettings } from './api';
import { IconBack, IconDownload, IconExternal, IconRefresh, IconTrash, IconUpload } from './icons';
import { SourceLogo } from './results';
import { ago, download, fmtBytes, fmtNum, MOD } from './util';

export const VERSION = chrome.runtime.getManifest().version;
export const REPO = 'https://github.com/AaronBergman/chatsearch';

const SITE: Record<Source, { name: string; url: string; exportHelp: string }> = {
  claude: { name: 'Claude', url: 'https://claude.ai', exportHelp: 'claude.ai → Settings → Privacy → Export data' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com', exportHelp: 'chatgpt.com → Settings → Data controls → Export data' },
};

export function statusLine(s: SourceStatus | undefined, now = Date.now()): string {
  if (!s) return 'Waiting for first sync…';
  const counts = s.total ? `${fmtNum(s.fetched || 0)} / ${fmtNum(s.total)} chats` : '';
  switch (s.state) {
    case 'disabled':
      return 'Turned off';
    case 'signed-out':
      return s.message || 'Signed out';
    case 'paused':
      return `Paused${s.pausedUntil ? ` until ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}${counts ? ` · ${counts}` : ''}`;
    case 'listing':
      return `Listing chats… ${s.total ? fmtNum(s.total) : ''}`;
    case 'fetching':
      return `Downloading ${counts}`;
    case 'error':
      return `Error: ${s.message || 'unknown'}`;
    default:
      return `${counts || 'Up to date'}${s.lastSync ? ` · synced ${ago(s.lastSync, now)}${ago(s.lastSync, now) === 'just now' ? '' : ' ago'}` : ''}`;
  }
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label class="row toggle-row">
      <div>
        <div class="row-label">{label}</div>
        {hint ? <div class="row-hint">{hint}</div> : null}
      </div>
      <button role="switch" aria-checked={on} class={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
        <span />
      </button>
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg">
      {options.map(([v, l]) => (
        <button class={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function SettingsView({ settings, setSettings, status, semantic, onBack, mode }: { settings: Settings; setSettings: (s: Settings) => void; status: StatusMap; semantic: any; onBack: () => void; mode: string }) {
  const [stats, setStats] = useState<any>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  useEffect(() => {
    getStats().then(setStats).catch(() => void 0);
  }, []);
  const patch = async (p: Partial<Settings>) => setSettings(await updateSettings(p));
  const now = Date.now();
  const doExport = () => {
    setExporting('Preparing…');
    const w = new Worker(chrome.runtime.getURL('data-worker.js'), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') setExporting(`Packing ${fmtNum(m.count)} chats…`);
      if (m.type === 'done') {
        download(`chatsearch-export-${new Date().toISOString().slice(0, 10)}.zip`, m.blob);
        setExporting(`Exported ${fmtNum(m.count)} chats`);
        w.terminate();
      }
      if (m.type === 'error') {
        setExporting(`Export failed: ${m.error}`);
        w.terminate();
      }
    };
    w.postMessage({ type: 'export' });
  };

  return (
    <div class="settings">
      <div class="set-head">
        <button class="icon-btn" onClick={onBack} title="Back (Esc)">
          <IconBack />
        </button>
        <div class="set-title">Settings</div>
      </div>
      <div class="set-body">
        <section>
          <h3>Sources</h3>
          {(['claude', 'chatgpt'] as Source[]).map((src) => {
            const st = status[src];
            const pct = st?.total ? Math.round(((st.fetched || 0) / st.total) * 100) : 0;
            return (
              <div class="source-card">
                <div class="source-top">
                  <SourceLogo source={src} size={18} />
                  <div class="source-name">{SITE[src].name}</div>
                  <div class={`pill state-${st?.state || 'idle'}`}>{st?.state === 'idle' ? 'synced' : st?.state || 'waiting'}</div>
                  <div class="grow" />
                  <button class="icon-btn" title="Sync now" onClick={() => syncNow(src)}>
                    <IconRefresh size={15} />
                  </button>
                  <button role="switch" aria-checked={settings.sources[src]} class={`switch${settings.sources[src] ? ' on' : ''}`} onClick={() => patch({ sources: { ...settings.sources, [src]: !settings.sources[src] } })}>
                    <span />
                  </button>
                </div>
                <div class="source-line">{statusLine(st, now)}</div>
                {st?.total ? (
                  <div class="bar">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                ) : null}
                {st?.state === 'signed-out' ? (
                  <a class="link" href={SITE[src].url} target="_blank">
                    Open {SITE[src].name} to sign in <IconExternal size={12} />
                  </a>
                ) : null}
                {st?.message && st.state !== 'signed-out' && st.state !== 'error' ? <div class="row-hint">{st.message}</div> : null}
              </div>
            );
          })}
          <div class="row-hint">
            Have thousands of chats? Import your official data export for an instant full index.{' '}
            <a class="link" href={chrome.runtime.getURL('app.html#import')} target="_blank">
              Import an export
            </a>
          </div>
        </section>

        <section>
          <h3>Semantic search</h3>
          <Seg
            value={settings.semantic}
            options={[
              ['local', 'On this device'],
              ['cloud', 'Cloud (best quality)'],
              ['off', 'Off'],
            ]}
            onChange={(v) => patch({ semantic: v })}
          />
          <div class="row-hint">
            {settings.semantic === 'local'
              ? 'Private: a small embedding model (MongoDB leaf-ir, 23 to 46 MB, downloaded once from Hugging Face) runs in your browser, on the GPU when available. Your chats never leave this computer.'
              : settings.semantic === 'cloud'
                ? 'Higher quality and much faster for big histories, but chunks of your chats leave this browser: they go through the ChatSearch relay to DeepInfra (Qwen3-Embedding-8B). The relay keeps nothing except token counts, and the vectors are stored only here. Free, with a shared monthly cap.'
                : 'Only exact and fuzzy keyword search.'}
          </div>
          {settings.semantic !== 'off' && semantic ? (
            <div class="sem-status">
              <div class="row-hint">
                {semantic.state === 'loading-model'
                  ? 'Loading the embedding model…'
                  : semantic.state === 'error'
                    ? `Problem: ${semantic.message}`
                    : semantic.total
                      ? `${fmtNum(semantic.done)} / ${fmtNum(semantic.total)} passages embedded${semantic.device ? ` · ${semantic.device}` : ''}${semantic.rate && semantic.state === 'indexing' ? ` · ${Math.round(semantic.rate)}/s` : ''}`
                      : 'Waiting for chats…'}
              </div>
              {semantic.total ? (
                <div class="bar">
                  <div style={{ width: `${Math.round((semantic.done / Math.max(1, semantic.total)) * 100)}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section>
          <h3>Search</h3>
          <Toggle on={settings.includeAttachments} onChange={(v) => patch({ includeAttachments: v })} label="Search pasted documents and attachments" hint="Text you pasted or uploaded into a chat." />
          <Toggle on={settings.includeThinking} onChange={(v) => patch({ includeThinking: v })} label="Search the model's thinking" hint="Extended-thinking / reasoning text. Off keeps results focused on what was actually said." />
          <Toggle on={settings.history} onChange={(v) => patch({ history: v })} label="Remember recent searches" />
        </section>

        <section>
          <h3>Behavior</h3>
          <div class="row">
            <div class="row-label">Open results in</div>
            <Seg
              value={settings.openIn}
              options={[
                ['current', 'Current tab'],
                ['new', 'New tab'],
              ]}
              onChange={(v) => patch({ openIn: v })}
            />
          </div>
          <div class="row">
            <div>
              <div class="row-label">Toolbar icon opens</div>
              <div class="row-hint">The side panel stays open while you click around.</div>
            </div>
            <Seg
              value={settings.iconOpens}
              options={[
                ['popup', 'Dropdown'],
                ['sidepanel', 'Side panel'],
              ]}
              onChange={(v) => patch({ iconOpens: v })}
            />
          </div>
          <div class="row">
            <div class="row-label">Theme</div>
            <Seg
              value={settings.theme}
              options={[
                ['system', 'Auto'],
                ['light', 'Light'],
                ['dark', 'Dark'],
              ]}
              onChange={(v) => patch({ theme: v })}
            />
          </div>
          <div class="row">
            <div>
              <div class="row-label">Keyboard shortcut</div>
              <div class="row-hint">
                Default {MOD}+Shift+K. In the address bar, type <kbd>cs</kbd> then space to search from anywhere.
              </div>
            </div>
            <button class="btn sm" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
              Change
            </button>
          </div>
        </section>

        <section>
          <h3>Your data</h3>
          <div class="row-hint">
            Everything is stored locally in this browser profile
            {stats?.usage?.usage ? ` (${fmtBytes(stats.usage.usage)})` : ''}
            {stats ? ` · ${fmtNum(stats.convs)} chats, ${fmtNum(stats.messages)} messages` : ''}.
          </div>
          <div class="btn-row">
            <button class="btn sm" onClick={doExport} disabled={!!exporting && exporting.startsWith('P')}>
              <IconDownload size={14} /> Export all as Markdown
            </button>
            {mode !== 'tab' ? (
              <button class="btn sm" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('app.html#import') })}>
                <IconUpload size={14} /> Import an export
              </button>
            ) : (
              <a class="btn sm" href="#import">
                <IconUpload size={14} /> Import an export
              </a>
            )}
            {confirmWipe ? (
              <button
                class="btn sm danger"
                onClick={async () => {
                  await chrome.runtime.sendMessage({ type: 'wipe' });
                  setConfirmWipe(false);
                  location.reload();
                }}
              >
                Really delete everything?
              </button>
            ) : (
              <button class="btn sm ghost" onClick={() => setConfirmWipe(true)}>
                <IconTrash size={14} /> Delete local data
              </button>
            )}
          </div>
          {exporting ? <div class="row-hint">{exporting}</div> : null}
        </section>

        <section class="about">
          ChatSearch {VERSION} ·{' '}
          <a class="link" href={REPO} target="_blank">
            GitHub
          </a>{' '}
          ·{' '}
          <a class="link" href="https://abergman.com/chatsearch" target="_blank">
            abergman.com/chatsearch
          </a>
          <div class="row-hint">Not affiliated with Anthropic or OpenAI. Uses your existing browser login; no account, no tracking.</div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- import (full-page app)

export function ImportView({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const [state, setState] = useState<{ phase: 'idle' | 'running' | 'done' | 'error'; msg?: string; frac?: number; count?: number }>({ phase: 'idle' });
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = (file: File) => {
    setState({ phase: 'running', msg: `Reading ${file.name}…`, frac: 0 });
    const w = new Worker(chrome.runtime.getURL('data-worker.js'), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') setState({ phase: 'running', msg: `Imported ${fmtNum(m.count)} chats${m.failed ? ` (${m.failed} unreadable)` : ''}…`, frac: m.frac, count: m.count });
      else if (m.type === 'done') {
        setState({ phase: 'done', msg: `Imported ${fmtNum(m.count)} chats${m.skipped ? ` (${fmtNum(m.skipped)} skipped: empty or already newer)` : ''}.`, frac: 1, count: m.count });
        chrome.runtime.sendMessage({ type: 'imported', ids: [], reload: true });
        w.terminate();
      } else if (m.type === 'error') {
        setState({ phase: 'error', msg: m.error });
        w.terminate();
      }
    };
    w.postMessage({ type: 'import', file, opts: { includeThinking: settings.includeThinking, includeAttachments: settings.includeAttachments } });
  };

  return (
    <div class="import">
      <h2>Import a data export</h2>
      <p class="muted">
        The fastest way to index a big history, especially ChatGPT, which only lets apps download about one chat per minute. Your file is read locally and never uploaded.
      </p>
      <ol class="steps">
        <li>
          <b>ChatGPT:</b> {SITE.chatgpt.exportHelp}. You'll get an email with a zip link (usually within minutes).
        </li>
        <li>
          <b>Claude:</b> {SITE.claude.exportHelp}.
        </li>
        <li>Drop the downloaded .zip (or its conversations.json) below. Chats newer than the export keep syncing automatically.</li>
      </ol>
      <div
        class={`drop${drag ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer?.files?.[0];
          if (f) run(f);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <IconUpload size={22} />
        <div>{state.phase === 'running' ? state.msg : 'Drop your export here, or click to choose a file'}</div>
        <input ref={inputRef} type="file" accept=".zip,.json,application/zip,application/json" style={{ display: 'none' }} onChange={(e) => (e.target as HTMLInputElement).files?.[0] && run((e.target as HTMLInputElement).files![0])} />
      </div>
      {state.phase === 'running' ? (
        <div class="bar big">
          <div style={{ width: `${Math.round((state.frac || 0) * 100)}%` }} />
        </div>
      ) : null}
      {state.phase === 'done' ? (
        <div class="notice ok">
          {state.msg}{' '}
          <button class="btn sm primary" onClick={onDone}>
            Start searching
          </button>
        </div>
      ) : null}
      {state.phase === 'error' ? <div class="notice err">{state.msg}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------- welcome (first run)

export function Welcome({ status, onStart }: { status: StatusMap; onStart: () => void }) {
  const now = Date.now();
  const gpt = status.chatgpt;
  const bigGpt = (gpt?.total || 0) - (gpt?.fetched || 0) > 300;
  return (
    <div class="welcome">
      <div class="hero-logo">
        <img src="icons/icon128.png" width={56} height={56} alt="" />
      </div>
      <h1>ChatSearch is indexing your chats</h1>
      <p class="muted">Real search for Claude and ChatGPT: every word of every chat, instantly, with typo tolerance and search by meaning. Everything stays in this browser.</p>
      <div class="welcome-sources">
        {(['claude', 'chatgpt'] as Source[]).map((src) => {
          const st = status[src];
          const pct = st?.total ? Math.round(((st.fetched || 0) / st.total) * 100) : 0;
          return (
            <div class="source-card">
              <div class="source-top">
                <SourceLogo source={src} size={18} />
                <div class="source-name">{SITE[src].name}</div>
                <div class="grow" />
                <div class={`pill state-${st?.state || 'idle'}`}>{st?.state === 'idle' ? 'synced' : st?.state || 'starting'}</div>
              </div>
              <div class="source-line">{statusLine(st, now)}</div>
              <div class="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              {st?.state === 'signed-out' ? (
                <a class="link" href={SITE[src].url} target="_blank">
                  Sign in to {SITE[src].name} <IconExternal size={12} />
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
      {bigGpt ? (
        <div class="notice">
          ChatGPT limits apps to about one chat download per minute, so a big history trickles in over days. <a href="#import">Import your ChatGPT data export</a> to index everything in a few minutes. Chats you open in ChatGPT are indexed instantly either way.
        </div>
      ) : null}
      <div class="tips">
        <div class="tip">
          <b>Pin it.</b> Click the puzzle-piece icon in Chrome's toolbar, then the pin next to ChatSearch.
        </div>
        <div class="tip">
          <b>Shortcut.</b> Press <kbd>{MOD}</kbd> <kbd>Shift</kbd> <kbd>K</kbd> anywhere in Chrome.
        </div>
        <div class="tip">
          <b>Address bar.</b> Type <kbd>cs</kbd> then a space and your search.
        </div>
        <div class="tip">
          <b>Search by meaning.</b> Press <kbd>Shift</kbd> <kbd>Enter</kbd> or the ✨ button when you don't remember the exact words.
        </div>
      </div>
      <button class="btn primary" onClick={onStart}>
        Start searching
      </button>
    </div>
  );
}

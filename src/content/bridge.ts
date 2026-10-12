/**
 * Isolated-world content script on claude.ai / chatgpt.com:
 *  - relays captures from the MAIN-world fetch observer to the service worker
 *  - after a ChatGPT reply finishes, snapshots the visible conversation from the DOM (free, no API call)
 *  - "open at match": highlights every match, scrolls to the chosen one, shows a tiny navigator
 */
import { chatgptMessagesFromList } from '../shared/extract';
import { normalize, normalizeQuery } from '../shared/normalize';
import type { Message } from '../shared/types';

const TAG = '__chatsearch__';
const source = location.hostname.includes('claude') ? 'claude' : 'chatgpt';

function send(msg: any) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => void 0);
  } catch {
    // extension reloaded: this content script is orphaned
  }
}

function currentChatId(): string | null {
  const m = /\/c(?:hat)?\/([0-9a-f-]{36})/.exec(location.pathname);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ ChatGPT DOM snapshot

function scrapeChatgpt(): Message[] {
  const nodes = document.querySelectorAll<HTMLElement>('[data-message-author-role]');
  const out: Message[] = [];
  nodes.forEach((n) => {
    const r = n.getAttribute('data-message-author-role');
    if (r !== 'user' && r !== 'assistant') return;
    const text = (n.innerText || '').trim();
    if (!text) return;
    out.push({ role: r, text, kind: 'text', mid: n.getAttribute('data-message-id') || undefined, main: true });
  });
  return out;
}

let domTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDomSnapshot(delay = 1800) {
  if (domTimer) clearTimeout(domTimer);
  domTimer = setTimeout(() => {
    domTimer = null;
    const id = currentChatId();
    if (!id) return;
    const messages = scrapeChatgpt();
    if (!messages.length) return;
    const title = document.title.replace(/\s*[|-]\s*ChatGPT\s*$/i, '').trim();
    send({ type: 'dom', source: 'chatgpt', id, title: title && title !== 'ChatGPT' ? title : undefined, messages });
  }, delay);
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || ev.data[TAG] !== 1) return;
  const d = ev.data;
  switch (d.type) {
    case 'cap':
    case 'deleted':
    case 'renamed':
    case 'touched':
      send({ ...d, [TAG]: undefined });
      break;
    case 'cap-page-raw': {
      const list = Array.isArray(d.data?.messages) ? d.data.messages : Array.isArray(d.data?.items) ? d.data.items : null;
      if (!list) break;
      const messages = chatgptMessagesFromList(list);
      if (messages.length) send({ type: 'cap-page', source: 'chatgpt', id: d.id, title: d.data?.title, messages });
      break;
    }
    case 'stream-done':
      scheduleDomSnapshot();
      break;
    case 'nav':
      onNav();
      break;
  }
});

// ------------------------------------------------------------------ activity signals

send({ type: 'page-hello', source });
setInterval(() => {
  if (source === 'chatgpt' && document.visibilityState === 'visible' && document.hasFocus()) send({ type: 'active', source });
}, 45_000);

// ------------------------------------------------------------------ jump to match

interface Intent {
  url: string;
  terms: string[];
  snippet?: string;
  role?: string;
}

let lastHref = location.href;
function onNav() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  clearHighlights();
}

async function checkIntent() {
  let intent: Intent | null = null;
  try {
    intent = await chrome.runtime.sendMessage({ type: 'get-highlight' });
  } catch {
    return;
  }
  if (!intent || !intent.terms?.length) return;
  runHighlight(intent);
}

const STYLE_ID = 'chatsearch-hl-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
::highlight(chatsearch-all){background-color:rgba(255,213,0,.42);color:inherit}
::highlight(chatsearch-cur){background-color:#ff9f1a;color:#111}
#chatsearch-nav{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:6px;padding:6px 8px 6px 12px;border-radius:999px;background:rgba(20,20,22,.92);color:#fff;font:500 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);backdrop-filter:blur(8px);user-select:none}
#chatsearch-nav button{all:unset;cursor:pointer;width:24px;height:24px;border-radius:999px;display:grid;place-items:center;color:#fff;opacity:.85}
#chatsearch-nav button:hover{background:rgba(255,255,255,.14);opacity:1}
#chatsearch-nav .cs-count{min-width:54px;text-align:center;font-variant-numeric:tabular-nums}
#chatsearch-nav .cs-dot{width:7px;height:7px;border-radius:50%;background:#ffb020;margin-right:2px}`;
  document.documentElement.appendChild(st);
}

let ranges: Range[] = [];
let cur = 0;
let nav: HTMLElement | null = null;

function clearHighlights() {
  const h = (CSS as any).highlights;
  h?.delete('chatsearch-all');
  h?.delete('chatsearch-cur');
  nav?.remove();
  nav = null;
  ranges = [];
}

function contentRoot(): HTMLElement {
  return (document.querySelector('main') as HTMLElement) || document.body;
}

function collectRanges(terms: string[]): Range[] {
  const root = contentRoot();
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('nav,aside,script,style,textarea,[contenteditable="true"],#chatsearch-nav')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && out.length < 2000) {
    const text = normalize(node.nodeValue || '');
    for (const t of terms) {
      let p = text.indexOf(t);
      while (p >= 0) {
        const r = document.createRange();
        r.setStart(node, p);
        r.setEnd(node, p + t.length);
        out.push(r);
        p = text.indexOf(t, p + t.length);
      }
    }
  }
  out.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
  // "crissy field": adjacent hits separated only by spaces are one match
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.endContainer === r.startContainer && r.startOffset >= last.endOffset && r.startOffset - last.endOffset <= 2 && !(r.startContainer.nodeValue || '').slice(last.endOffset, r.startOffset).trim()) {
      last.setEnd(r.endContainer, r.endOffset);
    } else merged.push(r);
  }
  return merged;
}

function pickTarget(snippet: string | undefined): number {
  if (!snippet || ranges.length < 2) return 0;
  const sn = normalizeQuery(snippet).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!sn) return 0;
  let best = 0;
  let bestScore = -1;
  ranges.forEach((r, i) => {
    const el = r.startContainer.parentElement?.closest('p,li,div,pre,td,blockquote') || r.startContainer.parentElement;
    const ctx = normalizeQuery(el?.textContent || '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
    // count snippet words present near this match
    const words = sn.split(' ').filter((w) => w.length > 3).slice(0, 14);
    const score = words.reduce((a, w) => a + (ctx.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function show(i: number) {
  if (!ranges.length) return;
  cur = (i + ranges.length) % ranges.length;
  const h = (CSS as any).highlights;
  const HL = (window as any).Highlight;
  if (h && HL) h.set('chatsearch-cur', new HL(ranges[cur]));
  const el = ranges[cur].startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const c = nav?.querySelector('.cs-count');
  if (c) c.textContent = `${cur + 1} / ${ranges.length}`;
}

function buildNav() {
  nav?.remove();
  nav = document.createElement('div');
  nav.id = 'chatsearch-nav';
  nav.innerHTML = `<span class="cs-dot"></span><span class="cs-count"></span><button title="Previous match (Shift+Enter)" data-a="prev">&#8593;</button><button title="Next match (Enter)" data-a="next">&#8595;</button><button title="Clear (Esc)" data-a="close">&#10005;</button>`;
  nav.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.getAttribute('data-a');
    if (a === 'prev') show(cur - 1);
    else if (a === 'next') show(cur + 1);
    else if (a === 'close') clearHighlights();
  });
  document.documentElement.appendChild(nav);
}

document.addEventListener(
  'keydown',
  (e) => {
    if (!nav || !ranges.length) return;
    const t = e.target as HTMLElement;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    if (e.key === 'Escape') clearHighlights();
    else if (e.key === 'Enter') {
      e.preventDefault();
      show(cur + (e.shiftKey ? -1 : 1));
    }
  },
  true,
);

async function runHighlight(intent: Intent) {
  ensureStyle();
  const terms = intent.terms.filter((t) => t.length > 0);
  const deadline = Date.now() + 15000;
  // wait for the conversation to render
  while (Date.now() < deadline) {
    ranges = collectRanges(terms);
    if (ranges.length) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  if (!ranges.length) return;
  // give late-rendering content a moment, then recollect once
  await new Promise((r) => setTimeout(r, 700));
  ranges = collectRanges(terms);
  const h = (CSS as any).highlights;
  const HL = (window as any).Highlight;
  if (h && HL) h.set('chatsearch-all', new HL(...ranges));
  buildNav();
  show(pickTarget(intent.snippet));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkIntent, { once: true });
else checkIntent();

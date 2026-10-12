import type { JSX } from 'preact';
import { normalize } from '../shared/normalize';

export function ago(t: number, now = Date.now()): string {
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d`;
  const dt = new Date(t);
  const sameYear = dt.getFullYear() === new Date(now).getFullYear();
  return dt.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fullDate(t: number): string {
  if (!t) return '';
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtNum(n: number): string {
  return (n || 0).toLocaleString();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Render text with highlighted ranges. */
export function Hl({ text, ranges }: { text: string; ranges: [number, number][] }): JSX.Element {
  if (!ranges?.length) return <>{text}</>;
  const out: any[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark>{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** Wrap occurrences of normalized terms inside an element's text nodes with <mark>. Returns marks. */
export function highlightDom(root: HTMLElement, terms: string[]): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const ts = terms.filter(Boolean);
  if (!ts.length) return marks;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) if ((n as Text).data.trim()) nodes.push(n as Text);
  for (const node of nodes) {
    const norm = normalize(node.data);
    const hits: [number, number][] = [];
    for (const t of ts) {
      let p = norm.indexOf(t);
      while (p >= 0) {
        hits.push([p, p + t.length]);
        p = norm.indexOf(t, p + t.length);
      }
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const h of hits) {
      const l = merged[merged.length - 1];
      if (l && h[0] <= l[1]) l[1] = Math.max(l[1], h[1]);
      else merged.push([h[0], h[1]]);
    }
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [s, e] of merged) {
      if (s > at) frag.appendChild(document.createTextNode(node.data.slice(at, s)));
      const m = document.createElement('mark');
      m.textContent = node.data.slice(s, e);
      frag.appendChild(m);
      marks.push(m);
      at = e;
    }
    if (at < node.data.length) frag.appendChild(document.createTextNode(node.data.slice(at)));
    node.parentNode!.replaceChild(frag, node);
  }
  return marks;
}

export function download(name: string, data: Blob | string, type = 'text/markdown') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function safeFileName(s: string) {
  return (s || 'chat').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

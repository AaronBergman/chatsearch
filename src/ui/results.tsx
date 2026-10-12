import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { toMarkdown } from '../shared/extract';
import type { ConvContent, ConvMeta, SearchHit, Snippet } from '../shared/types';
import { getConversation } from './api';
import { IconBack, IconChevronDown, IconCopy, IconDownload, IconExternal, IconStar, IconUp, LogoChatGPT, LogoClaude } from './icons';
import { ago, download, fullDate, Hl, highlightDom, safeFileName } from './util';

export function SourceLogo({ source, size = 15 }: { source: string; size?: number }) {
  return <span class={`logo logo-${source}`}>{source === 'claude' ? <LogoClaude size={size} /> : <LogoChatGPT size={size} />}</span>;
}

function roleLabel(s: Snippet, source: string) {
  const who = s.role === 'user' ? 'You' : source === 'claude' ? 'Claude' : 'ChatGPT';
  if (s.msgIdx < 0) return 'Summary';
  if (s.kind === 'artifact') return `${who} · artifact`;
  if (s.kind === 'attachment') return `${who} · attachment`;
  if (s.kind === 'thinking') return `${who} · thinking`;
  if (s.kind === 'code') return `${who} · code`;
  return who;
}

export function ResultItem({ hit, selected, onSelect, onOpen, now, wide }: { hit: SearchHit; selected: boolean; onSelect: () => void; onOpen: (e: MouseEvent) => void; now: number; wide: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const s = hit.snippets[0];
  return (
    <div
      ref={ref}
      class={`item${selected ? ' sel' : ''}${hit.kind === 'title' ? ' fuzzy' : ''}`}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onClick={(e) => {
        if (wide && !selected && !(e.metaKey || e.ctrlKey)) onSelect();
        else onOpen(e as unknown as MouseEvent);
      }}
      onDblClick={(e) => onOpen(e as unknown as MouseEvent)}
      onAuxClick={(e) => e.button === 1 && onOpen(e as unknown as MouseEvent)}
    >
      <div class="item-head">
        <SourceLogo source={hit.source} />
        <div class="item-title">
          <Hl text={hit.title} ranges={hit.titleHl} />
        </div>
        {hit.starred ? <IconStar size={11} class="star" /> : null}
        <time class="item-time" title={fullDate(hit.updatedAt)}>
          {ago(hit.updatedAt, now)}
        </time>
      </div>
      {s ? (
        <div class="item-snip">
          <span class={`who who-${s.role}`}>{roleLabel(s, hit.source)}</span>
          {s.pre ? '…' : ''}
          <Hl text={s.text} ranges={s.hl} />
          {s.post ? '…' : ''}
        </div>
      ) : hit.pending ? (
        <div class="item-snip muted">Title match · full text not downloaded yet</div>
      ) : null}
      {hit.kind !== 'recent' && (hit.hits > 1 || hit.project || hit.kind === 'semantic' || hit.kind === 'title' || hit.kind === 'fuzzy') ? (
        <div class="item-meta">
          {hit.kind === 'semantic' ? (
            <span class={`badge sem ${hit.band || ''}`} title={`Similarity ${(hit.sim || 0).toFixed(2)}`}>
              {hit.band === 'strong' ? 'strong match' : hit.band === 'weak' ? 'weak match' : 'related'}
            </span>
          ) : null}
          {hit.kind === 'title' ? <span class="badge">fuzzy title</span> : null}
          {hit.kind === 'fuzzy' ? <span class="badge">spelling</span> : null}
          {hit.hits > 1 && hit.kind !== 'semantic' ? <span>{hit.hits >= 60 ? '60+' : hit.hits} matches</span> : null}
          {hit.project ? <span class="proj">{hit.project}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------- preview

/** Adjacent marks separated only by whitespace ("blue" "angels") count as one match. */
function groupMarks(marks: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  for (const m of marks) {
    const prev = m.previousSibling;
    const last = groups[groups.length - 1];
    const lastMark = last?.[last.length - 1];
    const joined = lastMark && (prev === lastMark || (prev?.nodeType === 3 && !(prev.nodeValue || '').trim() && (prev.nodeValue || '').length <= 2 && prev.previousSibling === lastMark));
    if (joined) last.push(m);
    else groups.push([m]);
  }
  return groups;
}

export function Preview({ hit, terms, onOpen, onBack, settingsThinking }: { hit: SearchHit; terms: string[]; onOpen: (newTab: boolean) => void; onBack?: () => void; settingsThinking: boolean }) {
  const [data, setData] = useState<{ meta?: ConvMeta; content?: ConvContent } | null>(null);
  const [md, setMd] = useState<((t: string) => string) | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef<HTMLElement[][]>([]);
  const [markIdx, setMarkIdx] = useState(0);
  const [markCount, setMarkCount] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null);
    setShowAll(false);
    getConversation(hit.id).then((r) => alive && setData(r));
    return () => {
      alive = false;
    };
  }, [hit.id, hit.updatedAt]);

  useEffect(() => {
    import('./markdown').then((m) => setMd(() => m.renderMarkdown));
  }, []);

  const target = hit.snippets[0]?.msgIdx ?? -1;
  const msgs = data?.content?.messages || [];
  // long chats: show a window around the match first
  const visible = useMemo(() => {
    const list = msgs.map((m, i) => ({ m, i })).filter(({ m, i }) => (m.kind !== 'thinking' || settingsThinking) && (m.main !== false || i === target));
    if (showAll || list.length <= 40) return { list, cut: false };
    const at = Math.max(0, list.findIndex((x) => x.i >= target));
    const from = Math.max(0, at - 12);
    return { list: list.slice(from, from + 40), cut: true, from };
  }, [msgs, showAll, target, settingsThinking]);

  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root || !md || !data) return;
    root.querySelectorAll('mark').forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
    root.normalize();
    groupsRef.current = groupMarks(highlightDom(root, terms));
    setMarkCount(groupsRef.current.length);
    // scroll to the snippet's message and its first match
    const el = root.querySelector<HTMLElement>(`[data-i="${target}"]`);
    const first = el ? groupsRef.current.findIndex((g) => el.contains(g[0])) : 0;
    const idx = first >= 0 ? first : 0;
    setMarkIdx(idx);
    root.querySelectorAll('mark.cur').forEach((x) => x.classList.remove('cur'));
    const g = groupsRef.current[idx];
    if (g) {
      g.forEach((x) => x.classList.add('cur'));
      g[0].scrollIntoView({ block: 'center' });
    } else if (el) el.scrollIntoView({ block: 'start' });
    else root.scrollTop = 0;
  }, [data, md, visible, terms.join('\u0001')]);

  const go = (d: number) => {
    const groups = groupsRef.current;
    if (!groups.length) return;
    const i = (markIdx + d + groups.length) % groups.length;
    groups.forEach((g) => g.forEach((x) => x.classList.remove('cur')));
    groups[i].forEach((x) => x.classList.add('cur'));
    groups[i][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setMarkIdx(i);
  };

  const meta = data?.meta;
  const who = (role: string) => (role === 'user' ? 'You' : hit.source === 'claude' ? 'Claude' : 'ChatGPT');
  const copyMd = async () => {
    if (!meta || !data?.content) return;
    await navigator.clipboard.writeText(toMarkdown(meta, data.content.messages));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div class="preview">
      <div class="pv-head">
        {onBack ? (
          <button class="icon-btn" onClick={onBack} title="Back to results">
            <IconBack />
          </button>
        ) : null}
        <div class="pv-titles">
          <div class="pv-title">{hit.title}</div>
          <div class="pv-sub">
            <SourceLogo source={hit.source} size={12} />
            <span>{fullDate(hit.updatedAt)}</span>
            {meta?.model ? <span>· {meta.model}</span> : null}
            {hit.project ? <span>· {hit.project}</span> : null}
          </div>
        </div>
        <div class="pv-actions">
          {markCount > 0 ? (
            <div class="pv-nav" title="Matches in this chat">
              <span>
                {markIdx + 1}/{markCount}
              </span>
              <button class="icon-btn sm" onClick={() => go(-1)} title="Previous match">
                <IconUp size={14} />
              </button>
              <button class="icon-btn sm" onClick={() => go(1)} title="Next match">
                <IconChevronDown size={14} />
              </button>
            </div>
          ) : null}
          <button class="icon-btn" onClick={copyMd} title="Copy as Markdown" disabled={!data?.content}>
            {copied ? <span class="ok">✓</span> : <IconCopy size={15} />}
          </button>
          <button class="icon-btn" title="Download .md" disabled={!data?.content} onClick={() => meta && data?.content && download(`${safeFileName(meta.title)}.md`, toMarkdown(meta, data.content.messages))}>
            <IconDownload size={15} />
          </button>
          <button class="btn primary sm" onClick={() => onOpen(false)} title="Open the chat (jumps to the match)">
            Open <IconExternal size={13} />
          </button>
        </div>
      </div>
      <div class="pv-body" ref={bodyRef}>
        {!data ? <div class="pv-loading">Loading…</div> : null}
        {data && !data.content ? (
          <div class="pv-empty">
            <p>The full text of this chat hasn't been downloaded yet.</p>
            {hit.source === 'chatgpt' ? <p class="muted">ChatGPT only allows a slow download pace. Opening the chat once indexes it instantly, or import your ChatGPT data export from settings.</p> : null}
            {meta?.summary ? <p class="muted">{meta.summary}</p> : null}
          </div>
        ) : null}
        {visible.cut && (visible as any).from > 0 ? (
          <button class="show-all" onClick={() => setShowAll(true)}>
            Show the whole chat ({msgs.length} messages)
          </button>
        ) : null}
        {md
          ? visible.list.map(({ m, i }) => (
              <div class={`msg msg-${m.role}${m.main === false ? ' off' : ''}${i === target ? ' target' : ''}`} data-i={i} key={i}>
                <div class="msg-who">
                  {who(m.role)}
                  {m.kind && m.kind !== 'text' ? <span class="kind">{m.kind}</span> : null}
                  {m.main === false ? <span class="kind">other branch</span> : null}
                </div>
                {m.kind === 'code' ? (
                  <pre class="msg-body">
                    <code>{m.text.slice(0, 20000)}</code>
                  </pre>
                ) : (
                  <div class="msg-body md" dangerouslySetInnerHTML={{ __html: md(m.text.length > 30000 ? m.text.slice(0, 30000) + '\n\n…' : m.text) }} />
                )}
              </div>
            ))
          : null}
        {visible.cut && !showAll ? (
          <button class="show-all" onClick={() => setShowAll(true)}>
            Show the whole chat ({msgs.length} messages)
          </button>
        ) : null}
      </div>
    </div>
  );
}

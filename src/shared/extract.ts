/**
 * Turn raw Claude / ChatGPT conversation JSON (from the web API or from an official data export,
 * which use nearly the same shapes) into ConvMeta + ConvContent.
 */
import type { ConvContent, ConvMeta, Message, MsgKind, Role } from './types';

const MAX_MSG_CHARS = 400_000;
const MAX_ATTACHMENT_CHARS = 200_000;

export function toMs(t: unknown): number {
  if (t == null) return 0;
  if (typeof t === 'number') return t < 1e11 ? Math.round(t * 1000) : Math.round(t);
  if (typeof t === 'string') {
    const n = Date.parse(t);
    if (!Number.isNaN(n)) return n;
    const f = Number(t);
    if (!Number.isNaN(f)) return toMs(f);
  }
  return 0;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function claudeUrl(uuid: string) {
  return `https://claude.ai/chat/${uuid}`;
}
export function chatgptUrl(id: string) {
  return `https://chatgpt.com/c/${id}`;
}

// ---------------------------------------------------------------- Claude

const ARTIFACT_FIELDS = ['content', 'file_text', 'new_str', 'new_string', 'code'];

function claudeToolText(b: any): string {
  const input = b?.input;
  if (!input || typeof input !== 'object') return '';
  const parts: string[] = [];
  if (typeof input.title === 'string' && input.title) parts.push(input.title);
  for (const f of ARTIFACT_FIELDS) {
    const v = input[f];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.length > (input.title ? 1 : 0) ? parts.join('\n') : '';
}

/** Build meta from a Claude list item or a full conversation object. */
export function claudeMeta(c: any, org: string | undefined): ConvMeta {
  const uuid = c.uuid;
  return {
    id: `claude:${uuid}`,
    source: 'claude',
    nativeId: uuid,
    org,
    title: (c.name || '').trim() || 'Untitled',
    summary: typeof c.summary === 'string' && c.summary ? c.summary.slice(0, 4000) : undefined,
    createdAt: toMs(c.created_at),
    updatedAt: toMs(c.updated_at),
    model: c.model || undefined,
    project: c.project?.name || undefined,
    projectId: c.project_uuid || c.project?.uuid || undefined,
    starred: !!c.is_starred,
    archived: !!c.is_archived,
    url: claudeUrl(uuid),
  };
}

export function claudeContent(c: any): Message[] {
  const msgs: any[] = Array.isArray(c.chat_messages) ? c.chat_messages : [];
  if (!msgs.length) return [];
  const byId = new Map<string, any>();
  for (const m of msgs) if (m?.uuid) byId.set(m.uuid, m);
  // main branch = path from current leaf to root
  const main = new Set<string>();
  let cur = c.current_leaf_message_uuid && byId.get(c.current_leaf_message_uuid);
  let guard = 0;
  while (cur && guard++ < 100000) {
    main.add(cur.uuid);
    cur = cur.parent_message_uuid ? byId.get(cur.parent_message_uuid) : undefined;
  }
  const hasTree = main.size > 0;
  const ordered = [...msgs].sort((a, b) => {
    const ma = !hasTree || main.has(a.uuid) ? 0 : 1;
    const mb = !hasTree || main.has(b.uuid) ? 0 : 1;
    if (ma !== mb) return ma - mb;
    const ia = typeof a.index === 'number' ? a.index : 0;
    const ib = typeof b.index === 'number' ? b.index : 0;
    if (ia !== ib) return ia - ib;
    return toMs(a.created_at) - toMs(b.created_at);
  });

  const out: Message[] = [];
  for (const m of ordered) {
    const role: Role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : 'system';
    const ts = toMs(m.created_at) || undefined;
    const isMain = !hasTree || main.has(m.uuid);
    const base = { ts, mid: m.uuid as string, main: isMain };
    const texts: string[] = [];
    const extra: Message[] = [];
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'thinking') {
        // full thinking text when present, otherwise the visible summaries (claude.ai hides raw thinking)
        const full = typeof b.thinking === 'string' ? b.thinking.trim() : '';
        const sums = Array.isArray(b.summaries) ? b.summaries.map((x: any) => (typeof x?.summary === 'string' ? x.summary : '')).filter(Boolean).join('\n') : '';
        const t = full || sums;
        if (t) extra.push({ role, text: clip(t, MAX_MSG_CHARS), kind: 'thinking', ...base });
      } else if (b.type === 'tool_use') {
        const t = claudeToolText(b);
        if (t) extra.push({ role, text: clip(t, MAX_MSG_CHARS), kind: 'artifact', ...base });
      }
    }
    if (!texts.length && typeof m.text === 'string' && m.text) texts.push(m.text);
    const text = texts.join('\n\n').trim();
    const attachments: Message[] = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      const body = typeof a?.extracted_content === 'string' ? a.extracted_content : '';
      const name = typeof a?.file_name === 'string' ? a.file_name : '';
      if (body.trim() || name) {
        attachments.push({ role, text: clip((name ? `${name}\n` : '') + body, MAX_ATTACHMENT_CHARS), kind: 'attachment', ...base });
      }
    }
    const fileNames = (Array.isArray(m.files) ? m.files : Array.isArray(m.files_v2) ? m.files_v2 : [])
      .map((f: any) => f?.file_name)
      .filter((s: any) => typeof s === 'string' && s);
    let main_text = text;
    if (fileNames.length) main_text = (main_text ? main_text + '\n\n' : '') + fileNames.map((n: string) => `[${n}]`).join(' ');
    if (role === 'user') {
      if (main_text) out.push({ role, text: clip(main_text, MAX_MSG_CHARS), kind: 'text', ...base });
      out.push(...attachments, ...extra);
    } else {
      // keep thinking before the answer, artifacts after it
      out.push(...extra.filter((e) => e.kind === 'thinking'));
      if (main_text) out.push({ role, text: clip(main_text, MAX_MSG_CHARS), kind: 'text', ...base });
      out.push(...extra.filter((e) => e.kind !== 'thinking'), ...attachments);
    }
  }
  return out;
}

export function claudeConversation(c: any, org: string | undefined): { meta: ConvMeta; content: ConvContent } {
  const meta = claudeMeta(c, org);
  const messages = claudeContent(c);
  if (!meta.updatedAt) meta.updatedAt = Math.max(0, ...messages.map((m) => m.ts || 0));
  return { meta, content: { id: meta.id, messages } };
}

// ---------------------------------------------------------------- ChatGPT

export function chatgptMeta(c: any): ConvMeta {
  const id = c.conversation_id || c.id;
  return {
    id: `chatgpt:${id}`,
    source: 'chatgpt',
    nativeId: id,
    title: (c.title || '').trim() || 'New chat',
    createdAt: toMs(c.create_time),
    updatedAt: toMs(c.update_time),
    model: c.default_model_slug || undefined,
    projectId: typeof c.gizmo_id === 'string' && c.gizmo_id.startsWith('g-p-') ? c.gizmo_id : undefined,
    starred: !!c.is_starred,
    archived: !!c.is_archived,
    url: chatgptUrl(id),
  };
}

function partsText(parts: any[]): string {
  const out: string[] = [];
  for (const p of parts || []) {
    if (typeof p === 'string') out.push(p);
    else if (p && typeof p === 'object') {
      if (p.content_type === 'audio_transcription' && typeof p.text === 'string') out.push(p.text);
      else if (typeof p.text === 'string' && p.content_type !== 'image_asset_pointer') out.push(p.text);
    }
  }
  return out.join('\n').trim();
}

const TOOL_TEXT_FIELDS = ['title', 'name', 'prompt', 'content', 'text', 'code'];
function toolJsonText(raw: string): string {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return '';
    const out = TOOL_TEXT_FIELDS.map((k) => j[k]).filter((v) => typeof v === 'string' && v.trim());
    const t = out.join('\n');
    return t.length >= 20 ? t : '';
  } catch {
    return '';
  }
}

function canvasText(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const bits: string[] = [];
    if (typeof j.name === 'string') bits.push(j.name);
    if (typeof j.content === 'string') bits.push(j.content);
    if (Array.isArray(j.updates)) for (const u of j.updates) if (typeof u?.replacement === 'string') bits.push(u.replacement);
    return bits.join('\n');
  } catch {
    return '';
  }
}

function chatgptMessage(msg: any): { role: Role; text: string; kind: MsgKind } | null {
  if (!msg || !msg.content) return null;
  const md = msg.metadata || {};
  if (md.is_visually_hidden_from_conversation) return null;
  if (md.is_user_system_message) return null;
  const role: Role = msg.author?.role === 'user' ? 'user' : msg.author?.role === 'assistant' ? 'assistant' : msg.author?.role === 'tool' ? 'tool' : 'system';
  if (role === 'system') return null;
  const c = msg.content;
  const ct = c.content_type;
  const recipient = msg.recipient || 'all';
  if (role === 'tool') return null;
  if (ct === 'text' || ct === 'multimodal_text') {
    if (recipient !== 'all') return null;
    const t = partsText(c.parts);
    return t ? { role, text: t, kind: 'text' } : null;
  }
  if (ct === 'code') {
    const raw = typeof c.text === 'string' ? c.text : '';
    if (!raw.trim()) return null;
    if (typeof recipient === 'string' && recipient.startsWith('canmore.')) {
      const t = canvasText(raw);
      return t ? { role, text: t, kind: 'artifact' } : null;
    }
    if (recipient === 'python' || recipient === 'all' || (typeof recipient === 'string' && recipient.endsWith('.exec'))) return { role, text: raw, kind: 'code' };
    // other tools (names are often obfuscated, e.g. "de1d73e.create"): keep any prose-like JSON fields
    const t = toolJsonText(raw);
    return t ? { role, text: t, kind: 'artifact' } : null;
  }
  if (ct === 'thoughts' && Array.isArray(c.thoughts)) {
    const t = c.thoughts.map((x: any) => [x?.summary, x?.content].filter((s) => typeof s === 'string' && s).join('\n')).join('\n\n').trim();
    return t ? { role, text: t, kind: 'thinking' } : null;
  }
  return null;
}

export function chatgptContent(c: any): Message[] {
  const mapping = c.mapping && typeof c.mapping === 'object' ? c.mapping : {};
  const nodes = Object.values(mapping) as any[];
  if (!nodes.length) return [];
  const main = new Set<string>();
  let cur = c.current_node ? mapping[c.current_node] : undefined;
  let guard = 0;
  while (cur && guard++ < 100000) {
    main.add(cur.id);
    cur = cur.parent ? mapping[cur.parent] : undefined;
  }
  const hasTree = main.size > 0;
  // main path in order (walk down from root following main set), then the rest by time
  const mainPath: any[] = [];
  if (hasTree) {
    let n = mapping[c.current_node];
    const stack: any[] = [];
    guard = 0;
    while (n && guard++ < 100000) {
      stack.push(n);
      n = n.parent ? mapping[n.parent] : undefined;
    }
    mainPath.push(...stack.reverse());
  }
  const others = nodes
    .filter((n) => !hasTree || !main.has(n.id))
    .sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
  const ordered = [...mainPath, ...others];
  const out: Message[] = [];
  for (const n of ordered) {
    const r = chatgptMessage(n.message);
    if (!r) continue;
    const isMain = !hasTree || main.has(n.id);
    const ts = toMs(n.message.create_time) || undefined;
    const prev = out[out.length - 1];
    // merge assistant continuations (one visible turn is often several nodes)
    if (prev && prev.role === r.role && prev.kind === 'text' && r.kind === 'text' && prev.main === isMain && r.role === 'assistant') {
      prev.text = clip(prev.text + '\n\n' + r.text, MAX_MSG_CHARS);
      continue;
    }
    out.push({ role: r.role, text: clip(r.text, MAX_MSG_CHARS), kind: r.kind, ts, mid: n.message.id, main: isMain });
  }
  return out;
}

/** Messages from the paginated `/backend-api/conversations/{id}` endpoint (current branch only). */
export function chatgptMessagesFromList(list: any[]): Message[] {
  const out: Message[] = [];
  for (const raw of list || []) {
    const msg = raw?.message && raw.message.content ? raw.message : raw;
    const r = chatgptMessage(msg);
    if (!r) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === 'assistant' && r.role === 'assistant' && prev.kind === 'text' && r.kind === 'text') {
      prev.text = clip(prev.text + '\n\n' + r.text, MAX_MSG_CHARS);
      continue;
    }
    out.push({ role: r.role, text: clip(r.text, MAX_MSG_CHARS), kind: r.kind, ts: toMs(msg.create_time) || undefined, mid: msg.id, main: true });
  }
  return out;
}

export function chatgptConversation(c: any): { meta: ConvMeta; content: ConvContent } {
  const meta = chatgptMeta(c);
  const messages = chatgptContent(c);
  if (!meta.updatedAt) meta.updatedAt = Math.max(0, ...messages.map((m) => m.ts || 0));
  if (!meta.createdAt) meta.createdAt = Math.min(...messages.map((m) => m.ts || Infinity).concat([meta.updatedAt]));
  return { meta, content: { id: meta.id, messages } };
}

/** Markdown export of one conversation. */
export function toMarkdown(meta: ConvMeta, msgs: Message[], opts: { includeThinking?: boolean; includeBranches?: boolean } = {}): string {
  const lines: string[] = [];
  const src = meta.source === 'claude' ? 'Claude' : 'ChatGPT';
  lines.push(`# ${meta.title}`, '');
  const bits = [`${src}`, new Date(meta.createdAt || meta.updatedAt).toISOString().slice(0, 10)];
  if (meta.model) bits.push(meta.model);
  if (meta.project) bits.push(`project: ${meta.project}`);
  lines.push(`_${bits.join(' · ')}_  `, `<${meta.url}>`, '');
  for (const m of msgs) {
    if (m.main === false && !opts.includeBranches) continue;
    if (m.kind === 'thinking' && !opts.includeThinking) continue;
    const who = m.role === 'user' ? 'You' : src;
    const label = m.kind === 'artifact' ? `${who} (artifact)` : m.kind === 'attachment' ? `${who} (attachment)` : m.kind === 'thinking' ? `${who} (thinking)` : m.kind === 'code' ? `${who} (code)` : who;
    lines.push(`## ${label}`, '');
    if (m.kind === 'code') lines.push('```', m.text, '```');
    else lines.push(m.text);
    lines.push('');
  }
  return lines.join('\n');
}

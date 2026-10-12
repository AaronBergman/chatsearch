/**
 * Runs the real extraction + indexing code against live conversations inside a claude.ai or chatgpt.com
 * tab and returns aggregate stats only (no chat text), to catch unhandled content shapes.
 * Bundle: npx esbuild test/real/validate.ts --bundle --format=iife --minify --outfile=test/.out/validate.js
 */
import { chatgptConversation, claudeConversation } from '../../src/shared/extract';
import { buildChunks, buildIndexRec } from '../../src/shared/indexer';

const OPTS = { includeThinking: false, includeAttachments: true };

function tally(map: Record<string, number>, k: string) {
  map[k] = (map[k] || 0) + 1;
}

(window as any).__csValidate = async (n = 30) => {
  const out: any = { n: 0, errors: [] as string[], kinds: {}, rawTypes: {}, emptyConvs: 0, msgs: 0, chars: 0, chunks: 0, maxChars: 0, offBranch: 0, ms: 0 };
  const claude = location.hostname.includes('claude');
  let items: any[] = [];
  let auth: Record<string, string> = {};
  let org = '';
  if (claude) {
    const orgs = await (await fetch('/api/organizations')).json();
    org = orgs.find((o: any) => (o.capabilities || []).includes('chat'))?.uuid;
    const page = await (await fetch(`/api/organizations/${org}/chat_conversations_v2?limit=${n}&offset=0&consistency=eventual`)).json();
    items = page.data;
  } else {
    const s = await (await fetch('/api/auth/session')).json();
    auth = { Authorization: `Bearer ${s.accessToken}` };
    const page = await (await fetch(`/backend-api/conversations?offset=0&limit=${n}&order=updated`, { headers: auth })).json();
    items = page.items;
  }
  for (const it of items) {
    try {
      const raw = claude
        ? await (await fetch(`/api/organizations/${org}/chat_conversations/${it.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`)).json()
        : await (await fetch(`/backend-api/conversation/${it.id}`, { headers: auth })).json();
      if (claude) for (const m of raw.chat_messages || []) for (const c of m.content || []) tally(out.rawTypes, `${m.sender}:${c.type}`);
      else for (const node of Object.values<any>(raw.mapping || {})) if (node.message) tally(out.rawTypes, `${node.message.author?.role}:${node.message.content?.content_type}${node.message.recipient && node.message.recipient !== 'all' ? '>' + node.message.recipient : ''}`);
      const t0 = performance.now();
      const { meta, content } = claude ? claudeConversation(raw, org) : chatgptConversation(raw);
      const rec = buildIndexRec(meta, content, OPTS);
      const ch = buildChunks(meta, content);
      out.ms += performance.now() - t0;
      out.n++;
      if (!content.messages.length) out.emptyConvs++;
      out.msgs += content.messages.length;
      out.chunks += ch.length;
      out.chars += rec.norm.length;
      out.maxChars = Math.max(out.maxChars, rec.norm.length);
      for (const m of content.messages) {
        tally(out.kinds, `${m.role}:${m.kind}`);
        if (m.main === false) out.offBranch++;
      }
    } catch (e: any) {
      out.errors.push(String(e?.message || e).slice(0, 120));
    }
    await new Promise((r) => setTimeout(r, claude ? 150 : 1200));
  }
  out.ms = Math.round(out.ms);
  return out;
};

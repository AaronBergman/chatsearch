/**
 * Mock claude.ai + chatgpt.com for end-to-end tests. One HTTPS server answers both hosts (Chromium maps
 * the real hostnames to it with --host-resolver-rules), speaking the same API shapes the real sites use.
 * Auth is cookie based like the real thing, so the extension's credentialed fetches are exercised too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORG = '0b5e1d2c-1111-4aaa-8bbb-000000000001';
export const PROJECT_GIZMO = 'g-p-6788aa11bb22cc33dd44ee55ff667788';

function cert() {
  const dir = join(HERE, '.certs');
  const key = join(dir, 'key.pem');
  const crt = join(dir, 'cert.pem');
  if (!existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '3650', '-subj', '/CN=claude.ai', '-addext', 'subjectAltName=DNS:claude.ai,DNS:chatgpt.com,DNS:chat.openai.com'], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

// ------------------------------------------------------------------ synthetic but realistic-looking data

const FILLER = readFileSync('/usr/share/dict/words', 'utf8')
  .split('\n')
  .filter((w) => w.length > 3 && w.length < 10 && /^[a-z]+$/.test(w));
let n = 7;
const pick = () => FILLER[(n = (n * 48271) % 2147483647) % FILLER.length];
const filler = (k) => Array.from({ length: k }, pick).join(' ');

/** Hand-written chats the tests search for; the rest is generated filler. */
const CURATED = {
  claude: [
    { name: 'SF Fleet Week planes', turns: [['Tell me about SF fleet week and whether it is too late to see planes', 'Not too late at all. The Fleet Week Air Show runs October 9-11 and the Blue Angels headline each afternoon over the bay.'], ['Best spot to watch?', 'Marina Green and Crissy Field are the classic viewing spots; Aquatic Park is a little less crowded.']] },
    { name: 'Saffron risotto', turns: [['risotto recipe please', 'Toast arborio rice in butter, add warm stock one ladle at a time, finish with parmesan and a pinch of saffron.']] },
    { name: 'Explaining airplanes to a kid', turns: [['how do airplanes stay up, explain like I am six', 'Wings are shaped so air moving over them pushes the plane up. That push is called lift.']] },
    { name: 'Rust borrow checker error', turns: [['cannot borrow `x` as mutable because it is also borrowed as immutable', 'The immutable reference is still alive when you take the mutable one. Shorten the first borrow by cloning the value or restructuring the loop.']] },
    { name: 'Backyard birding notes', turns: [['which songbirds leave the bay area when it gets cold?', 'Many warblers and swallows head south to Mexico and Central America for the winter, while juncos and sparrows arrive from the north.']] },
  ],
  chatgpt: [
    { title: 'Plane WiFi hacking toolkit', turns: [["I'm about to go on a plane and am a huge tech nerd", 'Bring a travel router; most in-flight wifi is captive-portal based, so log in once and share the connection.']] },
    { title: 'Sourdough starter rescue', turns: [['my sourdough starter smells like nail polish remover', 'That acetone smell means it is hungry. Discard most of it and feed at a 1:5:5 ratio twice a day for a few days.']] },
    { title: 'Tax question about RSUs', turns: [['how are RSUs taxed when they vest?', 'They are taxed as ordinary income at vest, based on the fair market value that day; your cost basis is that same value.']] },
  ],
  chatgptProject: { title: 'Lisbon itinerary', turns: [['three days in Lisbon in November, what should I prioritize?', 'Alfama on foot, the tram 28 early in the morning, a day trip to Sintra, and pasteis de nata in Belem.']] },
  chatgptArchived: { title: 'Old apartment lease', turns: [['can my landlord keep the deposit for normal wear and tear?', 'Generally no. Normal wear and tear cannot be deducted from a security deposit in California.']] },
};

const uuid = (prefix, i) => `${prefix}${i.toString(16).padStart(6, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

export function makeData({ claudeFiller = 60, gptFiller = 40 } = {}) {
  const now = Date.now();
  const claude = [];
  const gpt = [];
  let t = now - 60_000;
  CURATED.claude.forEach((c, i) => claude.push({ uuid: uuid('c1', i), name: c.name, turns: c.turns, updated: (t -= 3600_000 * 7) }));
  for (let i = 0; i < claudeFiller; i++) claude.push({ uuid: uuid('c2', i), name: `${pick()} ${pick()} notes`, turns: [[filler(20), filler(120)], [filler(12), filler(200)]], updated: (t -= 3600_000 * 5) });
  t = now - 120_000;
  CURATED.chatgpt.forEach((c, i) => gpt.push({ id: uuid('a1', i), title: c.title, turns: c.turns, updated: (t -= 3600_000 * 9) }));
  gpt.push({ id: uuid('a3', 0), title: CURATED.chatgptProject.title, turns: CURATED.chatgptProject.turns, updated: (t -= 3600_000), project: PROJECT_GIZMO });
  gpt.push({ id: uuid('a4', 0), title: CURATED.chatgptArchived.title, turns: CURATED.chatgptArchived.turns, updated: (t -= 3600_000 * 400), archived: true });
  for (let i = 0; i < gptFiller; i++) gpt.push({ id: uuid('a2', i), title: `${pick()} ${pick()}`, turns: [[filler(15), filler(150)]], updated: (t -= 3600_000 * 6) });
  claude.sort((a, b) => b.updated - a.updated);
  gpt.sort((a, b) => b.updated - a.updated);
  return { claude, gpt };
}

const iso = (ms) => new Date(ms).toISOString();

function claudeListItem(c) {
  return { uuid: c.uuid, name: c.name, summary: '', model: 'claude-opus-5-5', created_at: iso(c.updated - 3600_000), updated_at: iso(c.updated), is_starred: !!c.starred, settings: { enabled_mcp_tools: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`tool_${i}`, true])) } };
}

export function claudeDetail(c) {
  const msgs = [];
  let parent = '00000000-0000-4000-8000-000000000000';
  c.turns.forEach(([u, a], i) => {
    const hu = `${c.uuid.slice(0, 24)}${(i * 2).toString(16).padStart(12, '0')}`;
    const au = `${c.uuid.slice(0, 24)}${(i * 2 + 1).toString(16).padStart(12, '0')}`;
    msgs.push({ uuid: hu, sender: 'human', index: i * 2, created_at: iso(c.updated), parent_message_uuid: parent, text: '', content: [{ type: 'text', text: u }], attachments: [], files: [] });
    msgs.push({ uuid: au, sender: 'assistant', index: i * 2 + 1, created_at: iso(c.updated), parent_message_uuid: hu, text: '', content: [{ type: 'thinking', thinking: 'private reasoning ' + u }, { type: 'text', text: a }], attachments: [], files: [] });
    parent = au;
  });
  return { ...claudeListItem(c), current_leaf_message_uuid: parent, chat_messages: msgs };
}

function gptListItem(c) {
  return { id: c.id, title: c.title, create_time: iso(c.updated - 3600_000), update_time: iso(c.updated), is_archived: !!c.archived, gizmo_id: c.project || null, is_starred: false };
}

export function gptDetail(c) {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  c.turns.forEach(([u, a], i) => {
    const un = `${c.id.slice(0, 24)}${(i * 2).toString(16).padStart(12, '0')}`;
    const an = `${c.id.slice(0, 24)}${(i * 2 + 1).toString(16).padStart(12, '0')}`;
    mapping[un] = { id: un, parent, children: [an], message: { id: un, author: { role: 'user' }, create_time: c.updated / 1000, content: { content_type: 'text', parts: [u] }, recipient: 'all', metadata: {} } };
    mapping[an] = { id: an, parent: un, children: [], message: { id: an, author: { role: 'assistant' }, create_time: c.updated / 1000, content: { content_type: 'text', parts: [a] }, recipient: 'all', metadata: {} } };
    mapping[parent].children.push(un);
    parent = an;
  });
  return { conversation_id: c.id, title: c.title, create_time: c.updated / 1000 - 3600, update_time: c.updated / 1000, mapping, current_node: parent, default_model_slug: 'gpt-5', gizmo_id: c.project || null, is_archived: !!c.archived };
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = () => `${b64u({ alg: 'none' })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

/** A small chat-like page that loads a conversation the way the real SPA does (fetch from the page), so the
 * MAIN-world hook sees it. Renders simple Markdown so screenshots look like a real chat. */
function chatPage(kind, id) {
  const md = `function md(t){const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const blocks=t.split(/\\n\\n+/);return blocks.map(b=>{if(b.startsWith('\`\`\`'))return '<pre>'+esc(b.replace(/^\`\`\`\\w*\\n?|\`\`\`$/g,''))+'</pre>';let h=esc(b).replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>').replace(/\`([^\`]+)\`/g,'<code>$1</code>');if(/^(- |\\d+\\. )/m.test(b)){const items=h.split(/\\n/).map(l=>l.replace(/^(- |\\d+\\. )/,''));return '<ul>'+items.map(x=>'<li>'+x+'</li>').join('')+'</ul>';}return '<p>'+h.replace(/\\n/g,'<br>')+'</p>';}).join('');}`;
  const render = `function add(role,text){const m=document.querySelector('main .thread');const d=document.createElement('div');d.className='msg '+role;${kind === 'chatgpt' ? "d.setAttribute('data-message-author-role',role);" : ''}d.innerHTML=md(text);m.appendChild(d);}`;
  const script =
    kind === 'claude'
      ? `fetch('/api/organizations/${ORG}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true').then(r=>r.json()).then(c=>{document.title=c.name;document.querySelector('h1').textContent=c.name;for(const x of c.chat_messages){add(x.sender==='human'?'user':'assistant',x.content.filter(p=>p.type==='text').map(p=>p.text).join('\\n'));}})`
      : `fetch('/api/auth/session').then(r=>r.json()).then(s=>fetch('/backend-api/conversation/${id}',{headers:{Authorization:'Bearer '+s.accessToken}})).then(r=>r.json()).then(c=>{document.title=c.title;document.querySelector('h1').textContent=c.title;let n=c.mapping[c.current_node];const out=[];while(n){if(n.message)out.unshift(n.message);n=c.mapping[n.parent];}for(const x of out){add(x.author.role,x.content.parts.join('\\n'));}})`;
  const css = `body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#1f1f1f;background:#faf9f7;display:flex}nav{width:180px;flex:none;height:100vh;position:sticky;top:0;background:#f1efeb;border-right:1px solid #e6e3dd;padding:18px 12px;box-sizing:border-box;font-size:13.5px;color:#555}nav div{padding:7px 10px;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}nav div.on{background:#e4e1da;color:#222}main{flex:1;min-width:0}header{position:sticky;top:0;background:#faf9f7ee;border-bottom:1px solid #eee;padding:14px 32px}h1{font-size:15px;margin:0;font-weight:600}.thread{max-width:720px;margin:0 auto;padding:24px 32px 120px}.earlier{height:260px;border-left:3px solid #eee;margin:10px 0 30px;padding-left:16px;color:#aaa;font-size:14px}.msg{margin:18px 0}.msg.user{background:#efece6;border-radius:14px;padding:10px 16px;margin-left:15%}.msg p{margin:0 0 10px}.msg ul{margin:0 0 10px;padding-left:22px}pre{background:#f3f1ec;padding:12px;border-radius:8px;overflow:auto;font-size:13px}code{background:#efece6;padding:1px 5px;border-radius:4px;font-size:.9em}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>loading</title><style>${css}</style></head><body><nav><div class="on">Current chat</div><div>Weekend plans</div><div>Recipe ideas</div><div>Work notes</div></nav><main><header><h1>Loading</h1></header><div class="thread"><div class="earlier">Earlier messages</div></div></main><script>${md}${render}${script}</script></body></html>`;
}

export function startMock({ port = 8443, data = makeData(), gptBurst = 1e9 } = {}) {
  const stats = { gptServed: new Set(), claudeDetail: 0, gptDetail: 0, gptList: 0, claudeList: 0, gpt429: 0, unauth: 0, requests: [] };
  let gptRemaining = gptBurst;
  let challenge = false; // when on, claude.ai API calls get a Cloudflare-style HTML challenge page
  const byClaude = new Map(data.claude.map((c) => [c.uuid, c]));
  const byGpt = new Map(data.gpt.map((c) => [c.id, c]));
  const server = https.createServer(cert(), (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const u = new URL(req.url, `https://${host}`);
    const p = u.pathname;
    const cookies = req.headers.cookie || '';
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    stats.requests.push(`${req.method} ${host}${p}`);
    if (host === 'claude.ai') {
      if (p.startsWith('/chat/')) return send(200, chatPage('claude', p.slice(6)), 'text/html');
      if (p.startsWith('/api/') && challenge) {
        stats.challenged = (stats.challenged || 0) + 1;
        res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge', 'cache-control': 'no-store' });
        return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
      }
      if (p.startsWith('/api/') && !cookies.includes('sessionKey=')) {
        stats.unauth++;
        return send(403, { type: 'error', error: { type: 'permission_error' } });
      }
      if (p === '/api/organizations') return send(200, [{ uuid: ORG, name: 'Personal', capabilities: ['chat', 'claude_pro'] }]);
      if (p === `/api/organizations/${ORG}/chat_conversations_v2`) {
        stats.claudeList++;
        const limit = Number(u.searchParams.get('limit') || 30);
        const offset = Number(u.searchParams.get('offset') || 0);
        const page = data.claude.slice(offset, offset + limit).map(claudeListItem);
        return send(200, { data: page, has_more: offset + limit < data.claude.length });
      }
      const m = /^\/api\/organizations\/[^/]+\/chat_conversations\/([0-9a-f-]{36})$/.exec(p);
      if (m) {
        const c = byClaude.get(m[1]);
        if (!c) return send(404, { error: 'not found' });
        if (req.method === 'DELETE') {
          byClaude.delete(c.uuid);
          data.claude.splice(data.claude.indexOf(c), 1);
          res.writeHead(204);
          return res.end();
        }
        stats.claudeDetail++;
        return send(200, claudeDetail(c));
      }
      return send(404, { error: 'no route' });
    }
    if (host === 'chatgpt.com' || host === 'chat.openai.com') {
      if (p.startsWith('/c/')) return send(200, chatPage('chatgpt', p.slice(3)), 'text/html');
      if (p === '/api/auth/session') return send(200, cookies.includes('__Secure-next-auth.session-token=') ? { accessToken: fakeJwt(), expires: iso(Date.now() + 86400_000), user: { id: 'user-x' } } : {});
      if (p.startsWith('/backend-api/') && !(req.headers.authorization || '').startsWith('Bearer ')) {
        stats.unauth++;
        return send(401, { detail: 'unauthorized' });
      }
      if (p === '/backend-api/conversations') {
        stats.gptList++;
        const limit = Number(u.searchParams.get('limit') || 28);
        const offset = Number(u.searchParams.get('offset') || 0);
        const archived = u.searchParams.get('is_archived') === 'true';
        const pool = data.gpt.filter((c) => !!c.archived === archived && !c.project);
        return send(200, { items: pool.slice(offset, offset + limit).map(gptListItem), total: pool.length, limit, offset });
      }
      if (p === '/backend-api/gizmos/snorlax/sidebar') return send(200, { items: [{ gizmo: { gizmo: { id: PROJECT_GIZMO, display: { name: 'Travel' } } }, conversations: { items: [] } }], cursor: null });
      if (p === `/backend-api/gizmos/${PROJECT_GIZMO}/conversations`) return send(200, { items: data.gpt.filter((c) => c.project).map(gptListItem), cursor: null });
      const m = /^\/backend-api\/conversation\/([0-9a-f-]{36})$/.exec(p);
      if (m) {
        if (gptRemaining <= 0) {
          stats.gpt429++;
          return send(429, { detail: 'Too many requests' });
        }
        gptRemaining--;
        const c = byGpt.get(m[1]);
        if (!c) return send(404, { detail: 'not found' });
        stats.gptDetail++;
        stats.gptServed.add(c.id);
        return send(200, gptDetail(c));
      }
      return send(404, { detail: 'no route' });
    }
    send(404, 'unknown host', 'text/plain');
  });
  const addClaude = (c) => {
    data.claude.unshift(c);
    byClaude.set(c.uuid, c);
  };
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, stats, data, addClaude, refill: (k) => (gptRemaining = k), setChallenge: (on) => (challenge = on) })));
}

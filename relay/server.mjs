/**
 * ChatSearch embedding relay. The extension's optional "cloud" semantic mode posts text here; this forwards
 * it to DeepInfra (Qwen3-Embedding-8B, truncated to 512 dims) with the operator's key and returns
 * base64 float32 vectors. Nothing is logged or stored except token counters.
 *
 * Abuse limits: a hard global monthly token cap, per-client and per-IP monthly and daily caps, input size
 * limits, and bounded upstream concurrency. Counters persist to DATA_DIR (a Railway volume) so a restart
 * cannot reset the month.
 *
 * Env: DEEPINFRA_API_KEY (required), PORT, DATA_DIR.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

// ------------------------------------------------------------------ config
const MODEL = 'Qwen/Qwen3-Embedding-8B';
const UPSTREAM = 'https://api.deepinfra.com/v1/openai/embeddings';
const DIMS = 512;
const QUERY_PREFIX = 'Instruct: Given a search query, retrieve relevant passages from past chat conversations\nQuery: ';
const MONTHLY_TOKEN_CAP = 1_000_000_000; // all users combined; about $10 at DeepInfra's price
const CLIENT_MONTHLY_CAP = 150_000_000; // one browser install (a 10k-chat history is roughly 50M tokens)
const CLIENT_DAILY_CAP = 60_000_000;
const IP_MONTHLY_CAP = 300_000_000;
const MAX_INPUTS = 128;
const MAX_DOC_CHARS = 6000;
const MAX_QUERY_CHARS = 1000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_INFLIGHT = 8;
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/data';
const KEY = process.env.DEEPINFRA_API_KEY;
if (!KEY) {
  console.error('DEEPINFRA_API_KEY is not set');
  process.exit(1);
}

// ------------------------------------------------------------------ usage accounting
const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);
let dataDir = DATA_DIR;
try {
  mkdirSync(dataDir, { recursive: true });
} catch {
  dataDir = './data';
  mkdirSync(dataDir, { recursive: true });
}
const FILE = join(dataDir, 'usage.json');
let usage = { month: month(), day: day(), total: 0, requests: 0, clients: {}, ips: {}, clientsDay: {} };
try {
  const u = JSON.parse(readFileSync(FILE, 'utf8'));
  if (u.month === usage.month) usage = { ...usage, ...u };
} catch {}
let dirty = false;
function roll() {
  if (usage.month !== month()) usage = { month: month(), day: day(), total: 0, requests: 0, clients: {}, ips: {}, clientsDay: {} };
  if (usage.day !== day()) {
    usage.day = day();
    usage.clientsDay = {};
  }
}
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    writeFileSync(FILE + '.tmp', JSON.stringify(usage));
    renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.error('usage save failed', e.message);
  }
}
setInterval(save, 15_000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    dirty = true;
    save();
    process.exit(0);
  });
}
// estimate before calling upstream (enforcement must not trust the bill), record the real count after
const estimate = (texts) => texts.reduce((a, t) => a + Math.ceil(t.length / 3.2) + 4, 0);
function overCap(client, ip, tokens) {
  roll();
  if (usage.total + tokens > MONTHLY_TOKEN_CAP) return 'The free cloud embedding budget for this month is used up. Switch to on-device search in settings; it works offline.';
  if ((usage.clients[client] || 0) + tokens > CLIENT_MONTHLY_CAP) return 'This install reached its monthly cloud embedding limit. On-device search still works.';
  if ((usage.clientsDay[client] || 0) + tokens > CLIENT_DAILY_CAP) return 'Daily cloud embedding limit reached; indexing resumes tomorrow.';
  if ((usage.ips[ip] || 0) + tokens > IP_MONTHLY_CAP) return 'Monthly cloud embedding limit reached for this network.';
  return null;
}
function record(client, ip, tokens) {
  usage.total += tokens;
  usage.requests++;
  usage.clients[client] = (usage.clients[client] || 0) + tokens;
  usage.clientsDay[client] = (usage.clientsDay[client] || 0) + tokens;
  usage.ips[ip] = (usage.ips[ip] || 0) + tokens;
  dirty = true;
}

// ------------------------------------------------------------------ upstream
let inflight = 0;
const waiters = [];
async function slot() {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return;
  }
  await new Promise((r) => waiters.push(r));
  inflight++;
}
function release() {
  inflight--;
  waiters.shift()?.();
}

async function embedUpstream(texts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float', dimensions: DIMS }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) {
      const j = await res.json();
      return { vectors: j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding), tokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens };
    }
    lastErr = `upstream ${res.status}`;
    if (res.status !== 0 && res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  throw new Error(lastErr);
}

/** Truncate to DIMS (Matryoshka) and L2-normalize, then pack as little-endian float32. */
function pack(vectors) {
  const out = new Float32Array(vectors.length * DIMS);
  vectors.forEach((v, i) => {
    let s = 0;
    for (let k = 0; k < DIMS; k++) s += v[k] * v[k];
    const inv = 1 / (Math.sqrt(s) || 1);
    for (let k = 0; k < DIMS; k++) out[i * DIMS + k] = v[k] * inv;
  });
  return Buffer.from(out.buffer).toString('base64');
}

// ------------------------------------------------------------------ http
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
function send(res, code, body) {
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return send(res, 200, { ok: true, service: 'chatsearch-relay', model: MODEL, dims: DIMS });
  if (req.method === 'GET' && url.pathname === '/v1/status') {
    roll();
    return send(res, 200, { month: usage.month, usedPct: Math.round((usage.total / MONTHLY_TOKEN_CAP) * 1000) / 10, model: MODEL, dims: DIMS });
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/embed') return send(res, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) return send(res, 413, { error: 'request too large' });
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { error: 'bad json' });
  }
  const isQuery = body.type === 'query';
  let input = Array.isArray(body.input) ? body.input : [];
  if (!input.length || input.length > MAX_INPUTS || !input.every((t) => typeof t === 'string')) return send(res, 400, { error: `input must be 1-${MAX_INPUTS} strings` });
  if (isQuery && input.length > 4) return send(res, 400, { error: 'too many queries' });
  input = input.map((t) => (t.trim() || ' ').slice(0, isQuery ? MAX_QUERY_CHARS : MAX_DOC_CHARS));
  if (isQuery) input = input.map((t) => QUERY_PREFIX + t);
  const client = typeof body.client === 'string' && /^[\w-]{8,64}$/.test(body.client) ? body.client : 'anon';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const est = estimate(input);
  const why = overCap(client, ip, est);
  if (why) return send(res, 429, { error: why });

  await slot();
  try {
    const { vectors, tokens } = await embedUpstream(input);
    if (vectors.length !== input.length || vectors.some((v) => !Array.isArray(v) || v.length < DIMS)) throw new Error('bad upstream shape');
    record(client, ip, tokens || est);
    send(res, 200, { data: pack(vectors), dims: DIMS, model: MODEL });
  } catch (e) {
    send(res, 502, { error: 'embedding service unavailable, try again shortly' });
    console.error('embed failed:', e.message);
  } finally {
    release();
  }
});
server.listen(PORT, () => console.log(`chatsearch relay on :${PORT}, data in ${dataDir}`));

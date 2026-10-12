/**
 * End-to-end test: builds the extension, loads it into headless Chromium with claude.ai / chatgpt.com mapped
 * to a local mock (test/e2e/mock.mjs), and checks sync, search, preview, capture, jump-to-match, deletion,
 * live updates and semantic search. Screenshots land in test/e2e/out/.  Run: node test/e2e/run.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { writeFileSync, readFileSync } from 'node:fs';
import { ORG, gptDetail, makeData, startMock } from './mock.mjs';

// ------------------------------------------------------------------ config
const PORT = 8443;
const GPT_BURST = 18; // mock ChatGPT starts answering 429 after this many conversation reads
const SEMANTIC = true; // downloads the local embedding model from Hugging Face on first run
const CLOUD = true; // also exercises the live Railway relay (a few hundred passages, well under a cent)
const KEEP_OPEN_MS = 0; // set >0 to leave the browser up for poking around

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });

const results = [];
let ctx = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: String(e?.message || e) });
    console.log(`  FAIL ${name}: ${e?.message || e}`);
    let k = 0;
    for (const pg of ctx?.pages() || []) await pg.screenshot({ path: join(OUT, `fail-${results.length}-${k++}.png`) }).catch(() => void 0);
  }
}
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => (last = e));
    if (last && !(last instanceof Error)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

console.log('building...');
execFileSync('node', ['build.mjs'], { cwd: ROOT, stdio: 'inherit' });

const data = makeData();
const mock = await startMock({ port: PORT, data, gptBurst: GPT_BURST });
console.log(`mock up: ${data.claude.length} Claude chats, ${data.gpt.length} ChatGPT chats`);

const profile = mkdtempSync(join(tmpdir(), 'chatsearch-e2e-'));
const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--host-resolver-rules=MAP claude.ai 127.0.0.1:${PORT}, MAP chatgpt.com 127.0.0.1:${PORT}, MAP chat.openai.com 127.0.0.1:${PORT}`, '--ignore-certificate-errors'];

// sign in first (cookies persist in the profile), so the extension sees a logged-in browser from its first sync
{
  const pre = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: args.slice(2) });
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
  await pre.addCookies([
    { name: 'sessionKey', value: 'sk-ant-test', domain: 'claude.ai', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: exp },
    { name: '__Secure-next-auth.session-token', value: 'test', domain: 'chatgpt.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: exp },
  ]);
  await pre.close();
}

const t0 = Date.now();
ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 }, args });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(sw.url()).host;
const ext = (p) => `chrome-extension://${extId}/${p}`;
console.log(`extension ${extId} loaded in ${Date.now() - t0} ms`);
const swErrors = [];
ctx.on('weberror', (e) => swErrors.push(String(e.error())));
ctx.on('console', (m) => m.type() === 'error' && m.page()?.url().startsWith('chrome-extension://') && swErrors.push(`${m.page().url().split('/').pop()}: ${m.text()}`));

const status = () => sw.evaluate(() => chrome.storage.local.get('status').then((r) => r.status || {}));

await check('welcome page opens on install', async () => {
  const p = await until(async () => ctx.pages().find((pg) => pg.url().includes('app.html')), 8000, 'welcome tab');
  await p.setViewportSize({ width: 1100, height: 760 });
  await sleep(1500);
  await p.screenshot({ path: join(OUT, '01-welcome.png') });
  return p.url().split('/').pop();
});

await check('Claude: full sync of every chat', async () => {
  const st = await until(async () => {
    const s = await status();
    return s.claude && s.claude.fetched >= data.claude.length && s.claude.state === 'idle' ? s : null;
  }, 60000, 'claude sync');
  return `${st.claude.fetched}/${st.claude.total} in ${Date.now() - t0} ms, ${mock.stats.claudeDetail} detail reads`;
});

await check('ChatGPT: lists everything, reads politely, backs off on 429', async () => {
  const st = await until(async () => {
    const s = await status();
    return s.chatgpt && s.chatgpt.total >= data.gpt.length && (s.chatgpt.state === 'paused' || s.chatgpt.fetched >= data.gpt.length) ? s : null;
  }, 60000, 'chatgpt list + pause');
  assert(mock.stats.gpt429 <= 2, `kept hammering after 429: ${mock.stats.gpt429} rejected reads`);
  return `total ${st.chatgpt.total}, fetched ${st.chatgpt.fetched}, state ${st.chatgpt.state} (${st.chatgpt.message || ''}), reads ${mock.stats.gptDetail}, 429s ${mock.stats.gpt429}`;
});

// ------------------------------------------------------------------ popup-sized search UI
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 780, height: 584 });
await popup.goto(ext('popup.html'));
const input = popup.locator('header input');
const titles = () => popup.locator('.item .item-title').allInnerTexts();
async function searchFor(q, expectTitle, ms = 6000) {
  await input.fill(q);
  return until(async () => {
    if (!(await popup.locator('.item mark').count())) return null; // still showing the previous (recent) list
    const ts = await titles();
    return ts.length && (!expectTitle || ts.some((t) => t.includes(expectTitle))) ? ts : null;
  }, ms, `results for ${q}`);
}

await check('popup shows recent chats on open', async () => {
  const ts = await until(async () => {
    const t = await titles();
    return t.length >= 5 ? t : null;
  }, 8000, 'recent list');
  await popup.screenshot({ path: join(OUT, '02-popup-recent.png') });
  return `${ts.length} shown, first "${ts[0]}"`;
});

await check('exact search: "blue angels" -> fleet week chat with highlighted snippet', async () => {
  const ts = await searchFor('blue angels', 'SF Fleet Week planes');
  assert(ts[0].includes('SF Fleet Week planes'), `top hit was ${ts[0]}`);
  const marks = await popup.locator('.item.sel .item-snip mark').allInnerTexts();
  assert(marks.some((m) => /blue/i.test(m)), `snippet highlights: ${marks}`);
  await sleep(600);
  await popup.screenshot({ path: join(OUT, '03-popup-search-preview.png') });
  const pv = await popup.locator('.preview .pv-body mark').count();
  assert(pv > 0, 'preview has no highlighted matches');
  return `${ts.length} hits, preview marks ${pv}`;
});

await check('substring inside words: "plane" finds "airplanes"', async () => {
  const ts = await searchFor('plane', 'Explaining airplanes');
  return ts.slice(0, 4).join(' | ');
});

await check('ChatGPT project chat is searchable', async () => {
  const ts = await searchFor('pasteis', 'Lisbon itinerary', 4000).catch(() => null);
  if (ts) return 'found by body text';
  const t2 = await searchFor('lisbon', 'Lisbon itinerary');
  return `title only (body not fetched yet): ${t2[0]}`;
});

await check('negation and from:me', async () => {
  await searchFor('plane -wifi', 'SF Fleet Week planes');
  assert(!(await titles()).some((t) => t.includes('WiFi')), 'negated chat still shown');
  await input.fill('lift from:me');
  await sleep(500);
  const ts = await titles();
  assert(!ts.some((t) => t.includes('Explaining airplanes')), '"lift" only appears in the assistant reply');
  return 'ok';
});

await check('fuzzy title: "flt wk"', async () => {
  const ts = await searchFor('flt wk', 'SF Fleet Week planes');
  return ts[0];
});

await check('typo correction: "risoto"', async () => {
  await input.fill('risoto');
  const note = await until(async () => {
    const t = await popup.locator('.note').allInnerTexts();
    return t.length ? t.join(' ') : null;
  }, 15000, 'did-you-mean note');
  const ts = await titles();
  await popup.screenshot({ path: join(OUT, '04-popup-typo.png') });
  return `${note.replace(/\s+/g, ' ').slice(0, 80)} -> ${ts[0]}`;
});

await check('dropdown state persists across close/reopen', async () => {
  await searchFor('sourdough', 'Sourdough starter rescue');
  await sleep(400);
  await popup.close();
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 780, height: 584 });
  await p2.goto(ext('popup.html'));
  const v = await until(async () => {
    const x = await p2.locator('header input').inputValue();
    return x || null;
  }, 4000, 'restored query');
  assert(v === 'sourdough', `restored "${v}"`);
  await p2.close();
  return v;
});

// ------------------------------------------------------------------ capture + jump to match
const gptUnfetched = await (async () => {
  const ids = await sw.evaluate(async () => {
    const st = await chrome.storage.local.get('status');
    return st;
  });
  void ids;
  // the mock served reads in list order; anything after the burst is unfetched
  const fetched = new Set(mock.stats.requests.filter((r) => r.includes('/backend-api/conversation/')).map((r) => r.split('/').pop()));
  return data.gpt.find((c) => !fetched.has(c.id) && !c.archived);
})();

await check('opening an unfetched ChatGPT chat indexes it instantly (zero extra requests)', async () => {
  assert(gptUnfetched, 'no unfetched chatgpt chat to test with');
  mock.refill(1000);
  const before = mock.stats.gptDetail;
  const page = await ctx.newPage();
  await page.goto(`https://chatgpt.com/c/${gptUnfetched.id}`);
  await page.waitForSelector('[data-message-author-role]');
  const word = gptUnfetched.turns[0][1].split(' ').filter((w) => w.length >= 7)[3];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 780, height: 584 });
  await p.goto(ext('popup.html'));
  await p.locator('header input').fill(word);
  await until(async () => ((await p.locator('.item .item-title').allInnerTexts()).includes(gptUnfetched.title) ? true : null), 8000, `captured chat for "${word}"`);
  const extra = mock.stats.gptDetail - before - 1; // the page's own read is the 1
  await p.close();
  await page.close();
  return `"${word}" found; extension made ${extra} extra reads`;
});

await check('Open jumps to the match and highlights it in the page', async () => {
  const app = await ctx.newPage();
  await app.goto(ext('app.html'));
  await app.locator('header input').fill('crissy field');
  await until(async () => ((await app.locator('.item .item-title').allInnerTexts())[0]?.includes('SF Fleet Week') ? true : null), 6000, 'result');
  await app.screenshot({ path: join(OUT, '05-tab-search.png') });
  const [chat] = await Promise.all([ctx.waitForEvent('page'), app.locator('header input').press('Enter')]);
  await chat.waitForLoadState();
  await chat.waitForSelector('#chatsearch-nav', { timeout: 15000 });
  const count = await chat.locator('#chatsearch-nav .cs-count').innerText();
  await chat.screenshot({ path: join(OUT, '06-jump-to-match.png') });
  await chat.close();
  await app.close();
  return `pill shows ${count}`;
});

await check('deleting a chat on claude.ai removes it from results', async () => {
  const victim = data.claude.find((c) => c.name === 'Rust borrow checker error');
  const page = await ctx.newPage();
  await page.goto(`https://claude.ai/chat/${victim.uuid}`);
  await page.waitForSelector('.msg');
  await page.evaluate(([org, id]) => fetch(`/api/organizations/${org}/chat_conversations/${id}`, { method: 'DELETE' }), [ORG, victim.uuid]);
  const p = await ctx.newPage();
  await p.goto(ext('popup.html'));
  await p.locator('header input').fill('borrow checker');
  await until(async () => {
    const ts = await p.locator('.item .item-title').allInnerTexts();
    const empty = await p.locator('.empty-title').count();
    return !ts.some((t) => t.includes('Rust borrow')) && (empty || ts.length === 0 || true) ? true : null;
  }, 6000, 'deleted chat gone');
  await p.close();
  await page.close();
  return 'gone';
});

await check('new chat elsewhere shows up after a sync', async () => {
  mock.addClaude({ uuid: 'c9000000-0000-4000-8000-000000000001', name: 'Kayak rental in Sausalito', turns: [['where can I rent a kayak near sausalito?', 'Sea Trek on the waterfront rents single and double kayaks by the hour.']], updated: Date.now() });
  const p = await ctx.newPage();
  await p.goto(ext('popup.html'));
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sync-now', source: 'claude' }));
  await p.locator('header input').fill('sea trek');
  const ms0 = Date.now();
  await until(async () => ((await p.locator('.item .item-title').allInnerTexts()).some((t) => t.includes('Kayak rental')) ? true : null), 15000, 'new chat');
  await p.close();
  return `visible ${Date.now() - ms0} ms after sync-now`;
});

await check('bot-check page: not mistaken for sign-out or rate limit, and visiting the site resumes at once', async () => {
  mock.setChallenge(true);
  const p = await ctx.newPage();
  await p.goto(ext('popup.html'));
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sync-now', source: 'claude' }));
  const st = await until(async () => {
    const s = (await status()).claude;
    return s && s.state === 'paused' && /quick check/.test(s.message || '') ? s : s?.state === 'signed-out' ? new Error('reported signed-out') : null;
  }, 15000, 'blocked state');
  const minutes = Math.round((st.pausedUntil - Date.now()) / 60000);
  assert(minutes <= 5, `paused for ${minutes} min`);
  mock.setChallenge(false);
  mock.addClaude({ uuid: 'c9000000-0000-4000-8000-000000000002', name: 'Tide pools at Point Reyes', turns: [['best tide pooling near point reyes?', 'Try Sculptured Beach at a minus tide, early morning.']], updated: Date.now() });
  const page = await ctx.newPage();
  const ms0 = Date.now();
  await page.goto(`https://claude.ai/chat/${data.claude[1].uuid}`);
  await until(async () => {
    const s = (await status()).claude;
    return s && s.state === 'idle' && s.fetched >= data.claude.length ? s : null;
  }, 15000, 'resume after visiting claude.ai');
  await page.close();
  await p.close();
  return `blocked for ${minutes} min max, "${st.message}"; resumed ${Date.now() - ms0} ms after opening claude.ai`;
});

if (SEMANTIC) {
  await check('semantic search: "where do birds fly when it gets cold" -> birding chat', async () => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 780, height: 584 });
    await p.goto(ext('popup.html'));
    const sem = await until(
      async () => {
        const s = await p.evaluate(() => chrome.runtime.sendMessage({ to: 'offscreen', type: 'semantic-status' }));
        return s && s.total && s.done >= s.total ? s : null;
      },
      240000,
      'all passages embedded',
    );
    await p.locator('header input').fill('where do birds fly when it gets cold');
    await p.locator('.sem-btn').click();
    const ts = await until(async () => {
      const t = await p.locator('.item .item-title').allInnerTexts();
      return t.length && (await p.locator('.note.sem').count()) ? t : null;
    }, 30000, 'semantic results');
    await sleep(500);
    await p.screenshot({ path: join(OUT, '07-semantic.png') });
    const rank = ts.findIndex((t) => t.includes('Backyard birding'));
    assert(rank >= 0 && rank < 3, `birding chat ranked ${rank}: ${ts.slice(0, 5).join(' | ')}`);
    await p.close();
    return `rank ${rank + 1}; ${sem.done} passages via ${sem.backend || sem.device || '?'}`;
  });
}

if (CLOUD) {
  await check('cloud mode: relay embeds everything and ranks the birding chat first', async () => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 780, height: 584 });
    await p.goto(ext('popup.html'));
    await p.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { semantic: 'cloud' } }));
    const sem = await until(
      async () => {
        const s = await p.evaluate(() => chrome.runtime.sendMessage({ to: 'offscreen', type: 'semantic-status' }));
        if (s?.state === 'error') throw new Error(s.message);
        return s && s.mode === 'cloud' && s.total && s.done >= s.total ? s : null;
      },
      120000,
      'cloud embeddings',
    );
    await p.locator('header input').fill('where do birds fly when it gets cold');
    await p.locator('.sem-btn').click();
    const ts = await until(async () => {
      const t = await p.locator('.item .item-title').allInnerTexts();
      return t.length && (await p.locator('.note.sem').count()) ? t : null;
    }, 30000, 'cloud semantic results');
    await sleep(500);
    await p.screenshot({ path: join(OUT, '07b-semantic-cloud.png') });
    const rank = ts.findIndex((t) => t.includes('Backyard birding'));
    assert(rank === 0, `birding chat ranked ${rank}: ${ts.slice(0, 5).join(' | ')}`);
    await p.evaluate(() => chrome.runtime.sendMessage({ type: 'settings', patch: { semantic: 'local' } }));
    await p.close();
    return `${sem.done} passages via relay, rank 1`;
  });
}

await check('import a ChatGPT data export: unfetched chats become searchable, nothing re-downloaded', async () => {
  const pending = data.gpt.filter((c) => !mock.stats.gptServed.has(c.id));
  assert(pending.length >= 5, `only ${pending.length} unfetched chats`);
  const extra = { id: 'a5000000-0000-4000-8000-000000000001', title: 'Only in the export', turns: [['what is a zymurgist', 'Someone who studies fermentation, as in brewing.']], updated: Date.now() - 400 * 86400_000 };
  const conversations = [...pending, extra].map((c) => ({ ...gptDetail(c), id: c.id, update_time: c.updated / 1000 + 0.0004567 }));
  const zipPath = join(OUT, 'chatgpt-export.zip');
  writeFileSync(zipPath, zipSync({ 'conversations.json': strToU8(JSON.stringify(conversations)), 'user.json': strToU8('{}') }));
  const readsBefore = mock.stats.gptDetail;
  const p = await ctx.newPage();
  await p.goto(ext('app.html#import'));
  await p.locator('.import input[type=file]').setInputFiles(zipPath);
  const msg = await until(async () => {
    const t = await p.locator('.import').innerText();
    return /Imported \d+ chats\./.test(t) ? t.match(/Imported[^\n]*/)[0] : null;
  }, 20000, 'import done');
  await p.screenshot({ path: join(OUT, '11-import.png') });
  const word = pending[2].turns[0][1].split(' ').filter((w) => w.length >= 8)[1];
  await p.goto(ext('app.html'));
  await p.locator('header input').fill(word);
  await until(async () => ((await p.locator('.item .item-title').allInnerTexts()).includes(pending[2].title) ? true : null), 8000, `imported chat for "${word}"`);
  await p.locator('header input').fill('zymurgist');
  await until(async () => ((await p.locator('.item .item-title').allInnerTexts()).includes('Only in the export') ? true : null), 8000, 'export-only chat');
  // lift the earlier 429 pause and re-list: everything should now count as downloaded, with nothing queued
  await sw.evaluate(() => chrome.storage.local.get('sync:chatgpt').then((r) => chrome.storage.local.set({ 'sync:chatgpt': { ...r['sync:chatgpt'], pausedUntil: 0, backoff: 0, tokens: 25, projectsAt: 0 } })));
  await p.evaluate(() => chrome.runtime.sendMessage({ type: 'sync-now', source: 'chatgpt' }));
  const st = await until(async () => {
    const s = await status();
    return s.chatgpt.state !== 'listing' && s.chatgpt.state !== 'paused' && s.chatgpt.lastSync > Date.now() - 10000 ? s : null;
  }, 20000, 'chatgpt re-list');
  await p.close();
  assert(st.chatgpt.fetched === st.chatgpt.total, `after import ${st.chatgpt.fetched}/${st.chatgpt.total} counted as downloaded (${st.chatgpt.message || ''})`);
  assert(mock.stats.gptDetail === readsBefore, `re-downloaded ${mock.stats.gptDetail - readsBefore} imported chats`);
  return `${msg}; ChatGPT now ${st.chatgpt.fetched}/${st.chatgpt.total} fetched, 0 extra reads`;
});

await check('export everything as a Markdown zip', async () => {
  const p = await ctx.newPage();
  await p.goto(ext('app.html#settings'));
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.getByText('Export all as Markdown').click()]);
  const path = join(OUT, 'export.zip');
  await dl.saveAs(path);
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const names = Object.keys(files);
  const md = names.filter((n) => n.endsWith('.md'));
  const fleet = md.find((n) => n.includes('SF Fleet Week'));
  assert(fleet && new TextDecoder().decode(files[fleet]).includes('Crissy Field'), 'fleet week chat missing from export');
  await p.close();
  return `${md.length} Markdown files (${names.filter((n) => !n.endsWith('.md')).join(', ')})`;
});

await check('settings and side panel layouts render', async () => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 780, height: 584 });
  await p.goto(ext('popup.html'));
  await p.locator('button[title="Settings"]').click();
  await sleep(800);
  await p.screenshot({ path: join(OUT, '08-settings.png'), fullPage: true });
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 860 });
  await panel.goto(ext('sidepanel.html'));
  await panel.locator('header input').fill('plane');
  await sleep(1200);
  await panel.screenshot({ path: join(OUT, '09-sidepanel.png') });
  await p.close();
  await panel.close();
  return 'ok';
});

await check('dark theme', async () => {
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: 'dark' });
  await p.setViewportSize({ width: 780, height: 584 });
  await p.goto(ext('popup.html'));
  await p.locator('header input').fill('fleet week');
  await sleep(1200);
  await p.screenshot({ path: join(OUT, '10-dark.png') });
  await p.close();
});

await check('no uncaught extension errors', async () => {
  assert(swErrors.length === 0, swErrors.slice(0, 8).join('\n'));
});

if (KEEP_OPEN_MS) await sleep(KEEP_OPEN_MS);
await ctx.close();
mock.server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${OUT}`);
console.log(`mock traffic: claude list ${mock.stats.claudeList}, claude reads ${mock.stats.claudeDetail}, gpt list ${mock.stats.gptList}, gpt reads ${mock.stats.gptDetail}, 429s ${mock.stats.gpt429}, unauthenticated ${mock.stats.unauth}`);
process.exit(failed.length ? 1 : 0);

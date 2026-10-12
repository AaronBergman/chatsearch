/**
 * Marketing screenshots: loads the extension against the mock sites filled with a made-up but realistic
 * chat history, then captures retina screenshots of the main views into assets/screens/.
 * Run: node test/e2e/demo.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startMock } from './mock.mjs';

// ------------------------------------------------------------------ config
const PORT = 8444;
const SCALE = 2;
const WAIT_FOR_EMBEDDINGS_MS = 240_000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'assets/screens');
mkdirSync(OUT, { recursive: true });

const H = 3600_000;
const D = 24 * H;
const now = Date.now();
let seq = 0;
const id = (p) => `${p}${(++seq).toString(16).padStart(7, '0')}-1111-4111-8111-${seq.toString(16).padStart(12, '0')}`;

const claude = [
  {
    name: 'Sourdough hydration for a beginner',
    ago: 2 * H,
    turns: [
      ['I keep getting dense, gummy sourdough. My recipe is 500g flour, 400g water, 100g starter, 10g salt. What am I doing wrong?', "At 80% hydration you're working with a fairly wet dough, which is hard to handle as a beginner and often reads as **gummy** if it's underproofed or cut too early.\n\nThree things to try, in order:\n\n1. **Drop hydration to 70%** (350g water). It's far more forgiving while you learn the feel of the dough.\n2. **Proof by feel, not the clock.** Bulk fermentation is done when the dough has grown about 50%, is domed, jiggly, and shows bubbles on the sides of the container.\n3. **Wait at least 2 hours before slicing.** The crumb is still setting as it cools; cutting early makes even a perfect loaf gummy.\n\nIf it's still dense after that, your starter may be weak: it should double within 4 to 6 hours of feeding."],
      ['how do I know if my starter is strong enough?', 'Feed it 1:1:1 and mark the jar. A healthy starter doubles in 4 to 6 hours at room temperature, smells pleasantly sour, and a spoonful floats in water at its peak.'],
    ],
  },
  {
    name: 'Fleet Week viewing spots',
    ago: 9 * H,
    turns: [['Is it too late to see the planes at SF Fleet Week this weekend?', "Not too late. The air show runs Friday through Sunday, and the **Blue Angels** fly last each afternoon, usually around 3 pm.\n\nGood viewing spots:\n\n- **Marina Green**: the classic spot, centered on the show box, very crowded.\n- **Crissy Field**: more room to spread out, great views of the Golden Gate.\n- **Aquatic Park**: a bit off-center but easy to reach by cable car."]],
  },
  {
    name: 'Rust: borrow checker in a loop',
    ago: 1.3 * D,
    turns: [['```rust\nfor item in &self.items {\n    self.total += item.price;\n}\n```\ncannot borrow `*self` as mutable because it is also borrowed as immutable', 'You are holding an immutable borrow of `self.items` for the whole loop while also mutating `self.total`. Split the borrow or compute first:\n\n```rust\nlet total: u64 = self.items.iter().map(|i| i.price).sum();\nself.total += total;\n```\n\nRust can see that `self.items` and `self.total` are different fields when you borrow them directly, but not through a method on `self`.']],
  },
  {
    name: 'Explaining compound interest to a 12 year old',
    ago: 2.1 * D,
    turns: [['how do I explain compound interest to my kid?', "Try the snowball: a small snowball rolling downhill picks up snow, and the bigger it gets, the more snow it picks up each turn. Money that earns interest works the same way, because next year's interest is paid on this year's interest too."]],
  },
  {
    name: 'Lease clause about normal wear and tear',
    ago: 3 * D,
    turns: [['Can my landlord charge me for repainting after a 3 year tenancy?', 'Usually not in California. Repainting after several years is generally treated as **normal wear and tear**, which cannot be deducted from a security deposit. Ask for an itemized statement within 21 days of move-out; that is required by Civil Code 1950.5.']],
  },
  {
    name: 'Postgres slow query with ORDER BY and LIMIT',
    ago: 4 * D,
    turns: [['SELECT * FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20 takes 2 seconds on 40M rows', 'Create a composite index that matches both the filter and the sort:\n\n```sql\nCREATE INDEX CONCURRENTLY events_user_created_idx\n  ON events (user_id, created_at DESC);\n```\n\nWith that index Postgres can walk the newest 20 rows for one user directly instead of sorting everything that matches.']],
  },
  {
    name: 'Backyard birding: who leaves in winter',
    ago: 6 * D,
    turns: [['which songbirds leave the bay area when it gets cold?', 'Many warblers, swallows and flycatchers head south to Mexico and Central America, while juncos, kinglets and white-crowned sparrows arrive from the north and mountains to spend the winter here.']],
  },
  {
    name: 'Packing list for a week in Lisbon',
    ago: 9 * D,
    turns: [['packing list for lisbon in november', 'Layers and comfortable shoes with grip: the calçada sidewalks get slippery in the rain. Bring a light rain shell, a warm sweater for evenings, and a small day bag for the tram.']],
  },
  {
    name: 'Negotiating a job offer',
    ago: 14 * D,
    turns: [['how do I ask for more equity without sounding greedy?', 'Anchor on the role, not on need: "Given the scope we discussed, I was hoping the equity would be closer to X. Is there flexibility there?" Then stop talking and let them respond.']],
  },
  { name: 'Regex for ISO dates', ago: 20 * D, turns: [['regex for YYYY-MM-DD', '`^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$`']] },
];

const gpt = [
  {
    title: 'Plane WiFi travel router setup',
    ago: 5 * H,
    turns: [["I'm about to go on a plane and want to share the wifi with my laptop and phone", 'A small travel router works well: connect it to the in-flight network, log in once through the captive portal, and your other devices join the router instead. Most airlines only see one device.']],
  },
  {
    title: 'Sourdough starter smells like acetone',
    ago: 1.6 * D,
    turns: [['my sourdough starter smells like nail polish remover', 'That acetone smell means it is hungry. Discard most of it and feed at a 1:5:5 ratio twice a day for a few days until it smells yeasty again.']],
  },
  {
    title: 'RSU taxes at vesting',
    ago: 5 * D,
    turns: [['how are RSUs taxed when they vest?', 'As ordinary income at vest, based on the fair market value that day; your cost basis for later capital gains is that same value.']],
  },
  {
    title: 'Three days in Lisbon',
    ago: 8 * D,
    project: true,
    turns: [['three days in Lisbon in November, what should I prioritize?', 'Day 1: Alfama on foot and the castle. Day 2: tram 28 early, then Belém and pastéis de nata. Day 3: a day trip to Sintra.']],
  },
  { title: 'Kubernetes CrashLoopBackOff debugging', ago: 11 * D, turns: [['pod stuck in CrashLoopBackOff', 'Start with `kubectl logs <pod> --previous` to see why the last container exited, then `kubectl describe pod` for OOMKilled or failed probes.']] },
  { title: 'Best way to store fresh herbs', ago: 16 * D, turns: [['how do I keep cilantro fresh', 'Trim the stems and stand it in a jar of water in the fridge with a bag loosely over the top. Change the water every couple of days.']] },
];

const fillerTitles = ['Quarterly OKR draft', 'Bike tire pressure', 'Python asyncio timeouts', 'Wedding toast ideas', 'Explaining CRISPR', 'Tax-loss harvesting', 'Japanese knife sharpening', 'React useEffect cleanup', 'Running a 10k plan', 'Home espresso grind size', 'Moving checklist', 'SQL window functions', 'Houseplant yellow leaves', 'Learning Spanish fast', 'Cover letter edit', 'Chess opening for beginners'];

const data = { claude: [], gpt: [] };
for (const c of claude) data.claude.push({ uuid: id('c'), name: c.name, turns: c.turns, updated: now - c.ago });
for (const c of gpt) data.gpt.push({ id: id('a'), title: c.title, turns: c.turns, updated: now - c.ago, project: c.project ? 'g-p-6788aa11bb22cc33dd44ee55ff667788' : undefined });
fillerTitles.forEach((t, i) => {
  const turns = [[`Help me with: ${t.toLowerCase()}`, `Here is a short, practical answer about ${t.toLowerCase()}, with the key steps first and the caveats after.`]];
  if (i % 2) data.claude.push({ uuid: id('c'), name: t, turns, updated: now - (22 + i * 3) * D });
  else data.gpt.push({ id: id('a'), title: t, turns, updated: now - (21 + i * 3) * D });
});
data.claude.sort((a, b) => b.updated - a.updated);
data.gpt.sort((a, b) => b.updated - a.updated);

execFileSync('node', ['build.mjs'], { cwd: ROOT, stdio: 'ignore' });
const mock = await startMock({ port: PORT, data });
const profile = mkdtempSync(join(tmpdir(), 'chatsearch-demo-'));
const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--host-resolver-rules=MAP claude.ai 127.0.0.1:${PORT}, MAP chatgpt.com 127.0.0.1:${PORT}`, '--ignore-certificate-errors'];
{
  const pre = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: args.slice(2) });
  const exp = Math.floor(Date.now() / 1000) + 86400;
  await pre.addCookies([
    { name: 'sessionKey', value: 'x', domain: 'claude.ai', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: exp },
    { name: '__Secure-next-auth.session-token', value: 'x', domain: 'chatgpt.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: exp },
  ]);
  await pre.close();
}
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, deviceScaleFactor: SCALE, args });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const ext = (p) => `chrome-extension://${new URL(sw.url()).host}/${p}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wait for every chat to be downloaded and embedded
const page = await ctx.newPage();
await page.setViewportSize({ width: 780, height: 584 });
await page.goto(ext('popup.html'));
const t0 = Date.now();
for (;;) {
  const st = await sw.evaluate(() => chrome.storage.local.get('status').then((r) => r.status || {}));
  const sem = await page.evaluate(() => chrome.runtime.sendMessage({ to: 'offscreen', type: 'semantic-status' }));
  const synced = st.claude?.fetched >= data.claude.length && st.chatgpt?.fetched >= data.gpt.length;
  if (synced && sem?.total && sem.done >= sem.total) break;
  if (Date.now() - t0 > WAIT_FOR_EMBEDDINGS_MS) {
    console.log('giving up waiting', JSON.stringify({ st, sem }));
    break;
  }
  await sleep(1000);
}
// a few searches so "Recent" history has content
for (const q of ['sourdough', 'blue angels', 'postgres index']) {
  await page.evaluate((q) => chrome.storage.local.get('history').then((r) => chrome.storage.local.set({ history: [{ q, t: Date.now() }, ...(r.history || [])] })), q);
}
await page.reload();
await sleep(1200);
await page.screenshot({ path: join(OUT, 'popup-recent.png') });

const input = page.locator('header input');
await input.fill('sourdough');
await sleep(1500);
await page.screenshot({ path: join(OUT, 'popup-search.png') });

await input.fill('blue angels');
await sleep(1500);
await page.screenshot({ path: join(OUT, 'popup-exact.png') });

await input.fill('where do birds go when it gets cold');
await sleep(400);
await page.locator('.sem-btn').click();
await sleep(4000);
await page.screenshot({ path: join(OUT, 'popup-semantic.png') });

await page.emulateMedia({ colorScheme: 'dark' });
await input.fill('lisbon');
await sleep(1500);
await page.screenshot({ path: join(OUT, 'popup-dark.png') });
await page.emulateMedia({ colorScheme: 'light' });

const panel = await ctx.newPage();
await panel.setViewportSize({ width: 400, height: 640 });
await panel.goto(ext('sidepanel.html'));
await panel.locator('header input').fill('sourdough');
await sleep(1500);
await panel.screenshot({ path: join(OUT, 'sidepanel.png') });

await page.locator('header input').fill('');
await page.locator('button[title="Settings"]').click();
await sleep(1000);
await page.screenshot({ path: join(OUT, 'settings.png') });

// jump to match inside the (mock) chat page
const app = await ctx.newPage();
await app.goto(ext('app.html'));
await app.locator('header input').fill('crissy field');
await sleep(1200);
const [chat] = await Promise.all([ctx.waitForEvent('page'), app.locator('header input').press('Enter')]);
await chat.setViewportSize({ width: 820, height: 520 });
await chat.waitForSelector('#chatsearch-nav', { timeout: 15000 }).catch(() => void 0);
await sleep(1200);
await chat.screenshot({ path: join(OUT, 'jump-to-match.png') });

await ctx.close();
mock.server.close();
console.log(`screenshots in ${OUT}`);

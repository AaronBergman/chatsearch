/** Renders the 1200x630 social card (assets/og.png) from the icon and a demo screenshot. Run: node assets/render_og.mjs */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const b64 = (p) => readFileSync(join(HERE, p)).toString('base64');
const icon = b64('icon512.png');
const shot = b64('screens/popup-search.png');

const html = `<!doctype html><html><head><style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:radial-gradient(1200px 700px at 0% 0%,#f1f0ff 0%,#fbfbfe 55%,#eef0fb 100%);color:#16161d;position:relative}
.text{position:absolute;left:70px;top:92px;width:470px}
.brand{display:flex;align-items:center;gap:16px;font-size:30px;font-weight:700}
.brand img{width:64px;height:64px;border-radius:15px;box-shadow:0 8px 24px rgba(91,91,214,.35)}
h1{font-size:54px;line-height:1.05;letter-spacing:-.025em;margin:34px 0 18px}
h1 mark{background:linear-gradient(transparent 58%,#ffe27a 58%);color:inherit}
p{font-size:23px;line-height:1.4;color:#5d5f6e;margin:0}
.shot{position:absolute;left:590px;top:70px;width:780px;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(40,40,110,.22),0 3px 12px rgba(40,40,110,.1);border:1px solid #e6e6f0;background:#fff}
.shot img{display:block;width:100%}
</style></head><body>
<div class="text"><div class="brand"><img src="data:image/png;base64,${icon}">ChatSearch</div>
<h1>Real search for <mark>Claude</mark> and <mark>ChatGPT</mark></h1>
<p>Every word of every chat, as you type. Typo tolerant, search by meaning, indexed in your own browser.</p></div>
<div class="shot"><img src="data:image/png;base64,${shot}"></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: join(HERE, 'og.png') });
await browser.close();
console.log('wrote assets/og.png');

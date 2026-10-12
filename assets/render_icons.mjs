// Render assets/icon.svg to extension/icons/*.png (and a 512 for the landing page).
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const svg = readFileSync('assets/icon.svg', 'utf8');
mkdirSync('extension/icons', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const s of [16, 32, 48, 128, 512]) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  await page.screenshot({ path: s === 512 ? 'assets/icon512.png' : `extension/icons/icon${s}.png`, omitBackground: true });
}
await browser.close();
console.log('icons rendered');

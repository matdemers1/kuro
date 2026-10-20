// Render the PWA icons from apps/web/public/icons/kuro.svg with Playwright's Chromium.
// Run once after changing the SVG: node scripts/render-icons.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../e2e/node_modules/@playwright/test/index.mjs';

const dir = join(import.meta.dirname, '../apps/web/public/icons');
const svg = readFileSync(join(dir, 'kuro.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const fonts = '<link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@800&text=苦&display=block" rel="stylesheet">';
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['maskable-512.png', 512]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><head>${fonts}<style>html,body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style></head><body>${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, name), omitBackground: false });
}
await browser.close();
console.log('icons rendered');

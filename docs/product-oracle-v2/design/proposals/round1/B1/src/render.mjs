// Renders the six frames. Run from a dir where `playwright` resolves.
import { chromium } from 'playwright';
import path from 'node:path';
const dir = process.argv[2];
const frames = [
  ['home', 'light', 'desktop'], ['home', 'dark', 'desktop'], ['home', 'light', 'mobile'],
  ['requests', 'light', 'desktop'], ['prd-review', 'light', 'desktop'], ['roadmap', 'light', 'desktop'],
];
const b = await chromium.launch();
for (const [page, scheme, dev] of frames) {
  const mobile = dev === 'mobile';
  const ctx = await b.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto('file://' + path.join(dir, page + '.html'));
  await p.waitForLoadState('networkidle'); await p.evaluate(() => document.fonts.ready);
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  if (mobile) await p.setViewportSize({ width: 390, height: h });
  // report anything clipped: text wider than its box
  const clipped = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map(e => e.textContent.trim().slice(0, 40)));
  const small = await p.evaluate(() => [...new Set([...document.querySelectorAll('body *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent !== null && parseFloat(getComputedStyle(e).fontSize) < 13).map(e => e.textContent.trim().slice(0, 30) + ' ' + getComputedStyle(e).fontSize))]);
  const name = `${page}-${scheme}-${dev}`;
  await p.screenshot({ path: path.join(dir, name + '.png'), fullPage: true });
  console.log(name, 'height', h, 'scrollW', sw, clipped.length ? 'CLIPPED ' + JSON.stringify(clipped) : '', small.length ? 'SMALL ' + JSON.stringify(small) : '');
  await ctx.close();
}
await b.close();

// Renders the six frames. Usage: node render.js <html dir> <png dir>
const { chromium } = require('/tmp/pw/node_modules/playwright');
const path = require('path');
const [dir, out] = process.argv.slice(2);
const frames = [
  ['home-light-desktop', 'home.html', 'light', 1440],
  ['home-dark-desktop', 'home.html', 'dark', 1440],
  ['home-light-mobile', 'home.html', 'light', 390],
  ['requests-light-desktop', 'requests.html', 'light', 1440],
  ['prd-review-light-desktop', 'prd-review.html', 'light', 1440],
  ['roadmap-light-desktop', 'roadmap.html', 'light', 1440],
];
(async () => {
  const b = await chromium.launch();
  for (const [name, file, scheme, w] of frames) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, deviceScaleFactor: w < 500 ? 2 : 1 });
    const p = await ctx.newPage();
    await p.goto('file://' + path.resolve(dir, file), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    const h = await p.evaluate(() => document.documentElement.scrollHeight);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (w < 500) await p.setViewportSize({ width: w, height: h });
    const fold = await p.evaluate(() => Math.max(...[...document.querySelectorAll('.bento > .tile')].map(e => e.getBoundingClientRect().bottom)));
    // text overflow check: any element whose content is wider than its box
    const over = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && e.textContent.trim() && (e.scrollWidth > e.clientWidth + 1) && getComputedStyle(e).overflow !== 'visible').map(e => e.textContent.trim().slice(0, 40)));
    const small = await p.evaluate(() => [...new Set([...document.querySelectorAll('body *')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent !== null && parseFloat(getComputedStyle(e).fontSize) < 13).map(e => e.tagName + ':' + e.textContent.trim().slice(0, 20)))]);
    const tileOver = await p.evaluate(() => [...document.querySelectorAll('.tile')].filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map(e => e.className + ' ' + (e.scrollHeight - e.clientHeight)));
    if (tileOver.length) console.log('  TILE OVERFLOW', tileOver);
    await p.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
    console.log(name, { pageHeight: h, scrollWidth: sw, tilesBottom: fold, overflow: over, under13px: small });
    await ctx.close();
  }
  await b.close();
})();

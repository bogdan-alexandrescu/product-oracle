// Renders the six frames. Run from /tmp/pw (playwright installed there) or with NODE_PATH.
const { chromium } = require('playwright');
const path = require('path');
const DIR = path.resolve(__dirname, '..');
const frames = [
  ['home', 'home-light-desktop', 'light', 1440, 900],
  ['home', 'home-dark-desktop', 'dark', 1440, 900],
  ['home', 'home-light-mobile', 'light', 390, 844],
  ['requests', 'requests-light-desktop', 'light', 1440, 900],
  ['prd-review', 'prd-review-light-desktop', 'light', 1440, 900],
  ['roadmap', 'roadmap-light-desktop', 'light', 1440, 900],
];
(async () => {
  const b = await chromium.launch();
  for (const [page, name, scheme, w, h] of frames) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto('file://' + path.join(DIR, page + '.html'));
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
    if (w < 700) await p.setViewportSize({ width: w, height: m.sh });
    await p.screenshot({ path: path.join(DIR, name + '.png'), fullPage: true });
    console.log(name, JSON.stringify(m));
    await ctx.close();
  }
  await b.close();
})();

// Renders the six frames and runs checks (min font size, clipped text, horizontal scroll).
const { chromium } = require('playwright');
const path = require('path');
const F = [
  ['home', 'light', 'desktop'], ['home', 'dark', 'desktop'], ['home', 'light', 'mobile'],
  ['requests', 'light', 'desktop'], ['prd-review', 'light', 'desktop'], ['roadmap', 'light', 'desktop'],
];
(async () => {
  const b = await chromium.launch();
  for (const [p, theme, dev] of F) {
    const mobile = dev === 'mobile';
    const ctx = await b.newContext({ viewport: { width: mobile ? 390 : 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    const pg = await ctx.newPage();
    await pg.goto('file://' + path.join(__dirname, p + '.html'), { waitUntil: 'networkidle' });
    await pg.evaluate(() => document.fonts.ready);
    await pg.waitForTimeout(400);
    const h = await pg.evaluate(() => document.documentElement.scrollHeight);
    if (mobile) await pg.setViewportSize({ width: 390, height: h });
    const issues = await pg.evaluate(() => {
      const out = [];
      const fonts = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + f.weight);
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('hscroll ' + document.documentElement.scrollWidth);
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || el.closest('svg') && el.tagName !== 'text') continue;
        const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (hasText && parseFloat(cs.fontSize) < 13) out.push('small ' + cs.fontSize + ' ' + el.className + ' ' + el.textContent.trim().slice(0, 30));
        if (hasText && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push('clip ' + el.tagName + '.' + el.className + ' ' + el.scrollWidth + '>' + el.clientWidth + ' ' + el.textContent.trim().slice(0, 40));
      }
      return { out, fonts: [...new Set(fonts)] };
    });
    const name = `${p}-${theme}-${dev}`;
    await pg.screenshot({ path: path.join(__dirname, name + '.png'), fullPage: true });
    console.log(name, 'height', h, JSON.stringify(issues));
    await ctx.close();
  }
  await b.close();
})();

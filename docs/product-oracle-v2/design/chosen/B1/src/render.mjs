// Renders every frame: nine screens light and dark at 1440x900, four on the phone (390 wide, light).
// Run from a dir where `playwright` resolves: node render.mjs <B1 dir> [screen ...]
import { chromium } from 'playwright';
import path from 'node:path';
const dir = process.argv[2];
const only = process.argv.slice(3);
const screens = ['home', 'requests', 'baseline', 'idea-interview', 'prd-review', 'priorities', 'roadmap', 'runs', 'publish'];
const phone = ['home', 'idea-interview', 'prd-review', 'roadmap'];
const frames = [];
for (const s of screens) { frames.push([s, 'light', 'desktop'], [s, 'dark', 'desktop']); if (phone.includes(s)) frames.push([s, 'light', 'mobile']); }
const b = await chromium.launch();
for (const [page, scheme, dev] of frames) {
  if (only.length && !only.includes(page)) continue;
  const mobile = dev === 'mobile';
  const ctx = await b.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto('file://' + path.join(dir, 'html', page + '.html'));
  await p.waitForLoadState('networkidle'); await p.evaluate(() => document.fonts.ready);
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  if (mobile) await p.setViewportSize({ width: 390, height: h });
  const report = await p.evaluate(() => {
    const els = [...document.querySelectorAll('body *')].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    const texty = e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    // truncated text (ellipsis) and clipped text
    const clipped = els.filter(e => texty(e) && e.scrollWidth > e.clientWidth && getComputedStyle(e).overflow !== 'visible').map(e => e.textContent.trim().slice(0, 40));
    const small = [...new Set(els.filter(e => texty(e) && parseFloat(getComputedStyle(e).fontSize) < 13).map(e => e.textContent.trim().slice(0, 30) + ' ' + getComputedStyle(e).fontSize))];
    // rows that wrapped to a second line: .tr rows whose text cells are taller than one line
    const wrapped = [...document.querySelectorAll('.tr:not(.head) .t, .tr .txt, .ig .grow, .ilist .grow')].filter(e => e.offsetParent && e.getClientRects().length && e.getBoundingClientRect().height > 30 && getComputedStyle(e).whiteSpace !== 'nowrap').map(e => e.textContent.trim().slice(0, 40));
    const below = [...document.querySelectorAll('.panel,.insp')].filter(e => e.getBoundingClientRect().bottom > 900).length;
    return { clipped, small, wrapped, below };
  });
  const name = `${page}-${scheme}-${dev}`;
  await p.screenshot({ path: path.join(dir, name + '.png'), fullPage: true });
  console.log(name, 'h', h, 'sw', sw, report.clipped.length ? 'ELLIPSIS ' + JSON.stringify(report.clipped) : '', report.small.length ? 'SMALL ' + JSON.stringify(report.small) : '', report.wrapped.length ? 'WRAP ' + JSON.stringify(report.wrapped) : '', !mobile && report.below ? 'BELOW900 ' + report.below : '');
  await ctx.close();
}
await b.close();

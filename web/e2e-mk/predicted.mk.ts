// MOCK-HOOK file: snapshots the mk-predicted mock-up frames (static HTML + PNG), never run in CI.
import fs from 'node:fs';
import path from 'node:path';

import { test, type Page } from '@playwright/test';

import { login } from '../e2e/helpers';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-predicted');
const FR = `${OUT}/frames`;
const AS = `${OUT}/assets`;
fs.mkdirSync(FR, { recursive: true });
fs.mkdirSync(AS, { recursive: true });
const ONLY = process.env.MK_ONLY; // e.g. "pc1-a"

async function snap(page: Page, name: string, opts: { dark?: boolean } = {}) {
  await page.waitForTimeout(400);
  const vp = page.viewportSize()!;
  await page.screenshot({ path: `${FR}/${name}.png` });
  if (opts.dark) {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${FR}/${name}-dark.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  }
  const got = await page.evaluate(() => {
    const css = [...document.styleSheets]
      .map((ss) => {
        try {
          return [...ss.cssRules].map((r) => r.cssText).join('\n');
        } catch {
          return '';
        }
      })
      .join('\n');
    document.querySelectorAll('input,textarea').forEach((i) => i.setAttribute('value', (i as HTMLInputElement).value));
    document.querySelectorAll('select').forEach((s) => s.querySelectorAll('option').forEach((o) => (o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected'))));
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll('script,link,style,meta,title').forEach((n) => n.remove());
    root.removeAttribute('data-theme');
    return { css, body: root.querySelector('body')!.outerHTML, attrs: [...root.attributes].map((a) => `${a.name}="${a.value}"`).join(' ') };
  });
  let css = got.css;
  const urls = [...new Set([...css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\)/g)].map((m) => m[1]))];
  for (const u of urls) {
    const file = path.basename(u.split('?')[0]);
    if (!fs.existsSync(`${AS}/${file}`)) {
      const r = await page.request.get(new URL(u, page.url()).toString());
      if (r.ok()) fs.writeFileSync(`${AS}/${file}`, await r.body());
    }
    css = css.split(u).join(`../assets/${file}`);
  }
  const html = `<!doctype html>
<html ${got.attrs} data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${vp.width}">
<meta name="mockup-viewport" content="${vp.width}x${vp.height}">
<title>${name}</title>
<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);})();</script>
<style>${css}</style>
</head>
${got.body}
</html>`;
  fs.writeFileSync(`${FR}/${name}.html`, html);
}

const D = { width: 1440, height: 900 };
const W = { width: 1512, height: 982 };
const P = { width: 390, height: 844 };
const mark = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    (el as HTMLElement).style.outline = '2px solid var(--accent)';
    (el as HTMLElement).style.outlineOffset = '2px';
    (el as HTMLElement).style.textDecoration = 'underline';
  });

type Story = {
  id: string;
  path: string; // page and switches
  card: string; // the goal card selector
  opener: string; // the control
  pre?: (page: Page) => Promise<void>; // between open and mid (e.g. a tip)
  mid?: (page: Page) => Promise<void>;
  cost: string;
  hardOpen?: boolean;
};
const GM = '[data-testid="gm-goal"]:has-text("Paid conversions")';
const RM = '[data-testid="goal-counter"]:has-text("Paid conversions")';
const POPD = '[data-testid="pm-pop"] [data-testid="pm-driver"]';

const STORIES: Story[] = [
  { id: 'pc1-a', path: '/simple/goals?pc1=a', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, cost: '1 click opens the dates, 1 more opens the feature that sets them. Today: not shown anywhere.' },
  { id: 'pc1-b', path: '/simple/roadmap?pc1=b', card: RM, opener: `${RM} [data-testid="pm-goal-open"]`, cost: '1 click opens the weeks, 1 more opens the feature. Today: not shown anywhere.' },
  { id: 'pc1-c', path: '/simple/goals?pc1=c', card: '[data-testid="gm-strip"]', opener: '[data-testid="pm-slip"]:has-text("+9")', cost: '1 click per milestone, 1 more opens the feature; the goal itself has no line. Today: not shown.' },
  { id: 'pc2-a', path: '/simple/goals?pc2=a', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, pre: async (p) => { await p.locator('[data-testid="pm-pop"] [data-testid="pm-why"]').click(); }, cost: '1 click, then the (i) for why: 2 clicks. Today: the word "at risk" only.' },
  { id: 'pc2-b', path: '/simple/goals?pc2=b', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, pre: async (p) => { await p.locator('[data-testid="pm-pop"] [data-testid="pm-why"]').click(); }, cost: '0 clicks to read the range on the card; 2 clicks for why. Today: the word "at risk" only.' },
  { id: 'pc2-c', path: '/simple/goals?pc2=c', card: GM, opener: `${GM} [data-testid="pm-goal"] button`, cost: '1 click on the tick to read any date at all, 1 more for the feature. Today: the word "at risk" only.' },
  { id: 'pc3-a', path: '/simple/goals?pc3=a', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, cost: '1 click shows all four milestones, 1 more opens the feature. No scrolling at 1512 or 390.' },
  { id: 'pc3-b', path: '/simple/goals?pc3=b', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, cost: '1 click; each of the 20 features is a tick, the one that sets the date is thick and named.' },
  { id: 'pc3-c', path: '/simple/goals?pc3=c', card: GM, opener: `${GM} [data-testid="pm-goal-open"]`, mid: async (p) => { await p.locator('[data-testid="pm-all"]').click(); await mark(p, '[data-testid="pm-ranked"] [data-testid="pm-driver"]'); }, cost: '1 click, 1 to show all 20, 1 to open the feature: 3 clicks.' },
];

async function go(page: Page, url: string, size: { width: number; height: number }, card: string) {
  await page.setViewportSize(size);
  await page.goto(url);
  await page.locator(card).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

test('mk-predicted frames', async ({ page }) => {
  await page.setViewportSize(D);
  await login(page);
  for (const s of STORIES) {
    if (ONLY && !s.id.startsWith(ONLY)) continue;
    const big = s.id.startsWith('pc3') ? '&mkdata=big' : '';
    // at rest
    await go(page, s.path + big, D, s.card);
    if (s.path.includes('roadmap')) await page.evaluate(() => window.scrollTo(0, 0));
    await snap(page, `${s.id}-rest`);
    // the control opened
    await page.locator(s.opener).first().click();
    await page.locator('[data-testid="pm-pop"]').waitFor();
    if (s.pre) await s.pre(page);
    await snap(page, `${s.id}-open`);
    // mid-interaction: the pointer on the feature that sets the date
    if (s.mid) await s.mid(page);
    else await mark(page, POPD);
    await snap(page, `${s.id}-mid`);
    // the result: that feature's own panel
    await page.goto(s.path + big + `&mkcost=${encodeURIComponent(s.cost)}`);
    await page.locator(s.card).first().waitFor();
    await page.waitForTimeout(1200);
    await page.locator(s.opener).first().click();
    if (s.mid) await page.locator('[data-testid="pm-all"]').click();
    await page.locator(s.mid ? '[data-testid="pm-ranked"] [data-testid="pm-driver"]' : POPD).first().click();
    await page.waitForTimeout(1500);
    await snap(page, `${s.id}-result`);
    // the hard case at the owner's window: twenty features, four milestones, light and dark
    await go(page, `${s.path}&mkdata=big`, W, s.card);
    await page.locator(s.opener).first().click();
    await page.waitForTimeout(300);
    await snap(page, `${s.id}-hard-1512`, { dark: true });
    // the phone
    await go(page, `${s.path}${big}`, P, s.card);
    await page.locator(s.opener).first().scrollIntoViewIfNeeded();
    await page.locator(s.opener).first().click();
    await page.waitForTimeout(300);
    await snap(page, `${s.id}-open-390`, { dark: s.id.startsWith('pc3') });
  }
});

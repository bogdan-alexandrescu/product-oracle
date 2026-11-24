// MOCK-HOOK: whole file. mk-palette (#1794): drives each proposal as a person would and saves every
// frame as static html (inlined css, no scripts, fonts in ../assets, ?theme= hook) plus a PNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { test, type Page } from '../e2e/test';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-palette/frames');
mkdirSync(OUT, { recursive: true });
const PASS = ['de', 'mo'].join('');
const D = { width: 1512, height: 945 };
const W = { width: 1512, height: 945 };
const P = { width: 390, height: 844 };
const ONLY = process.env.MK_ONLY ?? '';

async function snap(page: Page, name: string, size: { width: number; height: number }) {
  await page.waitForTimeout(700);
  const html = await page.evaluate(
    ({ w, h }) => {
      document.querySelectorAll('input,textarea').forEach((el) => {
        const e = el as HTMLInputElement;
        if (e.type === 'checkbox' || e.type === 'radio') {
          if (e.checked) e.setAttribute('checked', '');
          else e.removeAttribute('checked');
        } else e.setAttribute('value', e.value);
      });
      document.querySelectorAll('select').forEach((s) =>
        [...s.options].forEach((o) => (o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected'))),
      );
      document.querySelectorAll<HTMLElement>('*').forEach((el) => {
        if (el.scrollTop > 0) el.setAttribute('data-mk-scroll', String(el.scrollTop));
      });
      const css = [...document.styleSheets]
        .map((ss) => {
          try {
            return [...ss.cssRules].map((r) => r.cssText).join('\n');
          } catch {
            return '';
          }
        })
        .join('\n')
        .replace(/url\(["']?\/fonts\/([^"')]+)["']?\)/g, 'url("../assets/$1")');
      const root = document.documentElement.cloneNode(true) as HTMLElement;
      root.querySelectorAll('script,link[rel=stylesheet],link[rel=modulepreload],style,link[rel=preload]').forEach((n) => n.remove());
      root.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') ?? 'light');
      const head = root.querySelector('head')!;
      head.insertAdjacentHTML(
        'afterbegin',
        `<meta charset="utf-8"><meta name="mockup-viewport" content="${w}x${h}"><style>${css}</style>` +
          `<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){e.scrollTop=+e.getAttribute('data-mk-scroll')})})})()</script>`,
      );
      const y = window.scrollY;
      return '<!doctype html>\n' + root.outerHTML.replace('</body>', y ? `<script>scrollTo(0,${y})</script></body>` : '</body>');
    },
    { w: size.width, h: size.height },
  );
  writeFileSync(path.join(OUT, `${name}.html`), html);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  // the same frame in dark (the html opens in dark with ?theme=dark)
  const was = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, `${name}-dark.png`) });
  await page.evaluate((t) => (t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme')), was);
}

async function start(page: Page, email: string, to: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(to);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
}
const key = (page: Page) => page.keyboard.press('Control+k');
async function type(page: Page, text: string) {
  await page.getByTestId('mk-palette-input').pressSequentially(text, { delay: 20 });
  await page.waitForTimeout(300);
}

const ADMIN = 'admin@example.com';
const COMMENTER = 'commenter@example.com';
const VIEWER = 'viewer@example.com';
async function relog(page: Page, email: string, to: string, size: { width: number; height: number }) {
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.context().clearCookies();
  await start(page, email, to, size);
}

const COST_FIND = (n: string) => encodeURIComponent(n);

// ---------- CP1: how it opens and looks (CP2 = find and do, CP3 = rail entry) ----------
for (const o of ['a', 'b', 'c']) {
  test(`cp1-${o}`, async ({ page }) => {
    test.skip(!!ONLY && !`cp1-${o}`.startsWith(ONLY));
    const q = `cp1=${o}&cp2=b&cp3=a`;
    const today = ' · today: open Roadmap, scroll the timeline, find the row, click it (4 steps and a scroll)';
    const cost = COST_FIND(
      (o === 'a'
        ? '3 steps: ⌘K, “weekly alert”, Enter; the sheet covers the page middle while open'
        : o === 'b'
          ? '3 steps: ⌘K, “weekly alert”, Enter; the page stays readable, but each row has less room'
          : '3 steps: ⌘K, “weekly alert”, Enter; each row is twice as tall, so fewer show') + today,
    );
    await start(page, ADMIN, `/simple?${q}`, D);
    await snap(page, `cp1-${o}-rest`, D);
    await key(page);
    await snap(page, `cp1-${o}-open`, D);
    await type(page, 'weekly alert');
    await snap(page, `cp1-${o}-mid`, D);
    await page.goto(`/simple?${q}&cost=${cost}`);
    await page.waitForTimeout(1200);
    await key(page);
    await type(page, 'weekly alert');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    await snap(page, `cp1-${o}-result`, D);
    // hard case: 60 more features with long names, at the owner's 1512 window.
    await page.setViewportSize(W);
    await page.goto(`/simple/roadmap?${q}&many=1&cost=`);
    await page.waitForTimeout(1500);
    await key(page);
    await type(page, 'alerts');
    await snap(page, `cp1-${o}-hard-1512`, W);
    // Detailed: the same palette over the other shell
    await page.goto(`/home?${q}&many=0&cost=`);
    await page.waitForTimeout(1800);
    await key(page);
    await type(page, 'billing');
    await snap(page, `cp1-${o}-detailed-open-1512`, W);
    await page.setViewportSize(P);
    await page.goto(`/simple?${q}&many=0`);
    await page.waitForTimeout(1500);
    await page.getByTestId('mk-entry-phone').click();
    await type(page, 'alert');
    await snap(page, `cp1-${o}-phone-390`, P);
  });
}

// ---------- CP2: what it finds and does (CP1 = centered sheet, CP3 = rail entry) ----------
const CP2: Record<string, { mid: string; cost: string; hardQ: string }> = {
  a: {
    mid: 'f-79',
    cost: '3 steps: ⌘K, “f-79”, Enter; the panel opens on this page · today: 4 steps and a scroll on Roadmap',
    hardQ: 'quiet hours',
  },
  b: {
    mid: 'new Quiet hours for alerts',
    cost: '3 steps: ⌘K, “new Quiet hours for alerts”, Enter; it goes on the roadmap and track used last · today: open Roadmap, pick a roadmap, pick a track, type the title, New item (5 steps)',
    hardQ: 'new Quiet hours for alerts',
  },
  c: {
    mid: 'weekly alert',
    cost: '3 steps, then you are on Roadmap: ⌘K, “weekly alert”, Enter · today: 4 steps and a scroll',
    hardQ: 'quiet hours',
  },
};
for (const o of ['a', 'b', 'c']) {
  test(`cp2-${o}`, async ({ page }) => {
    test.skip(!!ONLY && !`cp2-${o}`.startsWith(ONLY));
    const q = `cp1=a&cp2=${o}&cp3=a&many=0&cost=`;
    const s = CP2[o];
    await start(page, ADMIN, `/simple?${q}`, D);
    await key(page);
    await snap(page, `cp2-${o}-open`, D);
    await type(page, s.mid);
    await snap(page, `cp2-${o}-mid`, D);
    await page.goto(`/simple?cp2=${o}&cost=${COST_FIND(s.cost)}`);
    await page.waitForTimeout(1200);
    await key(page);
    await type(page, s.mid);
    await page.keyboard.press('Enter');
    // b: wait out the 10 s Added toast so the result shows the page, not a message over it
    await page.waitForTimeout(o === 'b' ? 11500 : 2000);
    await snap(page, `cp2-${o}-result`, D);
    if (o === 'b') {
      // a feature's own actions: Tab on the selected feature
      await page.goto(`/simple?cp2=b&cost=`);
      await page.waitForTimeout(1200);
      await key(page);
      await type(page, 'f-79');
      await page.keyboard.press('Tab');
      await snap(page, `cp2-${o}-tab`, D);
    }
    // phone, the same owner
    await page.setViewportSize(P);
    await page.goto(`/simple?${q}`);
    await page.waitForTimeout(1500);
    await page.getByTestId('mk-entry-phone').click();
    await page.waitForTimeout(300);
    await snap(page, `cp2-${o}-phone-390`, P);
    // hard case: a commenter, at 1512
    await relog(page, COMMENTER, `/simple?${q}`, W);
    await key(page);
    await type(page, s.hardQ);
    await snap(page, `cp2-${o}-commenter-1512`, W);
    // a viewer, at 1512
    await relog(page, VIEWER, `/simple?${q}`, W);
    await key(page);
    await snap(page, `cp2-${o}-viewer-1512`, W);
  });
}

// ---------- CP3: reaching it without a keyboard (CP1 = centered sheet, CP2 = find and do) ----------
for (const o of ['a', 'b', 'c']) {
  test(`cp3-${o}`, async ({ page }) => {
    test.skip(!!ONLY && !`cp3-${o}`.startsWith(ONLY));
    const q = `cp1=a&cp2=b&cp3=${o}&many=0`;
    const today = ' · today: no way in without a keyboard; open the page and look by eye';
    const cost =
      (o === 'a'
        ? '1 tap on Find in the rail, then the same box; no room taken on the page'
        : o === 'b'
          ? '1 tap on the field above every page; a slim bar on every page'
          : '1 tap on the round button; it sits over the page corner') + today;
    await start(page, ADMIN, `/simple?${q}&cost=`, D);
    await snap(page, `cp3-${o}-rest`, D);
    await page.getByTestId('mk-entry').first().click();
    await page.waitForTimeout(300);
    await snap(page, `cp3-${o}-open`, D);
    await type(page, 'sign-ups per rep');
    await snap(page, `cp3-${o}-mid`, D);
    await page.goto(`/simple?${q}&cost=${COST_FIND(cost)}`);
    await page.waitForTimeout(1200);
    await page.getByTestId('mk-entry').first().click();
    await type(page, 'sign-ups per rep');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    await snap(page, `cp3-${o}-result`, D);
    // hard case: Detailed, whose rail is narrow, at 1512
    await page.setViewportSize(W);
    await page.goto(`/home?${q}&cost=`);
    await page.waitForTimeout(2000);
    await snap(page, `cp3-${o}-detailed-1512`, W);
    await page.setViewportSize(P);
    await page.goto(`/simple/roadmap?${q}`);
    await page.waitForTimeout(2000);
    await snap(page, `cp3-${o}-phone-390`, P);
    const entry = o === 'a' ? page.getByTestId('mk-entry-phone') : page.getByTestId('mk-entry').first();
    await entry.click();
    await page.waitForTimeout(300);
    await snap(page, `cp3-${o}-phone-open-390`, P);
  });
}

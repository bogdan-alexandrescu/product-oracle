// MOCK-HOOK: this whole file captures the mk-panel-edit mock-up frames (throwaway branch).
// Run: swarm-test-browsers npx playwright test -c scripts/mk-panel-edit/capture.config.ts frames
// with the mock app served on :4173 (npm run build:mock && npm run start:mock -- --port 4173).
// ONLY=pe1 (or pe1-b) captures one decision or proposal.
import fs from 'node:fs';
import path from 'node:path';

import { test, type Page } from '@playwright/test';

import { stableUuid } from '../../lib/api/mock/ids';

const OUT = path.resolve(__dirname, '../../../mockups-out/mk-panel-edit');
const FR = path.join(OUT, 'frames');
const AS = path.join(OUT, 'assets');
fs.mkdirSync(FR, { recursive: true });
fs.mkdirSync(AS, { recursive: true });
const fonts = new Map<string, string>();

let itemId = '';
let seed = '';
async function login(page: Page) {
  await page.goto('/login?next=%2Fhome');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill(['de', 'mo'].join(''));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/home$/);
}

async function open(page: Page, qs: string, w: number, h: number, theme = 'light') {
  await page.setViewportSize({ width: w, height: h });
  // Each frame starts from the same seeded data (the mock keeps its data in localStorage).
  await page.evaluate(
    ([t, db]) => {
      localStorage.setItem('oracle-theme', t);
      if (db) localStorage.setItem('po-mock-db-v2', db);
    },
    [theme, seed],
  );
  await page.goto(`/simple/roadmap?${qs}&item=${itemId}`);
  await page.locator('[data-testid="floating-card"][data-pe]').waitFor({ timeout: 15000 });
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
  await page.waitForTimeout(500);
}

async function snap(page: Page, file: string, w: number, h: number) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(FR, `${file}.png`) });
  const { html, urls } = await page.evaluate(
    ({ w, h }) => {
      document.querySelectorAll('input, textarea').forEach((el) => {
        const i = el as HTMLInputElement;
        i.setAttribute('value', i.value);
      });
      document.querySelectorAll('details').forEach((d) => (d.open ? d.setAttribute('open', '') : d.removeAttribute('open')));
      document.querySelectorAll('*').forEach((el) => {
        if (el.scrollTop || el.scrollLeft) el.setAttribute('data-mk-scroll', `${el.scrollLeft},${el.scrollTop}`);
      });
      let css = '';
      for (const s of Array.from(document.styleSheets)) {
        try {
          css += Array.from(s.cssRules).map((r) => r.cssText).join('\n') + '\n';
        } catch {
          /* cross-origin */
        }
      }
      const urls = Array.from(css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf))["']?\)/g)).map((m) => m[1]);
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach((e) => e.remove());
      const head = doc.querySelector('head')!;
      const meta = document.createElement('meta');
      meta.name = 'mockup-viewport';
      meta.content = `${w}x${h}`;
      head.prepend(meta);
      const st = document.createElement('style');
      st.textContent = css;
      head.append(st);
      return { html: '<!doctype html>\n' + doc.outerHTML, urls };
    },
    { w, h },
  );
  let out = html;
  for (const u of new Set(urls)) {
    if (!fonts.has(u)) {
      const name = path.basename(u.split('?')[0]);
      const r = await page.request.get(new URL(u, page.url()).toString());
      if (r.ok()) fs.writeFileSync(path.join(AS, name), await r.body());
      fonts.set(u, `../assets/${name}`);
    }
    out = out.split(u).join(fonts.get(u)!);
  }
  // The ?theme=light|dark hook and the saved scroll places; nothing else runs.
  const hook = `<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){var p=e.getAttribute('data-mk-scroll').split(',');e.scrollLeft=+p[0];e.scrollTop=+p[1];});});})();</script>`;
  out = out.replace('</head>', `${hook}</head>`);
  fs.writeFileSync(path.join(FR, `${file}.html`), out);
}

const D = { w: 1440, h: 900 };
const W = { w: 1512, h: 982 };
const P = { w: 390, h: 844 };
const want = (k: string) => !process.env.ONLY || k.startsWith(process.env.ONLY);

/** Opens the Ends field the proposal's way. */
async function openEnds(page: Page, m: string) {
  if (m === 'c') await page.getByTestId('pe-edit').click();
  if (m === 'd') await page.keyboard.press('e');
  else await page.getByTestId('pe-input-end').click();
}
async function typeEnds(page: Page) {
  const i = page.getByTestId('pe-input-end');
  await i.fill('Dec 4');
}
async function saveEnds(page: Page, m: string) {
  await page.keyboard.press('Enter');
  if (m === 'c') {
    await page.getByTestId('pe-input-owner').click();
    await page.getByTestId('pe-opt-Mira Okafor').click();
    await page.getByTestId('pe-done').click();
  }
}

test('frames', async ({ page }) => {
  await login(page);
  itemId = stableUuid('simple-item/alert-rules');
  await page.goto('/simple/roadmap');
  await page.waitForTimeout(1500);
  seed = await page.evaluate(() => localStorage.getItem('po-mock-db-v2') ?? '');

  for (const m of ['a', 'b', 'c', 'd']) {
    const k = `pe1-${m}`;
    if (!want(k)) continue;
    const qs = `pe1=${m}&pe2=a&pe3=a`;
    await open(page, qs, D.w, D.h);
    await snap(page, `${k}-rest`, D.w, D.h);
    await openEnds(page, m);
    await snap(page, `${k}-open`, D.w, D.h);
    await typeEnds(page);
    await snap(page, `${k}-mid`, D.w, D.h);
    await saveEnds(page, m);
    await snap(page, `${k}-saved`, D.w, D.h);
    // The cost of the other common tasks: set the owner and add a milestone.
    if (m === 'd') {
      await page.getByTestId('pe-cmd').fill('owner mira');
      await page.getByTestId('pe-cmd').press('Enter');
      await snap(page, `${k}-owner`, D.w, D.h);
    } else if (m !== 'c') {
      await page.getByTestId('pe-input-milestone').click();
      await page.getByTestId('pe-new-milestone').fill('Pilot with 3 teams · Dec 18');
      await snap(page, `${k}-milestone`, D.w, D.h);
    }
    await open(page, `${qs}&hard=1`, W.w, W.h);
    if (m === 'c') await page.getByTestId('pe-edit').click();
    await page.getByTestId('pe-field-deps').scrollIntoViewIfNeeded();
    await snap(page, `${k}-hard-1512`, W.w, W.h);
    await open(page, qs, P.w, P.h);
    await openEnds(page, m);
    await typeEnds(page);
    await snap(page, `${k}-mid-390`, P.w, P.h);
    await open(page, qs, D.w, D.h, 'dark');
    await openEnds(page, m);
    await typeEnds(page);
    await saveEnds(page, m);
    await snap(page, `${k}-saved-dark`, D.w, D.h);
  }
  {
    const k = 'pe1-a';
    if (want(k)) {
      await open(page, `pe1=a&pe2=a&pe3=a&hard=1&viewer=1`, W.w, W.h);
      await snap(page, `${k}-viewer-1512`, W.w, W.h);
    }
  }

  for (const o of ['a', 'b', 'c']) {
    const k = `pe2-${o}`;
    if (!want(k)) continue;
    const qs = `pe1=a&pe2=${o}&pe3=a`;
    await open(page, qs, D.w, D.h);
    await snap(page, `${k}-rest`, D.w, D.h);
    await open(page, `${qs}&hover=owner`, D.w, D.h);
    await snap(page, `${k}-hover`, D.w, D.h);
    await page.getByTestId('pe-input-owner').click();
    await page.getByTestId('pe-opt-Jonah Reyes').click();
    await page.getByTestId('pe-input-end').click();
    await page.getByTestId('pe-input-end').fill('Dec 4');
    await page.keyboard.press('Enter');
    await snap(page, `${k}-changed`, D.w, D.h);
    await open(page, `${qs}&hard=1`, W.w, W.h);
    await snap(page, `${k}-hard-1512`, W.w, W.h);
    await open(page, qs, P.w, P.h);
    await snap(page, `${k}-rest-390`, P.w, P.h);
    await open(page, qs, D.w, D.h, 'dark');
    await snap(page, `${k}-rest-dark`, D.w, D.h);
  }

  for (const f of ['a', 'b', 'c']) {
    const k = `pe3-${f}`;
    if (!want(k)) continue;
    const qs = `pe1=a&pe2=a&pe3=${f}`;
    await open(page, qs, D.w, D.h);
    await snap(page, `${k}-rest`, D.w, D.h);
    if (f === 'c') {
      await page.getByTestId('pe-flags-badge').click();
      await snap(page, `${k}-open`, D.w, D.h);
    }
    await page.getByTestId('pe-fix-owner-0').click();
    await snap(page, `${k}-owner-fixed`, D.w, D.h);
    if (f === 'c' && !(await page.getByTestId('pe-strip').count())) await page.getByTestId('pe-flags-badge').click();
    await page.getByTestId('pe-fix-dates').click();
    if (f === 'c' && !(await page.getByTestId('pe-strip').count())) await page.getByTestId('pe-flags-badge').click();
    await page.getByTestId('pe-fix-link').click();
    await snap(page, `${k}-all-fixed`, D.w, D.h);
    await open(page, `${qs}&hard=1&viewer=1`, W.w, W.h);
    if (f === 'c') await page.getByTestId('pe-flags-badge').click();
    await snap(page, `${k}-viewer-1512`, W.w, W.h);
    await open(page, qs, P.w, P.h);
    if (f === 'c') await page.getByTestId('pe-flags-badge').click();
    await snap(page, `${k}-rest-390`, P.w, P.h);
    await open(page, qs, D.w, D.h, 'dark');
    if (f === 'c') await page.getByTestId('pe-flags-badge').click();
    await snap(page, `${k}-rest-dark`, D.w, D.h);
  }

  // Today, for the hand-off: the Change link opens a field with Save and Cancel.
  if (want('today')) {
    await page.setViewportSize({ width: D.w, height: D.h });
    await page.evaluate((db) => { localStorage.setItem('oracle-theme', 'light'); localStorage.setItem('po-mock-db-v2', db); }, seed);
    await page.goto(`/simple/roadmap?item=${itemId}`);
    await page.getByTestId('floating-card').waitFor();
    await page.waitForTimeout(600);
    await snap(page, 'today-rest', D.w, D.h);
    await page.getByRole('button', { name: /^Change/ }).nth(3).click();
    await snap(page, 'today-change', D.w, D.h);
  }
});

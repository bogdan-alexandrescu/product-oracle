// MOCK-HOOK: this whole file captures the mk-panel-edit mock-up frames (throwaway branch).
// Run: swarm-test-browsers npx playwright test -c scripts/mk-panel-edit/capture.config.ts frames
// with the mock app served on :4173 (npm run build:mock && npm run start:mock -- --port 4173).
// ONLY=pe1 (or pe1-b) captures one decision or proposal.
import fs from 'node:fs';
import path from 'node:path';

import { test, type Browser, type Page } from '@playwright/test';

import { stableUuid } from '../../lib/api/mock/ids';

const OUT = path.resolve(__dirname, '../../../mockups-out/mk-panel-edit');
const FR = path.join(OUT, 'frames');
const AS = path.join(OUT, 'assets');
fs.mkdirSync(FR, { recursive: true });
fs.mkdirSync(AS, { recursive: true });
const fonts = new Map<string, string>();

let itemId = '';
let seed = '';
async function login(page: Page, email = 'admin@example.com') {
  await page.goto('/login?next=%2Fhome');
  await page.getByLabel('Email').fill(email);
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
  await markRow(page);
  // The page's place at rest, kept for the rest of the story (see snap).
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollTop) (el as HTMLElement).dataset.mkS = String(el.scrollTop);
    });
    (window as unknown as { mkY: number }).mkY = window.scrollY;
    const row = document.querySelector('[data-mk-row]');
    (window as unknown as { mkRow: number }).mkRow = row ? row.getBoundingClientRect().top : NaN;
  });
}
/** The page's open row, by the item's id (its bar or its label). */
async function markRow(page: Page) {
  await page.evaluate((id) => {
    const el = document.querySelector(`[data-bar-id="${id}"]`) ?? document.querySelector(`[data-item-id="${id}"]`);
    el?.setAttribute('data-mk-row', '');
  }, itemId);
}
/** Scrolls the panel's own body (not the page) so the field sits in its middle. */
async function scrollCard(page: Page, id: string) {
  await page.getByTestId(id).evaluate((el) => {
    let body = el.parentElement;
    while (body && !(body.scrollHeight > body.clientHeight + 1 && /auto|scroll|hidden/.test(getComputedStyle(body).overflowY))) body = body.parentElement;
    if (!body) return;
    const d = el.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop += d - body.clientHeight * 0.4 + el.getBoundingClientRect().height / 2;
  });
}
/** Lets the earlier toasts go before a frame that must show what they covered. */
async function clearToasts(page: Page) {
  for (let i = 0; i < 6; i++) {
    const b = page.locator('[aria-label="Dismiss"]');
    if (!(await b.count())) break;
    await b.first().click();
    await page.waitForTimeout(250);
  }
}

async function snap(page: Page, file: string, w: number, h: number, free = false) {
  await page.waitForTimeout(350);
  // Every frame of a story shows the page at the same place (free: a frame scrolled to its result).
  if (!free) await page.evaluate(() => {
    const card = document.querySelector('[data-testid="floating-card"]');
    document.querySelectorAll('*').forEach((el) => {
      if (card?.contains(el)) return;
      const at = (el as HTMLElement).dataset.mkS;
      if (at != null || el.scrollTop) el.scrollTop = Number(at ?? 0);
    });
    window.scrollTo(0, (window as unknown as { mkY: number }).mkY ?? 0);
    // Banners added above (after a change) push the Roadmap down: keep the open row where it was at rest.
    const row = document.querySelector('[data-mk-row]');
    const at = (window as unknown as { mkRow: number }).mkRow;
    if (row && !Number.isNaN(at)) {
      const d = row.getBoundingClientRect().top - at;
      if (Math.abs(d) > 1) {
        let sc: Element | null = row.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc && !card?.contains(sc)) sc.scrollTop += d;
        else window.scrollBy(0, d);
      }
    }
  });
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
const W = { w: 1512, h: 900 };
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

test('frames', async ({ page, browser }) => {
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
    // A flag acted on in place: the owner (C already set it in Edit, so it takes Oracle's dates).
    if (m === 'd') {
      await page.getByTestId('pe-cmd').fill('owner mira');
      await page.getByTestId('pe-cmd').press('Enter');
      await snap(page, `${k}-owner`, D.w, D.h);
    } else {
      await page.getByTestId(m === 'c' ? 'pe-fix-dates' : 'pe-fix-owner-0').click();
      await snap(page, `${k}-flag`, D.w, D.h);
    }
    // A milestone added from the panel.
    {
      await clearToasts(page);
      if (m === 'c') await page.getByTestId('pe-edit').click();
      await page.getByTestId('pe-input-milestone').click();
      await page.getByTestId('pe-new-milestone').fill('Pilot with 3 teams · Dec 18');
      await snap(page, `${k}-milestone`, D.w, D.h);
      await page.getByTestId('pe-new-milestone').press('Enter');
      if (m === 'c') await page.getByTestId('pe-done').click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(1200);
      await snap(page, `${k}-milestone-added`, D.w, D.h);
    }
    // A feature added: typed under Needed by, placed after this one by its link (no drag).
    await clearToasts(page);
    if (m === 'c') await page.getByTestId('pe-edit').click();
    await page.getByTestId('pe-plus-needed').click();
    await page.getByTestId('pe-add-needed').fill('Alert sound picker');
    await scrollCard(page, 'pe-add-needed');
    await snap(page, `${k}-add`, D.w, D.h);
    await page.getByTestId('pe-add-needed').press('Enter');
    if (m === 'c') await page.getByTestId('pe-done').click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1500);
    await scrollCard(page, 'pe-field-needed');
    await snap(page, `${k}-added`, D.w, D.h);
    await open(page, `${qs}&hard=1`, W.w, W.h);
    if (m === 'c') await page.getByTestId('pe-edit').click();
    await snap(page, `${k}-hard-1512`, W.w, W.h);
    await open(page, `${qs}&hard=1`, W.w, W.h, 'dark');
    if (m === 'c') await page.getByTestId('pe-edit').click();
    await snap(page, `${k}-hard-1512-dark`, W.w, W.h);
    for (const t of ['light', 'dark']) {
      await open(page, qs, P.w, P.h, t);
      const sfx = t === 'dark' ? '-dark' : '';
      if (m === 'b') {
        await snap(page, `${k}-rest-390${sfx}`, P.w, P.h);
        continue;
      }
      await openEnds(page, m === 'd' ? 'a' : m);
      await typeEnds(page);
      await snap(page, `${k}-mid-390${sfx}`, P.w, P.h);
    }
    await open(page, qs, D.w, D.h, 'dark');
    await openEnds(page, m);
    await typeEnds(page);
    await saveEnds(page, m);
    await snap(page, `${k}-saved-dark`, D.w, D.h);
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
    await snap(page, `${k}-mid`, D.w, D.h);
    await page.getByTestId('pe-opt-Jonah Reyes').click();
    await page.getByTestId('pe-input-end').click();
    await page.getByTestId('pe-input-end').fill('Dec 4');
    await page.keyboard.press('Enter');
    await page.mouse.move(5, 5);
    await snap(page, `${k}-changed`, D.w, D.h);
    // The built fields, folded under More; Notes grows as it is typed.
    await page.getByTestId('pe-more').locator('summary').click();
    await page.getByTestId('pe-input-notes').click();
    await page.getByTestId('pe-input-notes').pressSequentially('Ask two pilot teams which alerts they mute. ');
    await page.keyboard.press('Shift+Enter');
    await page.getByTestId('pe-input-notes').pressSequentially('Keep quiet hours per team, not per person.');
    await page.getByTestId('pe-input-notes').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await snap(page, `${k}-more`, D.w, D.h, true);
    await open(page, `${qs}&hard=1`, W.w, W.h);
    await snap(page, `${k}-hard-1512`, W.w, W.h);
    await open(page, `${qs}&hard=1`, W.w, W.h, 'dark');
    await snap(page, `${k}-hard-1512-dark`, W.w, W.h);
    await open(page, qs, P.w, P.h);
    await snap(page, `${k}-rest-390`, P.w, P.h);
    await open(page, qs, P.w, P.h, 'dark');
    await snap(page, `${k}-rest-390-dark`, P.w, P.h);
    await open(page, qs, D.w, D.h, 'dark');
    await snap(page, `${k}-rest-dark`, D.w, D.h);
  }

  for (const f of ['a', 'b', 'c']) {
    const k = `pe3-${f}`;
    if (!want(k)) continue;
    const qs = `pe1=a&pe2=a&pe3=${f}`;
    const strip = async () => {
      if (f === 'c' && !(await page.getByTestId('pe-strip').count())) await page.getByTestId('pe-flags-badge').click();
    };
    await open(page, qs, D.w, D.h);
    await snap(page, `${k}-rest`, D.w, D.h);
    if (f === 'c') {
      await page.getByTestId('pe-flags-badge').click();
      await snap(page, `${k}-open`, D.w, D.h);
    }
    await page.getByTestId('pe-fix-owner-other').click();
    await snap(page, `${k}-mid`, D.w, D.h);
    await page.getByTestId('pe-opt-Priya Lund').click();
    await snap(page, `${k}-owner-fixed`, D.w, D.h);
    await strip();
    await page.getByTestId('pe-fix-dates').click();
    await strip();
    await page.getByTestId('pe-fix-link').click();
    await snap(page, `${k}-all-fixed`, D.w, D.h);
    await open(page, `${qs}&hard=1`, W.w, W.h);
    await strip();
    await snap(page, `${k}-hard-1512`, W.w, W.h);
    await open(page, `${qs}&hard=1`, W.w, W.h, 'dark');
    await strip();
    await snap(page, `${k}-hard-1512-dark`, W.w, W.h);
    for (const t of ['light', 'dark']) {
      await open(page, qs, P.w, P.h, t);
      await strip();
      await snap(page, `${k}-rest-390${t === 'dark' ? '-dark' : ''}`, P.w, P.h);
    }
    await open(page, qs, D.w, D.h, 'dark');
    await strip();
    await snap(page, `${k}-rest-dark`, D.w, D.h);
  }

  // The read-only look, signed in as a viewer (the sidebar names the viewer).
  await viewers(browser);

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

async function viewers(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:4173' });
  const page = await ctx.newPage();
  await login(page, 'viewer@example.com');
  const runs: [string, string][] = [
    ...['a', 'b', 'c', 'd'].map((m) => [`pe1-${m}`, `pe1=${m}&pe2=a&pe3=a`] as [string, string]),
    ...['a', 'b', 'c'].map((o) => [`pe2-${o}`, `pe1=a&pe2=${o}&pe3=a`] as [string, string]),
    ...['a', 'b', 'c'].map((f) => [`pe3-${f}`, `pe1=a&pe2=a&pe3=${f}`] as [string, string]),
  ];
  // The viewer's own session: the admin's seeded data would sign the admin back in.
  const kept = seed;
  seed = '';
  for (const [k, qs] of runs) {
    if (process.env.ONLY !== 'viewers' && !want(k)) continue;
    await open(page, `${qs}&hard=1&viewer=1`, W.w, W.h);
    await snap(page, `${k}-viewer-1512`, W.w, W.h);
  }
  seed = kept;
  await ctx.close();
}

// MOCK-HOOK (whole file): mk-inbox-keys: drives each mock-up state through the UI and saves it as static HTML + PNG.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { test, type Page } from '@playwright/test';

const OUT = join(__dirname, '../../../mockups-out/mk-inbox-keys');
const DIST = join(__dirname, '../../dist-mock');
mkdirSync(join(OUT, 'frames'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

export type Step = string; // 'k:j' key, 'c:css' click, 'r:role|name' click by role, 't:text' type, 'w:ms'
export type Frame = { file: string; url: string; steps?: Step[]; w?: number; h?: number; as?: string };

async function login(page: Page, email: string) {
  await page.goto('/login?next=%2Fsimple%2Finbox');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(simple|home|inbox)/);
}

async function save(page: Page, name: string, w: number, h: number) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, 'frames', `${name}.png`) });
  // The dark PNG of the same state.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, 'frames', `${name}-dark.png`) });
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  const { html, css } = await page.evaluate(() => {
    let css = '';
    for (const sh of Array.from(document.styleSheets)) {
      try {
        css += Array.from(sh.cssRules).map((r) => r.cssText).join('\n') + '\n';
      } catch {
        /* cross-origin */
      }
    }
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    const live = Array.from(document.querySelectorAll('input, textarea, select'));
    const copies = Array.from(root.querySelectorAll('input, textarea, select'));
    live.forEach((el, n) => {
      const c = copies[n] as HTMLInputElement;
      const l = el as HTMLInputElement;
      if (l.type === 'checkbox') {
        if (l.checked) c.setAttribute('checked', '');
      } else if (el.tagName === 'SELECT') {
        const opt = c.querySelectorAll('option')[(el as HTMLSelectElement).selectedIndex];
        opt?.setAttribute('selected', '');
      } else c.setAttribute('value', l.value);
    });
    // Scrolled boxes keep their scroll.
    const scrolls: [string, number][] = [];
    Array.from(document.querySelectorAll('*')).forEach((el, n) => {
      if (el.scrollTop > 0) scrolls.push([String(n), el.scrollTop]);
    });
    const all = Array.from(root.querySelectorAll('*'));
    for (const [n, top] of scrolls) all[Number(n) - 1]?.setAttribute('data-mk-scroll', String(top));
    root.querySelectorAll('script, link[rel=stylesheet], link[rel=modulepreload], style').forEach((n) => n.remove());
    return { html: root.outerHTML, css, y: window.scrollY };
  });
  const y = await page.evaluate(() => window.scrollY);
  const fixed = css.replace(/url\((["']?)([^"')]+\.(woff2?|ttf))\1\)/g, (_m, _q, u: string) => {
    const f = basename(u.split('?')[0]);
    const src = [join(DIST, 'assets', f), join(DIST, 'fonts', f)].find((x) => existsSync(x)) ?? '';
    if (src && !existsSync(join(OUT, 'assets', f))) copyFileSync(src, join(OUT, 'assets', f));
    return `url("../assets/${f}")`;
  });
  const hook = `<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);addEventListener('load',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){e.scrollTop=+e.getAttribute('data-mk-scroll')});scrollTo(0,${y})});})()</script>`;
  const doc =
    '<!doctype html>\n' +
    html.replace(
      /<head>/,
      `<head><meta charset="utf-8"><meta name="mockup-viewport" content="${w}x${h}"><style>${fixed}</style>${hook}`,
    );
  writeFileSync(join(OUT, 'frames', `${name}.html`), doc);
}

async function run(page: Page, f: Frame) {
  const w = f.w ?? 1440;
  const h = f.h ?? 900;
  await page.setViewportSize({ width: w, height: h });
  await page.goto(f.url);
  await page.getByTestId('inbox-needs').waitFor();
  await page.waitForTimeout(400);
  await page.mouse.move(1, h - 1);
  for (const s of f.steps ?? []) {
    const [kind, ...rest] = s.split(':');
    const arg = rest.join(':');
    if (kind === 'k') await page.keyboard.press(arg);
    else if (kind === 'c') await page.locator(arg).first().click();
    else if (kind === 'r') {
      const [role, name] = arg.split('|');
      await page.getByRole(role as 'button', { name, exact: true }).first().click();
    } else if (kind === 't') await page.keyboard.type(arg, { delay: 10 });
    else if (kind === 'w') await page.waitForTimeout(Number(arg));
    else if (kind === 'v') await page.locator(arg).first().evaluate((e) => e.scrollIntoView({ block: 'center' }));
    else if (kind === 's') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(120);
  }
  await save(page, f.file, w, h);
}

const FRAMES: Frame[] = JSON.parse(require('node:fs').readFileSync(join(__dirname, 'frames.json'), 'utf8')).frames;
const ONLY = process.env.MK_ONLY;

for (const who of ['owner', 'commenter', 'viewer']) {
  test(`frames as ${who}`, async ({ page }) => {
    const mine = FRAMES.filter((f) => (f.as ?? 'owner') === who && (!ONLY || f.file.startsWith(ONLY)));
    test.skip(mine.length === 0);
    await login(page, who === 'owner' ? 'admin@example.com' : `${who}@example.com`);
    for (const f of mine) await run(page, f);
  });
}

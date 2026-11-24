// MOCK-HOOK: whole file. Snapshots each mk-mentions frame as static html (styles inlined, scripts
// removed, fonts copied to assets/) and a PNG. MK_ONLY=<prefix> captures a subset.
import fs from 'node:fs';
import path from 'node:path';

import { test, type Browser, type Page } from '@playwright/test';

import { stableUuid } from '../../lib/api/mock/ids';
type Frame = { file: string; q: string; size: [number, number]; role: string; page?: string; scroll?: string };
const FRAMES: Frame[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'frames.json'), 'utf8'));

const OUT = path.resolve(__dirname, '../../../mockups-out/mk-mentions');
const FR = path.join(OUT, 'frames');
const AS = path.join(OUT, 'assets');
const ITEM = stableUuid('simple-item/alert-digest');
const PASS = ['de', 'mo'].join('');
const EMAIL: Record<string, string> = {
  owner: 'admin@example.com',
  approver: 'approver@example.com',
  commenter: 'commenter@example.com',
  viewer: 'viewer@example.com',
};

async function login(page: Page, role: string) {
  await page.goto('/login?next=%2Fsimple');
  await page.getByLabel('Email').fill(EMAIL[role]);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/simple/, { timeout: 30_000 });
}

const fontsDone = new Set<string>();

async function snapshot(page: Page, file: string, w: number, h: number) {
  const css: string = await page.evaluate(async () => {
    let all = '';
    for (const l of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const href = (l as HTMLLinkElement).href;
      const t = await (await fetch(href)).text();
      all += t.replace(/url\((['"]?)(\/[^)'"]+)\1\)/g, (_m, _q, u) => `url(${new URL(u, href).pathname})`);
    }
    for (const s of Array.from(document.querySelectorAll('style'))) all += s.textContent ?? '';
    return all;
  });
  // Fonts: copy each to assets/ and point the css at it.
  let out = css;
  for (const m of css.matchAll(/url\(([^)]+\.(?:woff2?|ttf|otf))\)/g)) {
    const u = m[1].replace(/['"]/g, '');
    const name = path.basename(u);
    if (!fontsDone.has(name)) {
      const r = await page.request.get(u);
      if (r.ok()) fs.writeFileSync(path.join(AS, name), await r.body());
      fontsDone.add(name);
    }
    out = out.split(m[1]).join(`../assets/${name}`);
  }
  const html: string = await page.evaluate(
    ({ out, w, h }) => {
      // Mark scroll positions so the static copy restores them.
      let n = 0;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.scrollTop > 0 || el.scrollLeft > 0) {
          el.setAttribute('data-mk-scroll', `${el.scrollTop},${el.scrollLeft}`);
          n++;
        }
      }
      for (const t of Array.from(document.querySelectorAll('textarea'))) t.textContent = t.value;
      for (const i of Array.from(document.querySelectorAll('input')))
        i.setAttribute('value', (i as HTMLInputElement).value);
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll('script,link[rel="stylesheet"],link[rel="modulepreload"],style').forEach((e) => e.remove());
      doc.removeAttribute('data-theme');
      const head = doc.querySelector('head')!;
      const meta = document.createElement('meta');
      meta.name = 'mockup-viewport';
      meta.content = `${w}x${h}`;
      head.prepend(meta);
      const st = document.createElement('style');
      st.textContent = out;
      head.append(st);
      const sc = document.createElement('script');
      sc.textContent = `(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){var p=e.getAttribute('data-mk-scroll').split(',');e.scrollTop=+p[0];e.scrollLeft=+p[1];});});})();`;
      head.prepend(sc);
      void n;
      return '<!doctype html>\n' + doc.outerHTML;
    },
    { out, w, h },
  );
  fs.writeFileSync(path.join(FR, `${file}.html`), html);
  await page.screenshot({ path: path.join(FR, `${file}.png`) });
}

async function frame(browser: Browser, f: Frame, states: Map<string, string>) {
  const [w, h] = f.size;
  const key = `${f.role}`;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    storageState: states.get(key) ? JSON.parse(states.get(key)!) : undefined,
    colorScheme: 'light',
    deviceScaleFactor: 1,
    isMobile: w < 500,
    hasTouch: w < 500,
  });
  const page = await ctx.newPage();
  if (!states.get(key)) {
    await login(page, f.role);
    states.set(key, JSON.stringify(await ctx.storageState()));
  }
  const url = f.page === 'inbox' ? `/simple/inbox?${f.q}` : `/simple/roadmap?item=${ITEM}&${f.q}`;
  await page.goto(url);
  const target = f.page === 'inbox' ? '[data-testid="mk-inbox-mention"], .fixed.z-50' : '[data-testid="mk-activity"]';
  await page.locator(target).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  if (f.page !== 'inbox') {
    await page.evaluate((scrollTo) => {
      const pick = (s: string) => document.querySelector(s) as HTMLElement | null;
      const el =
        (scrollTo === 'field' && (pick('[data-testid="mk-activity-side"] textarea') ?? pick('[data-testid="mk-activity"] textarea'))) ||
        (scrollTo === 'undo' && pick('[data-testid="mk-activity"] .w-64')) ||
        (scrollTo === 'mention' && pick('[data-testid="mk-mention"]')) ||
        (scrollTo === 'change' && (document.querySelectorAll('[data-testid="mk-change"]')[1] as HTMLElement)) ||
        (scrollTo === 'more' && pick('[data-testid="mk-more"]')) ||
        (scrollTo === 'center' && pick('[data-testid="mk-activity"]')) ||
        pick('[data-testid="mk-activity"]');
      el?.scrollIntoView({ block: scrollTo === 'top' || !scrollTo ? 'start' : 'center' });
      if (scrollTo === 'top' || !scrollTo) {
        let p = el?.parentElement ?? null;
        while (p && !(p.scrollHeight > p.clientHeight && getComputedStyle(p).overflowY !== 'visible')) p = p.parentElement;
        // Clear the panel's sticky title so no line shows half under it.
        let h = 0;
        for (const c of Array.from(p?.querySelectorAll('*') ?? [])) {
          if (getComputedStyle(c).position === 'sticky') { h = Math.max(h, (c as HTMLElement).getBoundingClientRect().height); break; }
        }
        p?.scrollBy(0, -h);
      }
    }, f.scroll ?? 'top');
    await page.waitForTimeout(400);
  }
  await snapshot(page, f.file, w, h);
  await ctx.close();
}

test('capture mk-mentions frames', async ({ browser }) => {
  fs.mkdirSync(FR, { recursive: true });
  fs.mkdirSync(AS, { recursive: true });
  const only = process.env.MK_ONLY;
  const states = new Map<string, string>();
  for (const f of FRAMES) {
    if (only && !f.file.startsWith(only)) continue;
    await frame(browser, f, states);
  }
});

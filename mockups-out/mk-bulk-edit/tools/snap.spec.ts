// mk-bulk-edit: snapshots each mock-up frame as a static html (styles inlined, scripts removed, fonts
// copied to assets/) and a PNG. Driven by spec.json (file, url, do, w, h, theme).
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_NOW } from '../lib/api/mock/clock';

type Frame = { file: string; url: string; do: [string, string, string[]?][]; w: number; h: number; theme: string };
const SPEC: Frame[] = JSON.parse(fs.readFileSync(process.env.MK_SPEC!, 'utf8'));
const OUT = process.env.MK_OUT!;
const DIST = process.env.MK_DIST!;
const ONLY = process.env.MK_ONLY ?? '';

const CLONE = ([vw, vh]: [number, number]) => {
  let css = '';
  for (const sh of Array.from(document.styleSheets)) {
    try {
      for (const r of Array.from(sh.cssRules)) css += r.cssText + '\n';
    } catch {}
  }
  document.querySelectorAll('input').forEach((i) => {
    if (i.checked) i.setAttribute('checked', '');
    else i.removeAttribute('checked');
  });
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach((n) => n.remove());
  const head = root.querySelector('head')!;
  const st = document.createElement('style');
  st.textContent = css;
  head.appendChild(st);
  const s = document.createElement('script');
  s.textContent =
    "(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);})();";
  head.prepend(s);
  const m = document.createElement('meta');
  m.name = 'mockup-viewport';
  m.content = vw + 'x' + vh;
  head.prepend(m);
  return '<!doctype html>\n' + root.outerHTML;
};

test('snap', async ({ browser }) => {
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  let state: string | undefined;
  for (const f of SPEC) {
    if (ONLY && !f.file.startsWith(ONLY)) continue;
    const phone = f.w < 500;
    const ctx = await browser.newContext({
      viewport: { width: f.w, height: f.h },
      storageState: state as never,
      ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
    });
    await ctx.clock.install({ time: MOCK_NOW });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('theme', t);
      } catch {}
    }, f.theme);
    const page = await ctx.newPage();
    if (!state) {
      await page.goto('/login?next=%2Fhome');
      await page.getByLabel('Email').fill('admin@example.com');
      await page.getByLabel('Password').fill('demo');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/home$/);
      state = JSON.stringify(await ctx.storageState());
      state = JSON.parse(state);
    }
    await page.goto(f.url);
    await page.locator((f as { wait?: string }).wait ?? '[data-testid="prio-row"]').first().waitFor();
    await page.waitForTimeout(800);
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), f.theme);
    try {
    for (const [kind, sel, mods] of f.do) {
      if (kind === 'scroll') await page.evaluate((y) => window.scrollTo(0, Number(y)), sel);
      else {
        const loc = page.locator(sel).first();
        if (kind === 'click')
          await loc.click({ modifiers: (mods ?? []) as ('Shift' | 'Control')[], timeout: 8000 });
        else if (kind === 'hover') await loc.hover({ timeout: 8000 });
      }
      await page.waitForTimeout(300);
    }
    } catch (e) {
      console.log('FAIL', f.file, String(e).slice(0, 200));
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(500);
    let html = await page.evaluate(CLONE, [f.w, f.h] as [number, number]);
    html = html.replace(/url\((["']?)\/(?:assets|fonts)\/([^)"']+)\1\)/g, (_m, q, name) => {
      const src = [path.join(DIST, 'assets', name), path.join(DIST, 'fonts', name)].find((p) => fs.existsSync(p)) ?? '';
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, 'assets', name));
      return `url(${q}../assets/${name}${q})`;
    });
    fs.writeFileSync(path.join(OUT, 'frames', f.file + '.html'), html);
    await page.screenshot({ path: path.join(OUT, 'frames', f.file + '.png') });
    console.log('ok', f.file);
    await ctx.close();
  }
});

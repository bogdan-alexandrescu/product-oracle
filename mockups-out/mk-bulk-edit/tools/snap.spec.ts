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
  // The page's scroll, the boxes' part-picked look and any inner scroll are kept, so the html opens as its PNG.
  document.documentElement.setAttribute('data-mk-scroll', String(Math.round(window.scrollY)));
  document.querySelectorAll<HTMLElement>('body *').forEach((e) => {
    if (e.scrollTop > 0) e.setAttribute('data-mk-top', String(e.scrollTop));
    if ((e as HTMLInputElement).indeterminate) e.setAttribute('data-mk-part', '');
  });
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach((n) => n.remove());
  const head = root.querySelector('head')!;
  const st = document.createElement('style');
  st.textContent = css;
  head.appendChild(st);
  const s = document.createElement('script');
  s.textContent =
    "(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);function r(){document.querySelectorAll('[data-mk-part]').forEach(function(e){e.indeterminate=true});document.querySelectorAll('[data-mk-top]').forEach(function(e){e.scrollTop=+e.getAttribute('data-mk-top')});window.scrollTo({top:+(document.documentElement.getAttribute('data-mk-scroll')||0),behavior:'instant'});}addEventListener('load',function(){r();document.fonts&&document.fonts.ready.then(r);});})();";
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
      else if (kind === 'scrollto')
        await page.locator(sel).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
      else if (kind === 'align') {
        // Scroll so the row ends in the gap over the bulk bar (or over the corner message, or the window's end).
        await page.locator(sel).first().evaluate((el, gap) => {
          const tops = Array.from(document.querySelectorAll('[data-testid="bulk-dock"], [data-testid="toasts"] > *')).map((d) => d.getBoundingClientRect().top);
          const end = Math.min(window.innerHeight, ...tops);
          window.scrollBy({ top: el.getBoundingClientRect().bottom + gap - end, behavior: 'instant' });
        }, Number(mods?.[0] ?? 8));
        // The pointer rests off the rows once a message is up.
        if (!phone && (await page.locator('[data-testid="toasts"] > *').count())) await page.mouse.move(120, 640);
      }
      else if (kind === 'below') {
        // Scroll so the element's top sits at this many pixels from the top.
        await page.locator(sel).first().evaluate((el, y) => {
          window.scrollTo({ top: 0, behavior: 'instant' });
          window.scrollTo({ top: el.getBoundingClientRect().top - y, behavior: 'instant' });
        }, Number(mods![0]));
        if (!phone) await page.mouse.move(120, 640);
      }
      else if (kind === 'note')
        // A mock-up note, not product UI: what the proposal costs in clicks against today.
        await page.evaluate((t) => {
          const d = document.createElement('div');
          d.setAttribute('data-mockup-note', '');
          d.textContent = 'Clicks: ' + t;
          d.style.cssText =
            'position:fixed;left:16px;bottom:164px;width:199px;box-sizing:border-box;z-index:9999;padding:6px 10px;border:2px dashed #b45309;border-radius:8px;background:#fffbeb;color:#78350f;font:600 13px/1.3 system-ui,sans-serif';
          document.body.appendChild(d);
        }, sel);
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

// MOCK-HOOK: mk-roadmap-edit only (never merged). Snapshots each mock-up frame as a static html file
// (stylesheets inlined, scripts removed, fonts copied to assets/) plus a PNG. MK_ONLY=re1-a,re2 limits it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { test, type Page } from '@playwright/test';

const OUT = '../mockups-out/mk-roadmap-edit';
const SIZES = { d: [1440, 900], h: [1512, 982], p: [390, 844] } as const;
type Sz = keyof typeof SIZES;
type Frame = { name: string; q: string; sz: Sz; theme: 'light' | 'dark' };

function frames(): Frame[] {
  const only = (process.env.MK_ONLY ?? '').split(',').filter(Boolean);
  const out: Frame[] = [];
  for (const dec of ['re1', 're2', 're3'])
    for (const v of 'abcd') {
      const key = `${dec}-${v}`;
      if (only.length && !only.some((o) => key.startsWith(o))) continue;
      const sts = ['rest', 'open', 'mid', 'result', ...(dec === 're1' ? ['ms'] : [])];
      for (const st of sts) out.push({ name: `${key}-${st}`, q: `${dec}=${v}&st=${st}`, sz: 'd', theme: 'light' });
      out.push({ name: `${key}-hard-1512`, q: `${dec}=${v}&st=hard`, sz: 'h', theme: 'light' });
      const pst = dec === 're3' ? 'rest' : 'open';
      out.push({ name: `${key}-${pst}-390`, q: `${dec}=${v}&st=${pst}`, sz: 'p', theme: 'light' });
      out.push({ name: `${key}-rest-dark`, q: `${dec}=${v}&st=rest`, sz: 'd', theme: 'dark' });
      out.push({ name: `${key}-${pst}-390-dark`, q: `${dec}=${v}&st=${pst}`, sz: 'p', theme: 'dark' });
    }
  return out;
}

const assets = new Map<string, string>();
async function asset(page: Page, url: string): Promise<string> {
  if (url.startsWith('data:') || url.startsWith('#')) return url;
  const full = url.startsWith('http') ? url : `http://localhost:4173${url.startsWith('/') ? '' : '/'}${url}`;
  if (!assets.has(full)) {
    const name = `${createHash('md5').update(full).digest('hex').slice(0, 6)}-${basename(full.split('?')[0]) || 'a'}`;
    const r = await page.request.get(full);
    if (r.ok()) {
      writeFileSync(`${OUT}/assets/${name}`, await r.body());
      assets.set(full, `../assets/${name}`);
    } else assets.set(full, url);
  }
  return assets.get(full)!;
}

async function replaceAsync(s: string, re: RegExp, f: (m: RegExpExecArray) => Promise<string>) {
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(re)) {
    parts.push(s.slice(last, m.index), await f(m as RegExpExecArray));
    last = m.index! + m[0].length;
  }
  parts.push(s.slice(last));
  return parts.join('');
}

test('capture mk-roadmap-edit frames', async ({ browser }) => {
  mkdirSync(`${OUT}/frames`, { recursive: true });
  mkdirSync(`${OUT}/assets`, { recursive: true });
  const pages = new Map<Sz, Page>();
  for (const f of frames()) {
    let page = pages.get(f.sz);
    if (!page) {
      const [width, height] = SIZES[f.sz];
      const ctx = await browser.newContext({ viewport: { width, height }, isMobile: f.sz === 'p', hasTouch: f.sz === 'p' });
      page = await ctx.newPage();
      await page.goto('/login?next=%2Fsimple%2Froadmap');
      await page.getByLabel('Email').fill('admin@example.com');
      await page.getByLabel('Password').fill('demo');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/simple\/roadmap/);
      pages.set(f.sz, page);
    }
    await page.goto(`/simple/roadmap?${f.q}`);
    await page.locator('[data-testid="re-mock"]').waitFor();
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), f.theme);
    await page.evaluate(() => {
      const e = document.querySelector<HTMLElement>('[data-scroll-here]');
      e?.scrollIntoView({ block: e.dataset.scrollHere === 'start' ? 'start' : 'center' });
    });
    await page.waitForTimeout(300);
    let html = await page.evaluate(() => {
      let css = '';
      for (const sh of Array.from(document.styleSheets))
        try {
          for (const r of Array.from(sh.cssRules)) css += r.cssText + '\n';
        } catch {}
      const root = document.documentElement.cloneNode(true) as HTMLElement;
      root.querySelectorAll('script, link[rel=stylesheet], link[rel=modulepreload], style').forEach((n) => n.remove());
      const st = document.createElement('style');
      st.textContent = css;
      root.querySelector('head')!.appendChild(st);
      root.removeAttribute('data-theme');
      return '<!doctype html>\n' + root.outerHTML;
    });
    html = await replaceAsync(html, /url\((["']?)([^)"']+)\1\)/g, async (m) => `url("${await asset(page!, m[2])}")`);
    html = await replaceAsync(html, /(src|href)="(\/[^"]*\.(?:png|svg|jpg|ico|woff2?))"/g, async (m) => `${m[1]}="${await asset(page!, m[2])}"`);
    const [w, h] = SIZES[f.sz];
    const theme = `<script>(function(){var t=new URLSearchParams(location.search).get('theme')||'${f.theme}';document.documentElement.setAttribute('data-theme',t);addEventListener('load',function(){var e=document.querySelector('[data-scroll-here]');if(e)e.scrollIntoView({block:e.getAttribute('data-scroll-here')==='start'?'start':'center'});});})();</script>`;
    html = html.replace('<head>', `<head><meta name="mockup-viewport" content="${w}x${h}">${theme}`);
    writeFileSync(`${OUT}/frames/${f.name}.html`, html);
    await page.screenshot({ path: `${OUT}/frames/${f.name}.png` });
  }
});

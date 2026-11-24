// MOCK-HOOK (whole file): static frame snapshots for mock-ups: DOM clone, stylesheets inlined,
// scripts removed, fonts copied to assets/, a mockup-viewport meta and a ?theme= hook; plus PNGs.
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

export const OUT = path.resolve(__dirname, '../../mockups-out/mk-linked-pr');
const FRAMES = path.join(OUT, 'frames');
const ASSETS = path.join(OUT, 'assets');
const PUBLIC = path.resolve(__dirname, '../public');

export async function snap(page: Page, name: string, note?: string) {
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.waitForTimeout(400);
  if (note)
    await page.evaluate((n) => {
      const d = document.createElement('div');
      d.setAttribute('data-mock-note', '');
      d.textContent = n;
      d.style.cssText =
        'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;background:#111827;color:#fff;font:600 13px/1.3 system-ui;padding:6px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:92vw;text-align:center';
      document.body.appendChild(d);
    }, note);
  const vp = page.viewportSize()!;
  await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
  // A dark twin of every frame's picture (the HTML switches with ?theme=dark).
  const was = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(FRAMES, `${name}-dark.png`) });
  await page.evaluate((w) => {
    if (w) document.documentElement.dataset.theme = w;
    else delete document.documentElement.dataset.theme;
  }, was);
  const { html, css } = await page.evaluate(() => {
    let css = '';
    for (const sh of Array.from(document.styleSheets)) {
      try {
        for (const r of Array.from(sh.cssRules)) css += r.cssText + '\n';
      } catch {
        /* cross-origin: none here */
      }
    }
    document.querySelectorAll('*').forEach((el) => {
      if (el.scrollTop > 0 || el.scrollLeft > 0)
        el.setAttribute('data-mk-scroll', `${el.scrollTop},${el.scrollLeft}`);
    });
    document.querySelectorAll('input, textarea').forEach((el) => {
      const i = el as HTMLInputElement;
      if (i.type === 'checkbox' || i.type === 'radio') {
        if (i.checked) i.setAttribute('checked', '');
        else i.removeAttribute('checked');
      } else i.setAttribute('value', i.value);
    });
    document.querySelectorAll('select').forEach((s) => {
      Array.from(s.options).forEach((o) =>
        o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected'),
      );
    });
    const c = document.documentElement.cloneNode(true) as HTMLElement;
    c.querySelectorAll('script, link[rel="stylesheet"], link[rel="modulepreload"], style').forEach(
      (n) => n.remove(),
    );
    document
      .querySelectorAll('[data-mk-scroll]')
      .forEach((el) => el.removeAttribute('data-mk-scroll'));
    return { html: c.outerHTML, css };
  });
  const fonts = new Set<string>();
  const fixed = css.replace(/url\((["']?)\/fonts\/([^)"']+)\1\)/g, (_m, _q, f) => {
    fonts.add(f);
    return `url(../assets/${f})`;
  });
  for (const f of fonts) {
    const dst = path.join(ASSETS, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(PUBLIC, 'fonts', f), dst);
  }
  const icon = path.join(ASSETS, 'icon.svg');
  if (!fs.existsSync(icon)) fs.copyFileSync(path.join(PUBLIC, 'icon.svg'), icon);
  const head =
    `<meta name="mockup-viewport" content="${vp.width}x${vp.height}">` +
    `<style>${fixed}</style>` +
    `<script>(function(){var t=new URLSearchParams(location.search).get('theme');` +
    `if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);` +
    `addEventListener('DOMContentLoaded',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){` +
    `var s=e.getAttribute('data-mk-scroll').split(',');e.scrollTop=+s[0];e.scrollLeft=+s[1];});});})();</script>`;
  const out =
    '<!doctype html>\n' +
    html
      .replace(/<head>/, `<head>${head}`)
      .replace(/(src|href)="\/(icon\.svg)"/g, '$1="../assets/$2"');
  fs.writeFileSync(path.join(FRAMES, `${name}.html`), out);
}

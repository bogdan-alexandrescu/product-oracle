// MOCK-HOOK: mk-undo frame snapshotter (mock-ups only, never merged).
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { MOCK_LOGIN } from '../lib/api/mock/fixtures';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames');
const HOOK = fs.readFileSync(path.join(__dirname, 'hook.html'), 'utf8');

export async function signIn(page: Page, to: string, email = 'admin@example.com') {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(MOCK_LOGIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

export async function theme(page: Page, t: 'light' | 'dark') {
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), t);
  await page.emulateMedia({ colorScheme: t });
}

export async function snap(page: Page, name: string) {
  await page.waitForTimeout(400);
  const vp = page.viewportSize()!;
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  const html = await page.evaluate(({ vp, hook }) => {
    document.querySelectorAll('*').forEach((e) => {
      if (e.scrollTop || e.scrollLeft) e.setAttribute('data-mk-scroll', `${e.scrollLeft},${e.scrollTop}`);
    });
    document.documentElement.setAttribute('data-mk-win', `${scrollX},${scrollY}`);
    const css: string[] = [];
    for (const s of Array.from(document.styleSheets)) {
      try { css.push(Array.from(s.cssRules).map((r) => r.cssText).join('\n')); } catch { /* cross-origin */ }
    }
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll('script,link[rel=stylesheet],link[rel=modulepreload],style').forEach((e) => e.remove());
    root.querySelectorAll('input,textarea').forEach((e) => {
      const src = document.querySelector(`[name="${(e as HTMLInputElement).name}"]`) as HTMLInputElement | null;
      if (src) e.setAttribute('value', src.value);
    });
    const head = root.querySelector('head')!;
    const meta = document.createElement('meta');
    meta.name = 'mockup-viewport';
    meta.content = `${vp.width}x${vp.height}`;
    head.prepend(meta);
    const st = document.createElement('style');
    st.textContent = css.join('\n').replace(/url\((["']?)[^)"']*\/([\w-]+\.woff2)\1\)/g, 'url("../assets/$2")');
    head.append(st);
    return '<!DOCTYPE html>\n' + root.outerHTML.replace('</head>', hook + '</head>');
  }, { vp, hook: HOOK });
  fs.writeFileSync(path.join(OUT, name + '.html'), html);
}

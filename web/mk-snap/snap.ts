// MOCK-HOOK: mk-undo frame snapshotter (mock-ups only, never merged).
import fs from 'node:fs'; // MOCK-HOOK
import path from 'node:path'; // MOCK-HOOK
import { expect, type Page } from '@playwright/test'; // MOCK-HOOK
import { MOCK_LOGIN } from '../lib/api/mock/fixtures'; // MOCK-HOOK

const OUT = path.resolve(__dirname, '../../mockups-out/mk-undo/frames'); // MOCK-HOOK
const HOOK = fs.readFileSync(path.join(__dirname, 'hook.html'), 'utf8'); // MOCK-HOOK

export async function signIn(page: Page, to: string, email = 'admin@example.com') { // MOCK-HOOK
  await page.goto('/login'); // MOCK-HOOK
  await page.getByLabel('Email').fill(email); // MOCK-HOOK
  await page.getByLabel('Password').fill(MOCK_LOGIN.password); // MOCK-HOOK
  await page.getByRole('button', { name: 'Sign in' }).click(); // MOCK-HOOK
  await expect(page).not.toHaveURL(/\/login/); // MOCK-HOOK
  await page.goto(to); // MOCK-HOOK
} // MOCK-HOOK

export async function theme(page: Page, t: 'light' | 'dark') { // MOCK-HOOK
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), t); // MOCK-HOOK
  await page.emulateMedia({ colorScheme: t }); // MOCK-HOOK
} // MOCK-HOOK

export async function snap(page: Page, name: string) { // MOCK-HOOK
  await page.waitForTimeout(400); // MOCK-HOOK
  const vp = page.viewportSize()!; // MOCK-HOOK
  await page.screenshot({ path: path.join(OUT, name + '.png') }); // MOCK-HOOK
  const html = await page.evaluate(({ vp, hook }) => { // MOCK-HOOK
    document.querySelectorAll('*').forEach((e) => { // MOCK-HOOK
      if (e.scrollTop || e.scrollLeft) e.setAttribute('data-mk-scroll', `${e.scrollLeft},${e.scrollTop}`); // MOCK-HOOK
    }); // MOCK-HOOK
    document.documentElement.setAttribute('data-mk-win', `${scrollX},${scrollY}`); // MOCK-HOOK
    const css: string[] = []; // MOCK-HOOK
    for (const s of Array.from(document.styleSheets)) { // MOCK-HOOK
      try { css.push(Array.from(s.cssRules).map((r) => r.cssText).join('\n')); } catch { /* cross-origin */ } // MOCK-HOOK
    } // MOCK-HOOK
    const root = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
    root.querySelectorAll('script,link[rel=stylesheet],link[rel=modulepreload],style').forEach((e) => e.remove()); // MOCK-HOOK
    root.querySelectorAll('input,textarea').forEach((e) => { // MOCK-HOOK
      const src = document.querySelector(`[name="${(e as HTMLInputElement).name}"]`) as HTMLInputElement | null; // MOCK-HOOK
      if (src) e.setAttribute('value', src.value); // MOCK-HOOK
    }); // MOCK-HOOK
    const head = root.querySelector('head')!; // MOCK-HOOK
    const meta = document.createElement('meta'); // MOCK-HOOK
    meta.name = 'mockup-viewport'; // MOCK-HOOK
    meta.content = `${vp.width}x${vp.height}`; // MOCK-HOOK
    head.prepend(meta); // MOCK-HOOK
    const st = document.createElement('style'); // MOCK-HOOK
    st.textContent = css.join('\n').replace(/url\((["']?)[^)"']*\/([\w-]+\.woff2)\1\)/g, 'url("../assets/$2")'); // MOCK-HOOK
    head.append(st); // MOCK-HOOK
    return '<!DOCTYPE html>\n' + root.outerHTML.replace('</head>', hook + '</head>'); // MOCK-HOOK
  }, { vp, hook: HOOK }); // MOCK-HOOK
  fs.writeFileSync(path.join(OUT, name + '.html'), html); // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: the whole file captures the mk-mcp-connect mock-up frames (static html + png). Not a test.
// Run: E2E_PORT=4517 E2E_PREBUILT=1 npx playwright test e2e/mk-mcp-connect.capture.spec.ts --reporter=line
import fs from 'node:fs';
import path from 'node:path';

import { test, type Page } from '@playwright/test';

import { ADMIN } from './helpers';

const OUT = path.resolve(__dirname, '../../mockups-out/mk-mcp-connect'); // MOCK-HOOK
const ONLY = process.env.MK_ONLY; // MOCK-HOOK: a prefix, to capture some frames again

type Frame = {
  file: string;
  url: string;
  w?: number;
  h?: number;
  dark?: boolean;
  act?: (page: Page) => Promise<void>;
};

const A = 'mc1=a&mc2=a&mc3=a'; // MOCK-HOOK
const frames: Frame[] = [
  // MC1, where it lives
  { file: 'mc1-a-rest', url: `/home?${A}&clients=none&menu=1` },
  { file: 'mc1-a-open', url: `/account?${A}&clients=none` },
  { file: 'mc1-a-simple-menu', url: `/simple?${A}&clients=none&menu=1` },
  { file: 'mc1-a-company-1512', url: `/settings/connections?${A}`, w: 1512, h: 982 },
  { file: 'mc1-a-open-390', url: `/account?${A}&clients=none`, w: 390, h: 844 },
  { file: 'mc1-b-rest', url: `/simple?mc1=b&mc2=a&mc3=a&clients=none&menu=1` },
  { file: 'mc1-b-open', url: `/simple?mc1=b&mc2=a&mc3=a&clients=none&open=1` , act: async (p) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); } },
  { file: 'mc1-b-open-1512', url: `/home?mc1=b&mc2=a&mc3=a&clients=five&open=1`, w: 1512, h: 982 , act: async (p) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); } },
  { file: 'mc1-b-open-390', url: `/simple?mc1=b&mc2=a&mc3=a&clients=none&open=1`, w: 390, h: 844 , act: async (p) => { await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); } },
  { file: 'mc1-c-rest', url: `/simple?mc1=c&mc2=a&mc3=a&clients=none&menu=1` },
  { file: 'mc1-c-open', url: `/settings/connections?mc1=c&mc2=a&mc3=a&clients=none` },
  { file: 'mc1-c-viewer-1512', url: `/settings/connections?mc1=c&mc2=a&mc3=a&as=viewer&clients=none`, w: 1512, h: 982 },
  { file: 'mc1-c-open-390', url: `/settings/connections?mc1=c&mc2=a&mc3=a&clients=none`, w: 390, h: 844 },
  // MC2, the connect guide
  { file: 'mc2-a-rest', url: `/account?${A}&clients=none` },
  { file: 'mc2-a-copied', url: `/account?${A}&clients=none&copied=1&phase=wait` },
  { file: 'mc2-a-done', url: `/account?${A}&clients=fresh` },
  { file: 'mc2-a-late', url: `/account?${A}&clients=none&phase=late` },
  { file: 'mc2-a-app', url: `/account?${A}&clients=none&tab=app` },
  { file: 'mc2-a-commenter-1512', url: `/account?${A}&clients=five&as=commenter`, w: 1512, h: 982 },
  { file: 'mc2-a-viewer-1512', url: `/account?${A}&clients=none&as=viewer&tab=other`, w: 1512, h: 982 },
  { file: 'mc2-a-copied-390', url: `/account?${A}&clients=none&copied=1&phase=wait`, w: 390, h: 844 },
  { file: 'mc2-a-done-dark', url: `/account?${A}&clients=fresh`, dark: true },
  { file: 'mc2-b-rest', url: `/account?mc1=a&mc2=b&mc3=a&clients=none` },
  { file: 'mc2-b-copied', url: `/account?mc1=a&mc2=b&mc3=a&clients=none&step=2&copied=1` },
  { file: 'mc2-b-wait', url: `/account?mc1=a&mc2=b&mc3=a&clients=none&step=3&phase=wait` },
  { file: 'mc2-b-done', url: `/account?mc1=a&mc2=b&mc3=a&clients=fresh&step=3` },
  { file: 'mc2-b-late', url: `/account?mc1=a&mc2=b&mc3=a&clients=none&step=3&phase=late` },
  { file: 'mc2-b-commenter-1512', url: `/account?mc1=a&mc2=b&mc3=a&clients=five&as=commenter`, w: 1512, h: 982 },
  { file: 'mc2-b-copied-390', url: `/account?mc1=a&mc2=b&mc3=a&clients=none&step=2&copied=1`, w: 390, h: 844 },
  { file: 'mc2-c-rest', url: `/account?mc1=a&mc2=c&mc3=a&clients=none` },
  { file: 'mc2-c-copied', url: `/account?mc1=a&mc2=c&mc3=a&clients=none&copied=1` },
  { file: 'mc2-c-done', url: `/account?mc1=a&mc2=c&mc3=a&clients=fresh` },
  { file: 'mc2-c-viewer-1512', url: `/account?mc1=a&mc2=c&mc3=a&clients=five&as=viewer`, w: 1512, h: 982 },
  { file: 'mc2-c-rest-390', url: `/account?mc1=a&mc2=c&mc3=a&clients=none`, w: 390, h: 844 },
  // MC3, connected clients and access
  { file: 'mc3-a-rest', url: `/account?${A}&clients=fresh` },
  { file: 'mc3-a-revoke', url: `/account?${A}&clients=fresh&revoke=1` },
  {
    file: 'mc3-a-revoked',
    url: `/account?${A}&clients=fresh&revoke=1`,
    act: async (p) => {
      await p.getByTestId('mcp-revoke-dialog').getByRole('button', { name: 'Revoke', exact: true }).dispatchEvent('click');
    },
  },
  { file: 'mc3-a-five-1512', url: `/account?${A}&clients=five`, w: 1512, h: 982 },
  { file: 'mc3-a-company-1512', url: `/settings/connections?${A}`, w: 1512, h: 982 },
  { file: 'mc3-a-consent', url: `/oauth/consent?request=mock-handle&client=Claude%20Code` },
  { file: 'mc3-a-five-390', url: `/account?${A}&clients=five`, w: 390, h: 844, act: async (p) => { await p.getByTestId('mcp-clients').scrollIntoViewIfNeeded(); } },
  { file: 'mc3-a-five-dark', url: `/account?${A}&clients=five`, dark: true },
  { file: 'mc3-b-rest', url: `/account?mc1=a&mc2=a&mc3=b&clients=fresh` },
  { file: 'mc3-b-revoke', url: `/account?mc1=a&mc2=a&mc3=b&clients=fresh&revoke=1` },
  {
    file: 'mc3-b-undone',
    url: `/account?mc1=a&mc2=a&mc3=b&clients=fresh&revoke=1`,
    act: async (p) => {
      await p.getByTestId('mcp-undo').getByRole('button', { name: 'Undo' }).dispatchEvent('click');
    },
  },
  { file: 'mc3-b-five-1512', url: `/account?mc1=a&mc2=a&mc3=b&clients=five`, w: 1512, h: 982 },
  { file: 'mc3-b-company-1512', url: `/settings/connections?mc1=a&mc2=a&mc3=b`, w: 1512, h: 982 },
  { file: 'mc3-c-rest', url: `/account?mc1=a&mc2=a&mc3=c&clients=fresh` },
  { file: 'mc3-c-revoke', url: `/account?mc1=a&mc2=a&mc3=c&clients=fresh&revoke=1` },
  {
    file: 'mc3-c-revoked',
    url: `/account?mc1=a&mc2=a&mc3=c&clients=fresh&revoke=1`,
    act: async (p) => {
      await p.locator('[data-testid=mcp-client-card] .bg-crit-bg').getByRole('button', { name: 'Revoke' }).dispatchEvent('click');
    },
  },
  { file: 'mc3-c-five-1512', url: `/account?mc1=a&mc2=a&mc3=c&clients=five`, w: 1512, h: 982 },
  { file: 'mc3-c-company-1512', url: `/settings/connections?mc1=a&mc2=a&mc3=c`, w: 1512, h: 982 },
  { file: 'mc3-c-five-390', url: `/account?mc1=a&mc2=a&mc3=c&clients=five`, w: 390, h: 844 , act: async (p) => { await p.getByTestId('mcp-clients').scrollIntoViewIfNeeded(); } },
];

/** Clone the DOM, inline every stylesheet, drop scripts, point fonts at assets/, add the hooks. */
async function snap(page: Page, f: Frame, w: number, h: number) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'frames', `${f.file}.png`) });
  let html = await page.evaluate(() => {
    document.querySelectorAll('dialog').forEach((d) => {
      if (d.matches(':modal')) d.setAttribute('data-mk-modal', '');
    });
    document.querySelectorAll('input, textarea').forEach((el) => {
      const i = el as HTMLInputElement;
      if (i.type === 'checkbox' || i.type === 'radio') i.toggleAttribute('checked', i.checked);
      else i.setAttribute('value', i.value);
    });
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    doc.querySelectorAll('script, link[rel=stylesheet], link[rel=modulepreload], link[rel=preload], style').forEach((e) => e.remove());
    let css = '';
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const r of Array.from(sheet.cssRules)) css += r.cssText + '\n';
      } catch {
        /* cross-origin */
      }
    }
    css +=
      'dialog[data-mk-modal]{position:fixed;inset:0;margin:auto;z-index:1000}' +
      '.mk-backdrop{position:fixed;inset:0;background:rgba(6,16,30,.45);z-index:999}';
    const st = document.createElement('style');
    st.textContent = css;
    doc.querySelector('head')!.appendChild(st);
    doc.querySelectorAll('dialog[data-mk-modal]').forEach((d) => {
      const b = document.createElement('div');
      b.className = 'mk-backdrop';
      d.before(b);
    });
    return '<!doctype html>\n' + doc.outerHTML;
  });
  html = html.replace(/url\((['"]?)\/fonts\//g, 'url($1../assets/');
  const hook =
    `<meta name="mockup-viewport" content="${w}x${h}">` +
    `<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);})();</script>`;
  html = html.replace('<head>', `<head>${hook}`);
  fs.writeFileSync(path.join(OUT, 'frames', `${f.file}.html`), html);
}

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.setTimeout(30 * 60_000);

test('capture mk-mcp-connect frames', async ({ browser, baseURL }) => {
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  for (const font of fs.readdirSync(path.resolve(__dirname, '../public/fonts')))
    fs.copyFileSync(path.resolve(__dirname, '../public/fonts', font), path.join(OUT, 'assets', font));
  for (const f of frames) {
    if (ONLY && !f.file.startsWith(ONLY)) continue;
    const w = f.w ?? 1440;
    const h = f.h ?? 900;
    const ctx = await browser.newContext({ baseURL, viewport: { width: w, height: h }, colorScheme: f.dark ? 'dark' : 'light' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto('/login?next=%2Fhome');
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/home/);
    await page.goto(f.url);
    if (f.act) {
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      await f.act(page).catch((e) => console.log('act failed', f.file, String(e).slice(0, 300)));
    }
    await snap(page, f, w, h);
    await ctx.close();
    console.log('frame', f.file);
  }
});

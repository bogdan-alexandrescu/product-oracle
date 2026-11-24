// MOCK-HOOK: snapshots the mk-watch mock-up frames (static HTML + PNG) into mockups-out/mk-watch.
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { login } from './helpers';
import { test } from './test';

const OUT = path.resolve(__dirname, '../.mk-watch-out'); // MOCK-HOOK
const FR = path.join(OUT, 'frames'); // MOCK-HOOK
const AS = path.join(OUT, 'assets'); // MOCK-HOOK
fs.mkdirSync(FR, { recursive: true }); // MOCK-HOOK
fs.mkdirSync(AS, { recursive: true }); // MOCK-HOOK

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] }, actionTimeout: 15_000, navigationTimeout: 20_000 }); // MOCK-HOOK
test.describe.configure({ mode: 'serial' }); // MOCK-HOOK
test.setTimeout(600_000); // MOCK-HOOK

const SIZE: Record<string, [number, number]> = { d: [1440, 900], w: [1512, 982], p: [390, 844] }; // MOCK-HOOK

async function size(page: Page, s: 'd' | 'w' | 'p') { // MOCK-HOOK
  await page.setViewportSize({ width: SIZE[s][0], height: SIZE[s][1] }); // MOCK-HOOK
} // MOCK-HOOK

async function snap(page: Page, name: string, opts: { dark?: boolean; cost?: string } = {}) { // MOCK-HOOK
  await page.waitForTimeout(700); // MOCK-HOOK
  const vp = page.viewportSize()!; // MOCK-HOOK
  if (opts.cost) // MOCK-HOOK
    await page.evaluate((c) => { // MOCK-HOOK
      const d = document.createElement('div'); // MOCK-HOOK
      d.setAttribute('data-mk-note', ''); // MOCK-HOOK
      d.textContent = c; // MOCK-HOOK
      d.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;background:#7c3aed;color:#fff;font:600 13px/18px system-ui;padding:6px 10px;border-radius:8px;box-shadow:0 2px 8px rgb(0 0 0/.25)'; // MOCK-HOOK
      document.body.appendChild(d); // MOCK-HOOK
    }, opts.cost); // MOCK-HOOK
  await page.screenshot({ path: path.join(FR, `${name}.png`) }); // MOCK-HOOK
  if (opts.dark) { // MOCK-HOOK
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark')); // MOCK-HOOK
    await page.waitForTimeout(300); // MOCK-HOOK
    await page.screenshot({ path: path.join(FR, `${name}-dark.png`) }); // MOCK-HOOK
    await page.evaluate(() => delete document.documentElement.dataset.theme); // MOCK-HOOK
  } // MOCK-HOOK
  const { html, fonts } = await page.evaluate(() => { // MOCK-HOOK
    document.querySelectorAll('input,select,textarea').forEach((el) => { // MOCK-HOOK
      const e = el as HTMLInputElement; // MOCK-HOOK
      if (e.type === 'checkbox' || e.type === 'radio') { if (e.checked) e.setAttribute('checked', ''); else e.removeAttribute('checked'); } // MOCK-HOOK
      else if (el.tagName === 'SELECT') [...(el as HTMLSelectElement).options].forEach((o) => (o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected'))); // MOCK-HOOK
      else e.setAttribute('value', e.value); // MOCK-HOOK
    }); // MOCK-HOOK
    let css = ''; // MOCK-HOOK
    for (const sh of [...document.styleSheets]) { try { css += [...sh.cssRules].map((r) => r.cssText).join('\n') + '\n'; } catch { /* cross-origin */ } } // MOCK-HOOK
    const fonts = [...new Set([...css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf))["']?\)/g)].map((m) => m[1]))]; // MOCK-HOOK
    const doc = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
    doc.querySelectorAll('script,link[rel="stylesheet"],link[rel="modulepreload"],style').forEach((n) => n.remove()); // MOCK-HOOK
    doc.removeAttribute('data-theme'); // MOCK-HOOK
    return { html: doc.outerHTML, fonts, css }; // MOCK-HOOK
  }).then(async (r) => { // MOCK-HOOK
    let css = (await page.evaluate(() => { let c = ''; for (const sh of [...document.styleSheets]) { try { c += [...sh.cssRules].map((x) => x.cssText).join('\n') + '\n'; } catch { /* */ } } return c; })); // MOCK-HOOK
    for (const f of r.fonts) { // MOCK-HOOK
      const base = path.basename(f.split('?')[0]); // MOCK-HOOK
      const dest = path.join(AS, base); // MOCK-HOOK
      if (!fs.existsSync(dest)) { const res = await page.request.get(new URL(f, page.url()).toString()); fs.writeFileSync(dest, await res.body()); } // MOCK-HOOK
      css = css.split(f).join(`../assets/${base}`); // MOCK-HOOK
    } // MOCK-HOOK
    return { html: r.html.replace('<head>', `<head><meta charset="utf-8"><meta name="mockup-viewport" content="${vp.width}x${vp.height}"><script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)})()</script><style>${css.replace(/<\/style/g, '<\\/style')}</style>`), fonts: r.fonts }; // MOCK-HOOK
  }); // MOCK-HOOK
  void fonts; // MOCK-HOOK
  fs.writeFileSync(path.join(FR, `${name}.html`), '<!doctype html>\n' + html); // MOCK-HOOK
  await page.evaluate(() => document.querySelectorAll('[data-mk-note]').forEach((n) => n.remove())); // MOCK-HOOK
} // MOCK-HOOK

const bar = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"] [data-testid="timeline-bar"]`).first(); // MOCK-HOOK
const mkx = (page: Page, id: string) => page.locator(`[data-mk="${id}"]`).first(); // MOCK-HOOK

async function roadmap(page: Page, qs: string, open?: string) { // MOCK-HOOK
  await page.goto(`/simple/roadmap?${qs}`); // MOCK-HOOK
  await bar(page, 'alert-digest').waitFor(); // MOCK-HOOK
  if (open) { await bar(page, open).click(); await page.getByTestId('item-panel').waitFor(); } // MOCK-HOOK
  await page.waitForTimeout(600); // MOCK-HOOK
} // MOCK-HOOK

async function itemId(page: Page, key: string) { // MOCK-HOOK
  return bar(page, key).getAttribute('data-bar-id'); // MOCK-HOOK
} // MOCK-HOOK

async function phonePanel(page: Page, qs: string, id: string | null) { // MOCK-HOOK
  await size(page, 'p'); // MOCK-HOOK
  await page.goto(`/simple/roadmap?${qs}&item=${id}`); // MOCK-HOOK
  await page.waitForTimeout(3500); // MOCK-HOOK
} // MOCK-HOOK

const only = process.env.MK_ONLY; // MOCK-HOOK
const run = (n: string) => !only || only.split(',').includes(n); // MOCK-HOOK

test('wd1', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('wd1')); // MOCK-HOOK
  await size(page, 'd'); // MOCK-HOOK
  await login(page, 'approver@example.com'); // MOCK-HOOK: Priya Raman, who decides none of these
  // A: bell in the panel
  await roadmap(page, 'wd1=a', 'setup-checklist'); // MOCK-HOOK
  const f01 = await itemId(page, 'setup-checklist'); // MOCK-HOOK
  await snap(page, 'wd1-a-rest', { dark: true }); // MOCK-HOOK
  await mkx(page, 'watch').click(); await snap(page, 'wd1-a-open'); // MOCK-HOOK
  await mkx(page, 'ev3').click(); await mkx(page, 'ev4').click(); await snap(page, 'wd1-a-mid'); // MOCK-HOOK
  await mkx(page, 'watch-save').click(); await snap(page, 'wd1-a-result', { dark: true, cost: 'Cost: 2 clicks in the panel (today: no way to watch)' }); // MOCK-HOOK
  await size(page, 'w'); await page.goto('/simple/inbox?wd1=a&view=watching'); await mkx(page, 'watching').waitFor(); // MOCK-HOOK
  await snap(page, 'wd1-a-hard-1512', { cost: 'Cost: 1 click to stop any item' }); // MOCK-HOOK
  await phonePanel(page, 'wd1=a&step=open', f01); await snap(page, 'wd1-a-phone-390'); // MOCK-HOOK
  // B: eye on every row
  await size(page, 'd'); await roadmap(page, 'wd1=b'); // MOCK-HOOK
  await snap(page, 'wd1-b-rest'); // MOCK-HOOK
  await mkx(page, 'row-eye-setup-checklist').hover(); await snap(page, 'wd1-b-open'); // MOCK-HOOK
  await mkx(page, 'row-eye-setup-checklist').click(); await page.mouse.move(700, 600); await snap(page, 'wd1-b-result', { cost: 'Cost: 1 click on the row (today: no way to watch)' }); // MOCK-HOOK
  await size(page, 'w'); await roadmap(page, 'wd1=b'); // MOCK-HOOK
  for (const k of ['alert-mobile', 'setup-import', 'gm-f10', 'gm-f4', 'gm-f3']) await mkx(page, `row-eye-${k}`).click().catch(() => undefined); // MOCK-HOOK
  await bar(page, 'gm-f4').click(); await page.getByTestId('item-panel').waitFor(); // MOCK-HOOK
  await snap(page, 'wd1-b-hard-1512'); // MOCK-HOOK
  await phonePanel(page, 'wd1=b', f01); await snap(page, 'wd1-b-phone-390'); // MOCK-HOOK
  // C: watchers in the panel
  await size(page, 'd'); await roadmap(page, 'wd1=c', 'alert-digest'); // MOCK-HOOK
  await snap(page, 'wd1-c-rest'); // MOCK-HOOK
  await mkx(page, 'add-watcher').click(); await snap(page, 'wd1-c-open'); // MOCK-HOOK
  await roadmap(page, 'wd1=c&step=mid', 'alert-digest'); await snap(page, 'wd1-c-mid'); // MOCK-HOOK
  await mkx(page, 'pick-Rae').click(); await snap(page, 'wd1-c-result', { cost: 'Cost: 3 clicks and a name to add a teammate' }); // MOCK-HOOK
  await phonePanel(page, 'wd1=c', f01); await snap(page, 'wd1-c-phone-390'); // MOCK-HOOK
  await page.context().clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); // MOCK-HOOK
  await size(page, 'w'); await login(page, 'commenter@example.com'); // MOCK-HOOK
  await roadmap(page, 'wd1=c&n=many&role=commenter', 'alert-digest'); await mkx(page, 'add-watcher').click(); await snap(page, 'wd1-c-hard-1512'); // MOCK-HOOK
}); // MOCK-HOOK

test('wd1d', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('wd1d')); // MOCK-HOOK
  // D: follow what you own (Avery Stone, the owner, who decides these)
  await size(page, 'd'); await login(page); // MOCK-HOOK
  await roadmap(page, 'wd1=a'); const f01 = await itemId(page, 'setup-checklist'); // MOCK-HOOK
  await size(page, 'd'); await roadmap(page, 'wd1=d', 'alert-digest'); // MOCK-HOOK
  await snap(page, 'wd1-d-rest', { cost: 'Cost: 0 clicks for your own items' }); // MOCK-HOOK
  await mkx(page, 'mute').click(); await snap(page, 'wd1-d-result'); // MOCK-HOOK
  await roadmap(page, 'wd1=d', 'setup-checklist'); await snap(page, 'wd1-d-open', { cost: 'No way to follow an item you do not own' }); // MOCK-HOOK
  await phonePanel(page, 'wd1=d', f01); await snap(page, 'wd1-d-phone-390'); // MOCK-HOOK
  // Hard case by role: a viewer at 1512
  await page.context().clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); // MOCK-HOOK
  await size(page, 'w'); await login(page, 'viewer@example.com'); // MOCK-HOOK
  await roadmap(page, 'wd1=d&role=viewer', 'alert-digest'); await snap(page, 'wd1-d-hard-1512'); // MOCK-HOOK
}); // MOCK-HOOK

test('wd2', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('wd2')); // MOCK-HOOK
  await size(page, 'd'); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  for (const v of ['a', 'b', 'c']) { // MOCK-HOOK
    await size(page, 'd'); // MOCK-HOOK
    await page.goto(`/account?wd2=${v}`); await mkx(page, 'digest').waitFor(); // MOCK-HOOK
    await snap(page, `wd2-${v}-rest`, { dark: v === 'a' }); // MOCK-HOOK
    await mkx(page, 'sample-slack').click(); await snap(page, `wd2-${v}-open`, { dark: v === 'a' }); // MOCK-HOOK
    if (v !== 'b') { await page.goto(`/account?wd2=${v}&msg=slack&step=mid`); await mkx(page, 'digest').waitFor(); await snap(page, `wd2-${v}-mid`); } // MOCK-HOOK
    await mkx(page, 'sample-email').click(); await snap(page, `wd2-${v}-result`, { dark: v === 'a' }); // MOCK-HOOK
    await size(page, 'w'); await page.goto(`/account?wd2=${v}&msg=slack&n=many`); await mkx(page, 'digest').waitFor(); // MOCK-HOOK
    await mkx(page, 'sample').scrollIntoViewIfNeeded(); await snap(page, `wd2-${v}-hard-1512`); // MOCK-HOOK
    await size(page, 'p'); await page.goto(`/account?wd2=${v}&msg=email`); await mkx(page, 'sample').waitFor(); // MOCK-HOOK
    await mkx(page, 'sample').scrollIntoViewIfNeeded(); await snap(page, `wd2-${v}-phone-390`); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test('wd3', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('wd3')); // MOCK-HOOK
  await size(page, 'd'); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  const go = async (qs: string, sel = 'my-digests') => { await page.goto(`/account?${qs}`); await mkx(page, sel).waitFor(); }; // MOCK-HOOK
  for (const v of ['a', 'b', 'c']) { // MOCK-HOOK
    const main = v === 'c' ? 'delivery' : 'my-digests'; // MOCK-HOOK
    await size(page, 'd'); // MOCK-HOOK
    await go(`wd3=${v}`, main); await snap(page, `wd3-${v}-rest`, { dark: v === 'a' }); // MOCK-HOOK
    if (v !== 'b') { await go(`wd3=${v}&state=quiet`, main); await snap(page, `wd3-${v}-quiet`); } // MOCK-HOOK
    await go(`wd3=${v}&state=stopped`, main); await snap(page, `wd3-${v}-result`, { cost: v === 'c' ? 'Cost: reply “stop” in Slack, no page' : 'Cost: 1 click in the message, 1 to turn back on' }); // MOCK-HOOK
    await size(page, 'w'); await page.goto(`/settings/notifications?wd3=${v}&state=owner`); await mkx(page, 'company-defaults').waitFor(); await snap(page, `wd3-${v}-hard-1512`); // MOCK-HOOK
    await size(page, 'p'); await go(`wd3=${v}`, main); await snap(page, `wd3-${v}-phone-390`); // MOCK-HOOK
  } // MOCK-HOOK
  // A's stop starts in the email: the footer link, then the page it lands on (above, wd3-a-result)
  await size(page, 'd'); await page.goto('/account?wd3=a&wd2=a&msg=email'); await mkx(page, 'stop-link').scrollIntoViewIfNeeded(); // MOCK-HOOK
  await mkx(page, 'stop-link').hover(); await snap(page, 'wd3-a-stop'); // MOCK-HOOK
}); // MOCK-HOOK

test('wd3m', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('wd3m')); // MOCK-HOOK
  await size(page, 'd'); await login(page, 'approver@example.com'); // MOCK-HOOK: Priya Raman, not an owner
  for (const v of ['a', 'b', 'c']) { // MOCK-HOOK
    const main = v === 'c' ? 'delivery' : 'my-digests'; // MOCK-HOOK
    await page.goto(`/account?wd3=${v}&state=noslack`); await mkx(page, main).waitFor(); // MOCK-HOOK
    await snap(page, `wd3-${v}-open`); // MOCK-HOOK
    if (v !== 'c') { await mkx(page, 'ask-owner').click(); await snap(page, `wd3-${v}-mid`, { cost: 'Cost: 1 click to ask an owner for Slack' }); } // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test('probe', async ({ page }) => { // MOCK-HOOK
  test.skip(!run('probe')); // MOCK-HOOK
  await size(page, 'd'); await login(page); // MOCK-HOOK
  await roadmap(page, 'wd1=a'); // MOCK-HOOK
  const id = await itemId(page, 'gm-f9'); // MOCK-HOOK
  await bar(page, 'gm-f9').click(); await page.waitForTimeout(1200); // MOCK-HOOK
  await page.screenshot({ path: `${process.env.TMPDIR}/shots/f9.png` }); // MOCK-HOOK
  await size(page, 'p'); await page.goto(`/simple/roadmap?wd1=a&item=${id}`); await page.waitForTimeout(4000); // MOCK-HOOK
  await page.screenshot({ path: `${process.env.TMPDIR}/shots/phone.png` }); // MOCK-HOOK
  console.log('ID', id, await page.getByTestId('item-panel').count()); // MOCK-HOOK
}); // MOCK-HOOK

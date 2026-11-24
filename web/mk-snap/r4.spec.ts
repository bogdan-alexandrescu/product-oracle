// MOCK-HOOK: mk-undo round 4: UT1 b/c stories from the same start as their open frames, UT2 a/b/c cut stories live, UT3 a live.
import { expect, test, type Page } from '@playwright/test'; // MOCK-HOOK
import { signIn, snap, theme } from './snap'; // MOCK-HOOK

const A = ['Removed the dependency of F-63 Welcome video on F-64 In-app tour', 'Undo']; // the real change's own toast text // MOCK-HOOK
const B = ['Set F-79 Weekly alert digest to At risk', 'Undo']; // MOCK-HOOK
const C = ['Moved F-79 Weekly alert digest from Oct 31 – Dec 10 to Nov 28 – Jan 7', 'Undo']; // MOCK-HOOK
const ONLY = process.env.MK_ONLY ?? ''; // MOCK-HOOK
const t = (name: string, fn: (a: { page: Page }) => Promise<void>) => (ONLY && !name.includes(ONLY) ? test.skip(name, fn) : test(name, fn)); // MOCK-HOOK
const push = (page: Page, list: string[][]) => // MOCK-HOOK
  page.evaluate((l) => l.forEach(([m, b]) => (window as unknown as { __mk: { push: (m: string, b?: string) => void } }).__mk.push(m, b || undefined)), list); // MOCK-HOOK
async function open(page: Page, q: string, w = 1440, h = 900, email = 'admin@example.com') { // MOCK-HOOK
  await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
  await signIn(page, `/simple/roadmap?${q}&hold=1`, email); // MOCK-HOOK
  await page.locator('main h1').waitFor(); // MOCK-HOOK
  await page.waitForTimeout(2500); // MOCK-HOOK
} // MOCK-HOOK
async function real(page: Page) { // MOCK-HOOK: the one real change: the broken link's Remove the dependency
  await page.getByRole('button', { name: 'Remove the dependency' }).first().click(); // MOCK-HOOK
  await page.locator('[data-testid="draft-count"]').waitFor(); // MOCK-HOOK
  await page.evaluate(() => scrollTo(0, 0)); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
} // MOCK-HOOK
async function scrollTo(page: Page, sel: string, off: number) { // MOCK-HOOK: the page's own scroller, so sel sits off px from the top
  await page.evaluate(({ sel, off }) => { // MOCK-HOOK
    const b = document.querySelector(sel); // MOCK-HOOK
    if (!b) return; // MOCK-HOOK
    let sc: Element | null = b.parentElement; // MOCK-HOOK
    while (sc && !(/auto|scroll/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement; // MOCK-HOOK
    const dy = b.getBoundingClientRect().top - off; // MOCK-HOOK
    if (sc) sc.scrollTop += dy; else window.scrollBy(0, dy); // MOCK-HOOK
  }, { sel, off }); // MOCK-HOOK
  await page.waitForTimeout(700); // MOCK-HOOK
} // MOCK-HOOK

for (const v of ['b', 'c']) { // MOCK-HOOK
  const q = `ut1=${v}${v === 'c' ? '&open=1' : ''}`; // MOCK-HOOK
  t(`ut1 ${v} story`, async ({ page }) => { // MOCK-HOOK
    await open(page, q); // MOCK-HOOK
    await real(page); // MOCK-HOOK
    await snap(page, `ut1-${v}-rest`); // MOCK-HOOK
    await push(page, [B, C]); // MOCK-HOOK
    await snap(page, `ut1-${v}-open`); // MOCK-HOOK
    await page.keyboard.press('Shift'); // MOCK-HOOK
    await page.locator('[data-mk-line]', { hasText: 'Removed the dependency' }).locator('button', { hasText: 'Undo' }).focus(); // MOCK-HOOK
    await snap(page, `ut1-${v}-mid`); // MOCK-HOOK
    await page.keyboard.press('Enter'); // MOCK-HOOK
    await page.waitForTimeout(1500); // MOCK-HOOK
    await page.evaluate(() => scrollTo(0, 0)); // MOCK-HOOK
    await snap(page, `ut1-${v}-result`); // MOCK-HOOK
  }); // MOCK-HOOK
  t(`ut1 ${v} phone`, async ({ page }) => { // MOCK-HOOK
    await open(page, q.replace('&open=1', ''), 390, 844); // MOCK-HOOK
    await real(page); // MOCK-HOOK
    await push(page, [B, C]); // MOCK-HOOK
    await snap(page, `ut1-${v}-phone-390`); // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK
t('ut1 c detailed', async ({ page }) => { // MOCK-HOOK: the same three changes as UT1 c open, on the Plan page
  await page.setViewportSize({ width: 1440, height: 900 }); // MOCK-HOOK
  await signIn(page, '/simple/roadmap'); // MOCK-HOOK
  await page.getByTestId('mode-detailed').click(); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  const u = new URL(page.url()); // MOCK-HOOK
  await page.goto(u.pathname + (u.search ? u.search + '&' : '?') + 'ut1=c&open=1&hold=1'); // MOCK-HOOK
  await page.waitForTimeout(2500); // MOCK-HOOK
  await push(page, [A, B, C]); // MOCK-HOOK
  await snap(page, 'ut1-c-detailed'); // MOCK-HOOK
}); // MOCK-HOOK

const F79 = async (page: Page) => { // MOCK-HOOK
  await page.getByText('F-79 Weekly alert digest', { exact: false }).first().click(); // MOCK-HOOK
  await page.getByRole('button', { name: 'Change the status' }).waitFor(); // MOCK-HOOK
  await page.waitForTimeout(600); // MOCK-HOOK
}; // MOCK-HOOK
async function cut(page: Page, confirm: boolean) { // MOCK-HOOK
  await page.getByRole('button', { name: 'More actions' }).last().click(); // MOCK-HOOK
  await page.getByRole('menuitem', { name: 'Cut from the roadmap' }).waitFor(); // MOCK-HOOK
} // MOCK-HOOK
async function closePanel(page: Page) { // MOCK-HOOK: the panel closed, the page scrolled so F-79's row is in view on the timeline
  await page.keyboard.press('Escape'); // MOCK-HOOK
  await page.waitForTimeout(600); // MOCK-HOOK
  if (await page.getByRole('button', { name: 'Change the status' }).count()) { // MOCK-HOOK
    await page.getByRole('button', { name: /^Close/ }).last().click().catch(() => undefined); // MOCK-HOOK
    await page.waitForTimeout(600); // MOCK-HOOK
  } // MOCK-HOOK
  await page.evaluate(() => { // MOCK-HOOK
    const el = [...document.querySelectorAll('main *')].find((e) => e.children.length === 0 && /Weekly alert digest$/.test(e.textContent?.trim() ?? '') && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().left < 500 && !e.closest('[data-testid="conflicts"]')); // MOCK-HOOK
    el?.scrollIntoView({ block: 'center' }); // MOCK-HOOK
  }); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
} // MOCK-HOOK
for (const v of ['a', 'b', 'c']) // MOCK-HOOK
  t(`ut2 ${v} story`, async ({ page }) => { // MOCK-HOOK
    await open(page, `ut2=${v}`); // MOCK-HOOK
    await F79(page); // MOCK-HOOK
    await page.getByRole('button', { name: 'Change the confidence' }).click(); // MOCK-HOOK: a Done feature leaves the timeline, so the small change is its confidence
    await page.getByRole('combobox', { name: 'Confidence' }).selectOption({ label: 'Low' }); // MOCK-HOOK
    await page.waitForTimeout(1500); // MOCK-HOOK
    await snap(page, `ut2-${v}-rest`); // MOCK-HOOK
    await page.evaluate(() => (window as unknown as { __mk: { clear: () => void } }).__mk.clear()); // MOCK-HOOK: that toast has run out
    await cut(page, false); // MOCK-HOOK
    await snap(page, `ut2-${v}-open`); // MOCK-HOOK
    await page.getByRole('menuitem', { name: 'Cut from the roadmap' }).click(); // MOCK-HOOK
    await page.waitForTimeout(1500); // MOCK-HOOK
    const u = page.locator('[data-mk-line] button', { hasText: 'Undo' }).last(); // MOCK-HOOK
    if (v === 'c') { await page.keyboard.press('Shift'); await u.focus(); } // MOCK-HOOK
    await snap(page, `ut2-${v}-mid`); // MOCK-HOOK
    await u.click(); // MOCK-HOOK
    await page.waitForTimeout(1500); // MOCK-HOOK
    await closePanel(page); // MOCK-HOOK
    await snap(page, `ut2-${v}-result`); // MOCK-HOOK
  }); // MOCK-HOOK

async function ut3cut(page: Page) { // MOCK-HOOK: the owner cuts F-79 from its panel (today's confirm), then the toast runs out
  await F79(page); // MOCK-HOOK
  await cut(page, true); // MOCK-HOOK
  await page.getByRole('menuitem', { name: 'Cut from the roadmap' }).click(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
  const ok = page.getByRole('button', { name: /^Cut/ }).last(); // MOCK-HOOK
  if (await ok.count()) await ok.click(); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  await page.evaluate(() => (window as unknown as { __mk: { expire: () => void } }).__mk.expire()); // MOCK-HOOK
  await page.waitForTimeout(400); // MOCK-HOOK
} // MOCK-HOOK
const hist = (page: Page) => page.locator('[data-mk-history] > button').first(); // MOCK-HOOK
for (const [name, w, h, dark] of [['ut3-a-story', 1440, 900, false], ['ut3-a-open-dark', 1440, 900, true]] as const) // MOCK-HOOK
  t(name, async ({ page }) => { // MOCK-HOOK
    await open(page, 'ut3=a', w, h); // MOCK-HOOK
    if (dark) await theme(page, 'dark'); // MOCK-HOOK
    await ut3cut(page); // MOCK-HOOK
    await hist(page).evaluate((e) => e.scrollIntoView({ block: 'end' })); // MOCK-HOOK
    await page.waitForTimeout(500); // MOCK-HOOK
    if (!dark) await snap(page, 'ut3-a-rest'); // MOCK-HOOK
    await hist(page).click(); // MOCK-HOOK
    await page.waitForTimeout(500); // MOCK-HOOK
    await hist(page).evaluate((e) => e.scrollIntoView({ block: 'start' })); // MOCK-HOOK
    await page.waitForTimeout(500); // MOCK-HOOK
    if (dark) { await snap(page, 'ut3-a-open-dark'); return; } // MOCK-HOOK
    await snap(page, 'ut3-a-open'); // MOCK-HOOK
    await page.keyboard.press('Shift'); // MOCK-HOOK
    const u = page.locator('[data-mk-history] li').first().locator('button', { hasText: 'Undo' }); // MOCK-HOOK
    await u.focus(); // MOCK-HOOK
    await snap(page, 'ut3-a-mid'); // MOCK-HOOK
    await page.keyboard.press('Enter'); // MOCK-HOOK
    await page.waitForTimeout(1500); // MOCK-HOOK
    await closePanel(page); // MOCK-HOOK
    await snap(page, 'ut3-a-result'); // MOCK-HOOK
  }); // MOCK-HOOK
for (const [sfx, w, h] of [['', 1440, 900], ['-1512', 1512, 945]] as const) // MOCK-HOOK
  t(`ut3-a-hard${sfx}`, async ({ page }) => { // MOCK-HOOK: a commenter's view of the same History
    await open(page, 'ut3=a', w, h, 'commenter@example.com'); // MOCK-HOOK
    await F79(page); // MOCK-HOOK
    await hist(page).click(); // MOCK-HOOK
    await page.waitForTimeout(500); // MOCK-HOOK
    await hist(page).evaluate((e) => e.scrollIntoView({ block: 'start' })); // MOCK-HOOK
    await page.waitForTimeout(500); // MOCK-HOOK
    await snap(page, `ut3-a-hard${sfx}`); // MOCK-HOOK
  }); // MOCK-HOOK
t('ut3-a-phone-390', async ({ page }) => { // MOCK-HOOK: the same cut on a phone: History is a section of the panel sheet
  await open(page, 'ut3=a', 390, 844); // MOCK-HOOK
  await ut3cut(page); // MOCK-HOOK
  await hist(page).click(); // MOCK-HOOK
  await page.waitForTimeout(500); // MOCK-HOOK
  await hist(page).evaluate((e) => e.scrollIntoView({ block: 'start' })); // MOCK-HOOK
  await page.waitForTimeout(500); // MOCK-HOOK
  await snap(page, 'ut3-a-phone-390'); // MOCK-HOOK
}); // MOCK-HOOK
void expect; // MOCK-HOOK

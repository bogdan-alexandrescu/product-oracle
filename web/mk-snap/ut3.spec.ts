// MOCK-HOOK: mk-undo round 3: UT3 b/c phone frames on the open panel, UT3 b/c dark frames, and Detailed frames.
import { test, type Page } from '@playwright/test'; // MOCK-HOOK
import { signIn, snap, theme } from './snap'; // MOCK-HOOK

async function at(page: Page, q: string, w: number, h: number, email = 'admin@example.com') { // MOCK-HOOK
  await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
  await signIn(page, `/simple/roadmap?${q}&hold=1`, email); // MOCK-HOOK
  await page.locator('main h1').waitFor(); // MOCK-HOOK
  await page.waitForTimeout(2500); // MOCK-HOOK
} // MOCK-HOOK
const F79 = (page: Page) => page.getByText('F-79 Weekly alert digest', { exact: false }).first().click(); // MOCK-HOOK
const push = (page: Page, list: string[][]) => // MOCK-HOOK
  page.evaluate((l) => l.forEach(([m, b]) => (window as unknown as { __mk: { push: (m: string, b?: string) => void } }).__mk.push(m, b || undefined)), list); // MOCK-HOOK

for (const v of ['b', 'c']) // MOCK-HOOK
  test(`ut3-${v}-phone-390`, async ({ page }) => { // MOCK-HOOK
    await at(page, `ut3=${v}`, 390, 844); // MOCK-HOOK
    await F79(page); // MOCK-HOOK
    await page.getByRole('button', { name: 'Change the status' }).waitFor(); // MOCK-HOOK
    await page.waitForTimeout(900); // MOCK-HOOK
    await snap(page, `ut3-${v}-phone-390`); // MOCK-HOOK
  }); // MOCK-HOOK

test('ut3-b-hard-dark', async ({ page }) => { // MOCK-HOOK
  await at(page, 'ut3=b&mine=1&who=commenter', 1440, 900, 'commenter@example.com'); // MOCK-HOOK
  await theme(page, 'dark'); // MOCK-HOOK
  await snap(page, 'ut3-b-hard-dark'); // MOCK-HOOK
}); // MOCK-HOOK
test('ut3-c-open-dark', async ({ page }) => { // MOCK-HOOK
  await at(page, 'ut3=c', 1440, 900); // MOCK-HOOK
  await theme(page, 'dark'); // MOCK-HOOK
  await page.getByRole('button', { name: /^Removed · / }).first().click(); // MOCK-HOOK
  await page.waitForTimeout(900); // MOCK-HOOK
  await snap(page, 'ut3-c-open-dark'); // MOCK-HOOK
}); // MOCK-HOOK

async function detailed(page: Page, q: string, email = 'admin@example.com') { // MOCK-HOOK
  await page.setViewportSize({ width: 1440, height: 900 }); // MOCK-HOOK
  await signIn(page, '/simple/roadmap', email); // MOCK-HOOK
  await page.getByTestId('mode-detailed').click(); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  const u = new URL(page.url()); // MOCK-HOOK
  await page.goto(u.pathname + (u.search ? u.search + '&' : '?') + q + '&hold=1'); // MOCK-HOOK
  await page.waitForTimeout(2500); // MOCK-HOOK
} // MOCK-HOOK
test('ut1-c-detailed', async ({ page }) => { // MOCK-HOOK
  await detailed(page, 'ut1=c&open=1'); // MOCK-HOOK
  await push(page, [ // MOCK-HOOK
    ['Set F-79 Weekly alert digest to At risk', 'Undo'], // MOCK-HOOK
    ['Moved F-79 Weekly alert digest from Oct 31 – Dec 10 to Nov 28 – Jan 7', 'Undo'], // MOCK-HOOK
    ['Set F-88 Quiet hours for alerts to At risk', 'Undo'], // MOCK-HOOK
  ]); // MOCK-HOOK
  await snap(page, 'ut1-c-detailed'); // MOCK-HOOK
}); // MOCK-HOOK
test('ut2-a-detailed', async ({ page }) => { // MOCK-HOOK
  await detailed(page, 'ut2=a', 'commenter@example.com'); // MOCK-HOOK
  await push(page, [['Status change proposed: it waits for Avery Stone', 'Withdraw']]); // MOCK-HOOK
  await snap(page, 'ut2-a-detailed'); // MOCK-HOOK
}); // MOCK-HOOK

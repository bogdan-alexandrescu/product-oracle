// MOCK-HOOK: mk-undo round 3: UT3 b/c phone frames on the open panel, UT3 b/c dark frames, and Detailed frames.
import { test, type Page } from '@playwright/test';
import { signIn, snap, theme } from './snap';

async function at(page: Page, q: string, w: number, h: number, email = 'admin@example.com') {
  await page.setViewportSize({ width: w, height: h });
  await signIn(page, `/simple/roadmap?${q}&hold=1`, email);
  await page.locator('main h1').waitFor();
  await page.waitForTimeout(2500);
}
const F79 = (page: Page) => page.getByText('F-79 Weekly alert digest', { exact: false }).first().click();
const push = (page: Page, list: string[][]) =>
  page.evaluate((l) => l.forEach(([m, b]) => (window as unknown as { __mk: { push: (m: string, b?: string) => void } }).__mk.push(m, b || undefined)), list);

for (const v of ['b', 'c'])
  test(`ut3-${v}-phone-390`, async ({ page }) => {
    await at(page, `ut3=${v}`, 390, 844);
    await F79(page);
    await page.getByRole('button', { name: 'Change the status' }).waitFor();
    await page.waitForTimeout(900);
    await snap(page, `ut3-${v}-phone-390`);
  });

test('ut3-b-hard-dark', async ({ page }) => {
  await at(page, 'ut3=b&mine=1&who=commenter', 1440, 900, 'commenter@example.com');
  await theme(page, 'dark');
  await snap(page, 'ut3-b-hard-dark');
});
test('ut3-c-open-dark', async ({ page }) => {
  await at(page, 'ut3=c', 1440, 900);
  await theme(page, 'dark');
  await page.getByRole('button', { name: /^Removed · / }).first().click();
  await page.waitForTimeout(900);
  await snap(page, 'ut3-c-open-dark');
});

async function detailed(page: Page, q: string, email = 'admin@example.com') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, '/simple/roadmap', email);
  await page.getByTestId('mode-detailed').click();
  await page.waitForTimeout(1500);
  const u = new URL(page.url());
  await page.goto(u.pathname + (u.search ? u.search + '&' : '?') + q + '&hold=1');
  await page.waitForTimeout(2500);
}
test('ut1-c-detailed', async ({ page }) => {
  await detailed(page, 'ut1=c&open=1');
  await push(page, [
    ['Set F-79 Weekly alert digest to At risk', 'Undo'],
    ['Moved F-79 Weekly alert digest from Oct 31 – Dec 10 to Nov 28 – Jan 7', 'Undo'],
    ['Set F-88 Quiet hours for alerts to At risk', 'Undo'],
  ]);
  await snap(page, 'ut1-c-detailed');
});
test('ut2-a-detailed', async ({ page }) => {
  await detailed(page, 'ut2=a', 'commenter@example.com');
  await push(page, [['Status change proposed: it waits for Avery Stone', 'Withdraw']]);
  await snap(page, 'ut2-a-detailed');
});

// MOCK-HOOK: mk-undo round 3: UT2's commenter frames (hard, 1512, phone, dark) and UT3 b/c phone frames on the open panel, snapped live.
import { test, type Page } from '@playwright/test';
import { signIn, snap, theme } from './snap';

async function panel(page: Page, q: string, w: number, h: number, email: string) {
  await page.setViewportSize({ width: w, height: h });
  await signIn(page, `/simple/roadmap?${q}&hold=1`, email);
  await page.locator('main h1').waitFor();
  await page.waitForTimeout(2500);
  await page.getByText('F-79 Weekly alert digest', { exact: false }).first().click();
  await page.getByRole('button', { name: 'Change the status' }).waitFor();
  await page.waitForTimeout(500);
}
async function propose(page: Page, v: string) {
  await page.getByRole('button', { name: 'Change the status' }).click();
  await page.locator('select').filter({ has: page.locator('option', { hasText: /^Done$/ }) }).last().selectOption({ label: 'Done' });
  await page.waitForTimeout(1500);
  if (v === 'd') { // d's toast names Proposals on it: the panel shows it, with the proposal and its Withdraw
    await page.getByText('Proposals on it', { exact: true }).first().evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(900);
  }
}
for (const v of ['a', 'b', 'c', 'd'])
  for (const [sfx, w, h, dark] of [['', 1440, 900, false], ['-1512', 1512, 945, false], ['-dark', 1440, 900, true], ['phone-390', 390, 844, false]] as const) {
    if (dark && v === 'a') continue; // a's dark frame stays
    const name = sfx === 'phone-390' ? `ut2-${v}-phone-390` : `ut2-${v}-hard${sfx}`;
    test(name, async ({ page }) => {
      await panel(page, `ut2=${v}`, w, h, 'commenter@example.com');
      if (dark) await theme(page, 'dark');
      await propose(page, v);
      await page.waitForTimeout(800);
      await snap(page, name);
    });
  }

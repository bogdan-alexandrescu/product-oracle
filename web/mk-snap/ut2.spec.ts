// MOCK-HOOK: mk-undo round 3: UT2's commenter frames (hard, 1512, phone, dark) and UT3 b/c phone frames on the open panel, snapped live.
import { test, type Page } from '@playwright/test'; // MOCK-HOOK
import { signIn, snap, theme } from './snap'; // MOCK-HOOK

async function panel(page: Page, q: string, w: number, h: number, email: string) { // MOCK-HOOK
  await page.setViewportSize({ width: w, height: h }); // MOCK-HOOK
  await signIn(page, `/simple/roadmap?${q}&hold=1`, email); // MOCK-HOOK
  await page.locator('main h1').waitFor(); // MOCK-HOOK
  await page.waitForTimeout(2500); // MOCK-HOOK
  await page.getByText('F-79 Weekly alert digest', { exact: false }).first().click(); // MOCK-HOOK
  await page.getByRole('button', { name: 'Change the status' }).waitFor(); // MOCK-HOOK
  await page.waitForTimeout(500); // MOCK-HOOK
} // MOCK-HOOK
async function propose(page: Page, v: string) { // MOCK-HOOK
  await page.getByRole('button', { name: 'Change the status' }).click(); // MOCK-HOOK
  await page.locator('select').filter({ has: page.locator('option', { hasText: /^Done$/ }) }).last().selectOption({ label: 'Done' }); // MOCK-HOOK
  await page.waitForTimeout(1500); // MOCK-HOOK
  if (v === 'd') { // d's toast names Proposals on it: the panel shows it, with the proposal and its Withdraw // MOCK-HOOK
    await page.getByText('Proposals on it', { exact: true }).first().evaluate((e) => e.scrollIntoView({ block: 'center' })); // MOCK-HOOK
    await page.waitForTimeout(900); // MOCK-HOOK
  } // MOCK-HOOK
} // MOCK-HOOK
for (const v of ['a', 'b', 'c', 'd']) // MOCK-HOOK
  for (const [sfx, w, h, dark] of [['', 1440, 900, false], ['-1512', 1512, 945, false], ['-dark', 1440, 900, true], ['phone-390', 390, 844, false]] as const) { // MOCK-HOOK
    if (dark && v === 'a') continue; // a's dark frame stays // MOCK-HOOK
    const name = sfx === 'phone-390' ? `ut2-${v}-phone-390` : `ut2-${v}-hard${sfx}`; // MOCK-HOOK
    test(name, async ({ page }) => { // MOCK-HOOK
      await panel(page, `ut2=${v}`, w, h, 'commenter@example.com'); // MOCK-HOOK
      if (dark) await theme(page, 'dark'); // MOCK-HOOK
      await propose(page, v); // MOCK-HOOK
      await page.waitForTimeout(800); // MOCK-HOOK
      await snap(page, name); // MOCK-HOOK
    }); // MOCK-HOOK
  } // MOCK-HOOK

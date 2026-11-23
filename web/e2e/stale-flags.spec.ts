import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * stale-flags: a flag clears once the action it asks for is done, wherever it is done.
 *
 * - Pick an owner: the draft's owner picked in its panel is the owner its flag reads, so
 *   "Draft with no owner to confirm it" leaves Needs a decision at once.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const card = (page: Page) => page.getByTestId('floating-card');
const tray = (page: Page) => page.getByTestId('decision-tray');

test.describe('stale flags', () => {
  test.use(DESKTOP);

  test("an owner picked through Pick an owner clears the draft's owner flag", async ({ page }) => {
    // protects: Pick an owner opens the draft's panel; the owner saved there is the one the flag reads, so the flag leaves Other flags
    // fails_when: the flag reads another field than the panel's Owner (the track's owner), or the roadmap is not read again after the change
    // no_claim: the Needs a decision number (Other flags are listed, not counted)
    await login(page);
    await page.goto('/simple/roadmap');
    await expect(page.getByTestId('simple-roadmap')).toBeVisible();
    await page.getByTestId('needs-decision').click();
    const flag = tray(page).getByTestId('tray-flag').filter({ hasText: 'Team invite nudges' });
    await expect(flag).toContainText('Draft with no owner to confirm it');
    await flag.getByRole('button', { name: 'Pick an owner' }).click();
    await expect(card(page)).toContainText('Team invite nudges');
    await card(page).getByRole('button', { name: 'Change the owner' }).click();
    const pick = card(page).getByTestId('card-owner-edit').getByLabel('Owner');
    await expect(pick.locator('option').nth(1)).toBeAttached();
    const name = (await pick.locator('option').nth(1).textContent())!;
    await pick.selectOption({ index: 1 });
    await card(page).getByTestId('card-owner-edit').getByRole('button', { name: 'Save' }).click();
    await expect(card(page).getByTestId('card-owner')).toHaveText(name);
    await page.keyboard.press('Escape');
    await page.getByTestId('needs-decision').click();
    await expect(tray(page)).toBeVisible();
    await expect(
      tray(page).getByTestId('tray-flag').filter({ hasText: 'Team invite nudges' }),
    ).toHaveCount(0);
  });
});

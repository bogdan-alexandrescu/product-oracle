import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * #1917: a decision with fewer than two options, opened from Home, is decided on Simple's
 * decision sheet. Card sheet-decide: protects = the sheet's Decide (the decision's own
 * can_decide, the same decide call as Home's), the sheet then saying it is decided, and Home
 * and Decisions dropping it at once; no one else sees Decide; fails_when = the sheet has no
 * Decide, shows it to who may not decide, or the lists keep the decision open; no_claim =
 * Home's inline Decide (simple-home-qa-nov12-decisions.spec.ts), Detailed's decision page.
 */

const sheet = (page: Page) => page.getByTestId('decision-sheet');

async function addDecision(page: Page, title: string, decider: string) {
  await page.goto('/simple/decisions');
  await page.getByTestId('decisions-new').click();
  const s = sheet(page);
  await s.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await s.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Yes, through spring');
  await s.getByRole('button', { name: 'Pick' }).click();
  await s
    .getByRole('group', { name: 'Who decides' })
    .getByRole('button', { name: decider })
    .click();
  await s.getByRole('button', { name: 'Add decision' }).click();
  await expect(s).toHaveCount(0);
}

test("a one-option decision opened from Home is decided on Simple's sheet, never Detailed", async ({
  page,
}) => {
  await login(page);
  await addDecision(page, 'Keep the example beta open', 'Avery Stone');

  await page.goto('/simple');
  const row = page.getByTestId('home-decision').filter({ hasText: 'Keep the example beta open' });
  await row.getByRole('link', { name: 'Open' }).click();
  const s = sheet(page);
  await expect(s).toContainText('Keep the example beta open');
  // One option: the decide call needs two, so Decide waits until Edit adds one.
  const decide = s.getByRole('button', { name: 'Decide', exact: true });
  await expect(decide).toBeDisabled();
  await s.getByRole('button', { name: 'Edit' }).click();
  await s.getByRole('button', { name: '+ Add an option' }).click();
  await s.getByRole('textbox', { name: 'Option 2', exact: true }).fill('No, close it in winter');
  await s.getByRole('button', { name: 'Save' }).click();
  await expect(s).toHaveCount(0);

  await page.getByTestId('decision-open').filter({ hasText: 'Keep the example beta open' }).click();
  await decide.click();
  await s
    .getByRole('group', { name: 'Decide' })
    .getByRole('button', { name: 'Yes, through spring' })
    .click();

  await expect(s.getByTestId('decision-sheet-decided')).toHaveText('Decided: Yes, through spring');
  await expect(s.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  // Decisions under the sheet no longer lists it as open.
  await page.keyboard.press('Escape');
  await expect(s).toHaveCount(0);
  await expect(
    page.getByTestId('decision-open').filter({ hasText: 'Keep the example beta open' }),
  ).toHaveCount(0);

  await page.goto('/simple');
  // Home has loaded (its PRD questions show) and no longer lists the decision.
  await expect(page.getByRole('button', { name: 'Decide as recommended' }).first()).toBeVisible();
  await expect(
    page.getByTestId('home-decision').filter({ hasText: 'Keep the example beta open' }),
  ).toHaveCount(0);
});

test('who may not decide sees no Decide on the sheet', async ({ page }) => {
  await login(page);
  await addDecision(page, 'Pause the example newsletter', 'Priya Raman');
  await page.goto('/simple/decisions');
  await page
    .getByTestId('decision-open')
    .filter({ hasText: 'Pause the example newsletter' })
    .click();
  const s = sheet(page);
  await expect(s.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(s.getByRole('button', { name: /^Decide/ })).toHaveCount(0);
});

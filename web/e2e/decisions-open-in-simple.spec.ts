import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/**
 * #1818: a decision opened from Simple lands in Simple's decision sheet, never in Detailed's
 * Company › Decisions. Card decisions-open-in-simple: protects = the feature panel's open
 * decisions, Home's and Simple's Inbox's Open on a decision and Decisions' ?decision= address open the sheet on
 * /simple/decisions; fails_when = any of them leaves /simple or lands without the sheet;
 * no_claim = the walk (fix2-simple-home-review.spec.ts), the draft banner's decision notes
 * (decision-notes-banner.spec.ts) and the waiting list's link (tests/test_simple_waiting_list.py).
 */

const sheet = (page: Page) => page.getByTestId('decision-sheet');

test("the feature panel's open decision opens in Simple's decision sheet", async ({ page }) => {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-digest');
  const card = page.getByTestId('floating-card');
  await card
    .getByTestId('card-decisions')
    .getByRole('link', { name: 'Send the digest weekly or daily?' })
    .click();
  await expect(page).toHaveURL(/\/simple\/decisions\?decision=[0-9a-f-]+$/);
  await expect(sheet(page)).toContainText('Send the digest weekly or daily?');
});

test("Home's Open on a decision opens it in Simple's decision sheet", async ({ page }) => {
  await login(page);
  // A call with one option has no Decide on Home, only Open.
  await page.goto('/simple/decisions');
  await page.getByTestId('decisions-new').click();
  const s = sheet(page);
  await s.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep the example beta open');
  await s.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Yes, through spring');
  await s.getByRole('button', { name: 'Pick' }).click();
  await s
    .getByRole('group', { name: 'Who decides' })
    .getByRole('button', { name: 'Avery Stone' })
    .click();
  await s.getByRole('button', { name: 'Add decision' }).click();
  await expect(s).toHaveCount(0);

  await page.goto('/simple');
  const row = page.getByTestId('home-decision').filter({ hasText: 'Keep the example beta open' });
  await row.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/simple\/decisions\?decision=\d+$/);
  await expect(sheet(page)).toContainText('Keep the example beta open');
  // And its row in Simple's Inbox opens it there too, never in Detailed.
  await page.goto('/simple/inbox');
  await page.getByRole('link', { name: 'Open Keep the example beta open' }).first().click();
  await expect(page).toHaveURL(/\/simple\/decisions\?decision=\d+$/);
  await expect(sheet(page)).toContainText('Keep the example beta open');
});

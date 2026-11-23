import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * de-prd (the owner's pick PR2 a "Click to type", PR 1696): a PRD's one-pager lists its features
 * under their goals, and a value a person may change turns into its field on a click, saves on
 * Enter or a click away (Esc cancels), with a Saved mark and Undo. Each goal ends with an add row:
 * type, Enter, and the feature is in the PRD and on the Roadmap with its code. A row's menu moves
 * it to Trash at once, with Undo. Who may only propose files the same gesture as a proposal (a
 * pending mark); a viewer has no handles. Mock PRD "Usage alerts"; invented data.
 */

const URL = '/simple/one-pagers/usage-alerts';
const NAME = 'Weekly alert digest';

test.use({ viewport: { width: 1440, height: 900 } });

async function onePager(page: Page, email?: string) {
  await login(page, email);
  await page.goto(URL);
  await expect(row(page, NAME)).toBeVisible();
}

const features = (page: Page) => page.getByTestId('op-features');
const row = (page: Page, name: string) =>
  features(page).getByTestId('op-feature').filter({ hasText: name });

test('an admin renames a feature in place: Enter saves, Undo puts it back, Esc cancels', async ({
  page,
}) => {
  await onePager(page);
  await row(page, NAME).getByTestId('op-feature-name').click();
  const field = features(page).getByLabel(`Name of ${NAME}`);
  await field.fill('Weekly alert summary');
  await field.press('Enter');
  const renamed = row(page, 'Weekly alert summary');
  await expect(renamed).toBeVisible();
  await expect(renamed.getByTestId('op-saved')).toBeVisible();
  await expect(renamed).toContainText('F-79');
  await renamed.getByTestId('op-undo').click();
  await expect(row(page, NAME)).toBeVisible();

  // Esc leaves it as it was.
  await row(page, NAME).getByTestId('op-feature-name').click();
  await features(page).getByLabel(`Name of ${NAME}`).fill('Not kept');
  await features(page).getByLabel(`Name of ${NAME}`).press('Escape');
  await expect(row(page, NAME)).toBeVisible();
  await expect(features(page)).not.toContainText('Not kept');
});

test("an admin sets a feature's owner and its dates in place", async ({ page }) => {
  await onePager(page);
  await row(page, NAME).getByTestId('op-feature-owner').click();
  const pick = features(page).getByLabel(`Owner of ${NAME}`);
  const someone = (await pick.locator('option').nth(1).textContent()) ?? '';
  expect(someone).not.toBe('');
  await pick.selectOption({ label: someone });
  await expect(row(page, NAME).getByTestId('op-feature-owner')).toHaveText(someone);
  await expect(row(page, NAME).getByTestId('op-saved')).toBeVisible();

  await row(page, NAME).getByTestId('op-feature-dates').click();
  await features(page).getByLabel(`Start of ${NAME}`).fill('2026-11-02');
  await features(page).getByLabel(`End of ${NAME}`).fill('2026-12-18');
  await features(page).getByLabel(`End of ${NAME}`).press('Enter');
  await expect(row(page, NAME).getByTestId('op-feature-dates')).toHaveText(
    'Nov 2, 2026 – Dec 18, 2026',
  );
  // Saved: the API's read again holds both.
  await expect(row(page, NAME).getByTestId('op-saved')).toBeVisible();
  await expect(row(page, NAME).getByTestId('op-feature-owner')).toHaveText(someone);
});

test('an admin adds a feature under a goal with Enter; it has its code and is on the Roadmap', async ({
  page,
}) => {
  await onePager(page);
  const goal = features(page).getByTestId('op-goal').first();
  await goal.getByTestId('op-add-feature').click();
  const field = goal.getByRole('textbox', { name: /New feature in/ });
  await field.fill('Alert snooze');
  await field.press('Enter');
  // The field stays for the next one.
  await expect(field).toBeFocused();
  const added = goal.getByTestId('op-feature').filter({ hasText: 'Alert snooze' });
  await expect(added).toBeVisible();
  await expect(added.locator('.simple-code')).toHaveText(/^F-\d+$/);
  await page.goto('/simple/roadmap');
  await expect(page.getByText('Alert snooze').first()).toBeVisible();
});

test("an admin moves a feature to Trash from its row's menu; Undo brings it back", async ({
  page,
}) => {
  await onePager(page);
  await row(page, NAME).getByTestId('op-feature-menu').click();
  await row(page, NAME).getByTestId('op-feature-remove').click();
  await expect(row(page, NAME)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, NAME)).toBeVisible();
});

test('a commenter proposes a new name with the same gesture: the row keeps its name, marked pending', async ({
  page,
}) => {
  await onePager(page, 'commenter@example.com');
  await row(page, NAME).getByTestId('op-feature-name').click();
  const field = features(page).getByLabel(`Name of ${NAME}`);
  await field.fill('Weekly alert summary');
  await field.press('Enter');
  await expect(row(page, NAME).getByTestId('op-pending')).toBeVisible();
  await expect(row(page, 'Weekly alert summary')).toHaveCount(0);
});

test('a viewer reads the features with no handles', async ({ page }) => {
  await onePager(page, 'viewer@example.com');
  await expect(features(page).getByTestId('op-add-feature')).toHaveCount(0);
  await expect(features(page).getByTestId('op-feature-menu')).toHaveCount(0);
  await row(page, NAME).getByTestId('op-feature-name').click();
  await expect(features(page).getByLabel(`Name of ${NAME}`)).toHaveCount(0);
});

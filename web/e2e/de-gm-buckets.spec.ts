import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * de-gm part 2: features edited directly in Priorities > Goal buckets (no dated plan), driven
 * through the UI against the mock ("goal-buckets-undated": invented goals and features).
 *
 * Cards (protects / fails_when / no_claim):
 * - quick add: protects=a bucket's + Add takes a name and Enter, the feature serves that goal at
 *   once, the field stays for the next; fails_when=a form with Save is needed or it lands
 *   elsewhere; no_claim=the full New feature form (goal-buckets-tasks).
 * - rename in place: protects=F2 or a double-click on a feature's name turns it into a field,
 *   Enter saves, Esc leaves it; fails_when=the name stays or Esc saves.
 * - delete with Undo: protects=Delete on a feature's name moves it to Trash with no dialog and
 *   Undo brings it back; fails_when=a dialog asks or the row stays.
 * - who: a viewer has no + Add and no rename.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    'goal-buckets-undated',
  ] as const);
  await login(page, email);
  await page.goto('/simple/priorities?tab=buckets');
  await expect(bucket(page, 'Reliability').locator('[data-code="F-03"]')).toBeVisible();
}

const bucket = (page: Page, goal: string) =>
  page
    .getByTestId('goal-bucket')
    .filter({ has: page.getByRole('heading', { name: goal, exact: true }) });
const row = (page: Page, goal: string, name: string) =>
  bucket(page, goal).getByTestId('plan-feature').filter({ hasText: name });

test.describe('Goal buckets: features edited in place', () => {
  test('+ Add in a bucket adds a feature serving that goal; Enter keeps the field', async ({
    page,
  }) => {
    await open(page);
    const growth = bucket(page, 'Growth');
    await growth.hover();
    await growth.getByTestId('quick-add-open').click();
    const field = growth.getByTestId('quick-add-input');
    await field.fill('Example gift notes');
    await field.press('Enter');
    await expect(field).toBeFocused();
    await field.fill('Example gift wrap');
    await field.press('Enter');
    await expect(row(page, 'Growth', 'Example gift notes')).toBeVisible();
    await expect(row(page, 'Growth', 'Example gift wrap')).toBeVisible();
    await expect(growth.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await field.press('Escape');
    await expect(growth.getByTestId('quick-add-input')).toHaveCount(0);
  });

  test('F2 or a double-click renames a feature in place; Esc leaves it', async ({ page }) => {
    await open(page);
    const open_ = bucket(page, 'Reliability')
      .locator('[data-code="F-03"]')
      .getByTestId('plan-feature-open');
    const was = (await open_.textContent())!.trim();
    await open_.focus();
    await page.keyboard.press('F2');
    await page.getByTestId('plan-feature-rename').fill('Example quiet retries');
    await page.getByTestId('plan-feature-rename').press('Escape');
    await expect(open_).toHaveText(was);
    await open_.dblclick();
    await page.getByTestId('plan-feature-rename').fill('Example quiet retries');
    await page.getByTestId('plan-feature-rename').press('Enter');
    await expect(row(page, 'Reliability', 'Example quiet retries')).toBeVisible();
    // Saved with no Save step: the note says so, and it reads so after a reload.
    await expect(page.getByTestId('bucket-note')).toBeVisible();
    await page.reload();
    await expect(row(page, 'Reliability', 'Example quiet retries')).toBeVisible();
  });

  test('Delete moves a feature to Trash with no dialog; Undo brings it back', async ({ page }) => {
    await open(page);
    const f = bucket(page, 'Reliability').locator('[data-code="F-03"]');
    await f.getByTestId('plan-feature-open').focus();
    await page.keyboard.press('Delete');
    await expect(f).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page
      .getByRole('status')
      .filter({ hasText: /to Trash/ })
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(bucket(page, 'Reliability').locator('[data-code="F-03"]')).toBeVisible();
  });

  test('a viewer has no + Add and no rename', async ({ page }) => {
    await open(page, 'viewer@example.com');
    await expect(page.getByTestId('quick-add-open')).toHaveCount(0);
    await bucket(page, 'Reliability')
      .locator('[data-code="F-03"]')
      .getByTestId('plan-feature-open')
      .dblclick();
    await expect(page.getByTestId('plan-feature-rename')).toHaveCount(0);
  });

  test('someone who may only propose files the add as a proposal', async ({ page }) => {
    await open(page, 'approver@example.com');
    const growth = bucket(page, 'Growth');
    await growth.hover();
    await growth.getByTestId('quick-add-open').click();
    await growth.getByTestId('quick-add-input').fill('Example proposed notes');
    await growth.getByTestId('quick-add-input').press('Enter');
    await expect(page.getByTestId('bucket-note')).toContainText('waits for a decision');
    await expect(row(page, 'Growth', 'Example proposed notes')).toHaveCount(0);
  });
});

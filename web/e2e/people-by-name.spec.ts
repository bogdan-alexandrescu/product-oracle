import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { clearName, login } from './helpers';
import { expect, test } from './test';

/**
 * #1763: a member with no name of their own shows by the one name rule ("approver@example.com"
 * reads "Approver"), never as a bare email address and never as "someone": on Home's next
 * meeting, the Meetings list, the Decisions page's meetings and its Runs (who decided each
 * stop). The owner clears the name in Settings › Members, as a person would.
 */

const EMAIL = 'approver@example.com';

test('a member without a name shows by name on Home, Meetings and Decisions', async ({ page }) => {
  await clearName(page, EMAIL);
  await login(page);

  await page.goto('/simple/meetings');
  const rows = page.getByTestId('meetings-upcoming-row');
  await expect(rows.first()).toBeVisible();
  // A row's text runs its attendees into the action ("ApproverStart review") now that no
  // "Pre-read not ready yet" note follows them (#1914), so no \b after the name.
  await expect(rows.filter({ hasText: /\bApprover(?![a-z])/ }).first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(EMAIL);
  await expect(rows.filter({ hasText: /\bsomeone\b/ })).toHaveCount(0);

  await page.goto('/simple/decisions');
  const attendees = page.locator('main').getByText(/^Attendees: /);
  await expect(attendees.first()).toBeVisible();
  await expect(attendees.filter({ hasText: /\bApprover\b/ }).first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(EMAIL);

  await page.goto('/simple');
  await expect(
    page
      .locator('main')
      .getByText(/\d+ attendees?: /)
      .first(),
  ).toBeVisible();
  await expect(page.locator('main')).toContainText(/\d+ attendees?: [^·]*\bApprover(?![a-z])/);
  await expect(page.locator('main')).not.toContainText(EMAIL);
});

test('a member without a name shows by name on a run stop in Decisions', async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    MOCK_SCENARIO_KEY,
    'run-decisions',
  ] as const);
  await clearName(page, EMAIL);
  await login(page);
  await page.goto('/simple/decisions');
  const runs = page.getByRole('region', { name: 'Runs' });
  const rows = runs.getByTestId('run-stop-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: /\bApprover \(approver\)/ }).first()).toBeVisible();
  await expect(runs).not.toContainText(EMAIL);
});

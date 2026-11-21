import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test } from './test';

/*
 * mock-buckets: the real API always holds the company's goal buckets, so a goal's target date is a
 * goal milestone on the roadmap whichever page a person opens first. On invented data (the mock's
 * "simple-plan" scenario, whose goal Reliability has a target date of Feb 12, 2027).
 *
 * Card goal-milestone-roadmap-first: protects = a person who opens Roadmap before Priorities sees
 * the goal's target-date milestone on the Milestones band; fails_when = the goal milestone shows
 * only after Priorities (Goal buckets) has been opened.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const TITLE = 'Reliability';

test("Roadmap opened first shows a goal's target-date milestone", async ({ page }) => {
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      'simple-plan',
    ] as const);
  await login(page);
  // Straight to Roadmap: Priorities is never opened.
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await expect(page.getByTestId('ms-band')).toBeVisible();
  // The goal's target date, drawn as a goal milestone named for the goal.
  await expect(
    page
      .getByTestId('ms-label')
      .filter({ has: page.locator('[data-testid="mk-icon"][data-kind="goal"]') })
      .filter({ hasText: TITLE }),
  ).toHaveCount(1);
  await page.locator(`[data-testid="ms-diamond"][data-kind="goal"][data-day="2027-02-12"]`).click();
  await expect(page.getByTestId('ms-card').getByRole('textbox', { name: 'Name' })).toHaveValue(
    TITLE,
  );
});

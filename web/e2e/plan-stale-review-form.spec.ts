import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * The owner's report (Nov 23): 29 of 60 flagged roadmap items showed their stale reason once,
 * with no Review and no Still valid…, and the Inbox's Review (/plan?item=<key>&review=1) opened
 * no form. On the mock layer, "plan-decider" (usage-alerts-roadmap v1 approved) flags the Weekly
 * alert digest (its Plan reasons say it may be out of date) with no stale alert on its track, as
 * the API read an item whose track holds no alert for it; "track-alerts-stale" adds a stale
 * alert on "Budgets per team". The API's half (the item under the track its
 * alerts are raised on) is api/tests/test_stale_settled_on_approval.py.
 */

const ITEM = 'alert-digest';
const STALE = 'The feature and 2 goals changed';

async function withStale(page: Page, email?: string, scenario = 'plan-decider') {
  await page.addInitScript(([key, scenario]) => localStorage.setItem(key, scenario), [
    MOCK_SCENARIO_KEY,
    scenario,
  ] as const);
  await login(page, email);
}

const panel = (page: Page) => page.getByTestId('plan-inspector').filter({ visible: true });
const staleReason = (page: Page) =>
  panel(page).locator('[data-testid="plan-reason"][data-kind="stale"]');

// protects = a flagged item with no stale alert opens Still valid… from the Inbox's Review link
// (?review=1), and marking it still valid takes its stale reason away; fails_when = the panel
// shows the reason with no field, or the reason stays; no_claim = the alerts' own card (the
// inbox-track-alerts-walk spec).
test('Review on a flagged item with no stale alert opens Still valid…, and marking it clears it', async ({
  page,
}) => {
  await withStale(page);
  await page.goto(`/plan?item=${ITEM}&review=1`);
  const reason = staleReason(page);
  await expect(reason).toContainText(STALE);
  await reason.getByLabel('Why it is still valid').fill('Still the digest the team asked for');
  await reason.getByRole('button', { name: 'Mark still valid' }).click();
  await expect(staleReason(page)).toHaveCount(0);
  await expect(panel(page)).not.toContainText(STALE);
});

// protects = without ?review=1 the same item offers Review, which opens the field, and Cancel
// closes it; fails_when = no Review; no_claim = the API's refusals.
test("the flagged item's Review opens Still valid…, and Cancel closes it", async ({ page }) => {
  await withStale(page);
  await page.goto(`/plan?item=${ITEM}`);
  const reason = staleReason(page);
  await expect(reason.getByLabel('Why it is still valid')).toHaveCount(0);
  await reason.getByRole('button', { name: 'Review' }).click();
  await expect(reason.getByLabel('Why it is still valid')).toBeVisible();
  await reason.getByRole('button', { name: 'Cancel' }).click();
  await expect(reason.getByLabel('Why it is still valid')).toHaveCount(0);
});

// protects = a reader who may not settle a stale item is told who can, behind a tip, and gets
// no Review; fails_when = a viewer sees Review or no tip; no_claim = the roles (the API's).
test('a viewer is told who marks a stale item still valid, behind a tip', async ({ page }) => {
  await withStale(page, 'viewer@example.com');
  await page.goto(`/plan?item=${ITEM}&review=1`);
  const reason = staleReason(page);
  await expect(reason).toContainText(STALE);
  await expect(reason.getByRole('button', { name: 'Review' })).toHaveCount(0);
  await expect(reason.getByLabel('Why it is still valid')).toHaveCount(0);
  await expect(reason.getByTestId('plan-stale-who')).toBeVisible();
});

// protects = a stale alert's card a viewer may not settle says who can, behind a tip; fails_when
// = no tip; no_claim = the alert's actions (the API's).
test("a stale alert's card tells a viewer who marks it still valid", async ({ page }) => {
  await withStale(page, 'viewer@example.com', 'track-alerts-stale');
  await page.goto('/plan?item=team-budgets');
  const card = panel(page).locator('[data-testid="plan-alert"][data-kind="stale"]');
  await expect(card.getByTestId('plan-stale-who')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Review' })).toHaveCount(0);
});

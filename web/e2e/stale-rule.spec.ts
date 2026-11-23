import { expect, test, type Page } from './test';

import { STALE_RULE_SCENARIO } from '../lib/api/mock/roadmap';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';

/*
 * The stale rule (the owner, Nov 23): confirming a proposed feature into the Ground Truth raises
 * the standing of the same content, so it makes no approved roadmap item stale; editing what the
 * feature says does, and the reason names the edit. The scenario puts the approved item Budgets
 * per team on the proposed feature Usage export, beside one item that is stale already. The API's
 * rule, for every kind of change, is proven by api/tests/test_stale_rule.py.
 */

const ITEM = 'Budgets per team';
const FEATURE = 'Usage export';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Oracle' });
const trackLabel = (page: Page) =>
  page.locator('[data-need="Track"]').filter({ visible: true }).getByTestId('track-label');
const alertRow = (page: Page, item: string) =>
  page.locator('[data-need="Track alert"]').filter({ visible: true }).filter({ hasText: item });
const planRow = (page: Page) =>
  page.locator('[data-testid="plan-row"][data-item="team-budgets"]').filter({ visible: true });
const inspector = (page: Page) => page.getByTestId('plan-inspector').filter({ visible: true });

async function openInbox(page: Page) {
  await rail(page).getByTestId('nav-inbox').click();
  await expect(page).toHaveURL(/\/inbox$/);
}

async function openPlan(page: Page) {
  await rail(page).getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
}

async function openFeature(page: Page) {
  await page.goto('/ground-truth');
  await page.getByRole('button', { name: FEATURE, exact: true }).first().click();
  return page.getByRole('dialog', { name: FEATURE });
}

// protects = confirming the feature an approved item is on leaves the item and the Inbox, Plan and
// panel as they were; renaming it marks the item everywhere, its reason naming the edit; fails_when
// = a confirmation marks the item, or a rename does not; no_claim = the API's own marking.
test('confirming a feature marks no item; renaming it marks the item on it', async ({ page }) => {
  await page.addInitScript(
    ([key, scenario]) => localStorage.setItem(key, scenario),
    [MOCK_SCENARIO_KEY, STALE_RULE_SCENARIO] as const,
  );
  await login(page);
  await openInbox(page);
  await expect(trackLabel(page)).toHaveText('Usage alerts PRD · At risk · 1 need you');

  const d = await openFeature(page);
  await d.getByRole('button', { name: 'Confirm' }).click();
  await expect(d.getByRole('status').filter({ hasText: 'Confirmed' })).toBeVisible();

  await openInbox(page);
  await expect(trackLabel(page)).toHaveText('Usage alerts PRD · At risk · 1 need you');
  await expect(alertRow(page, ITEM)).toHaveCount(0);
  await openPlan(page);
  await expect(planRow(page)).not.toContainText('At risk');
  await planRow(page).getByTestId('plan-title').click();
  await expect(inspector(page).getByTestId('plan-why')).toHaveCount(0);

  const edit = await openFeature(page);
  await edit.getByRole('button', { name: 'Edit' }).click();
  const form = edit.getByRole('form', { name: 'Edit' });
  await form.getByLabel('Title').fill('Usage export by team');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);

  const reason = 'The feature "Usage export by team" changed';
  await openInbox(page);
  await expect(trackLabel(page)).toHaveText('Usage alerts PRD · At risk · 2 need you');
  await expect(alertRow(page, ITEM).getByTestId('track-alert-detail')).toHaveText(reason);
  await openPlan(page);
  await planRow(page).getByTestId('plan-title').click();
  await expect(inspector(page).getByTestId('plan-why')).toContainText(reason);
  await expect(inspector(page).getByTestId('plan-why')).not.toContainText('confirmed');
});

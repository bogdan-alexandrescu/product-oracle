import { expect, test, type Page } from './test';

import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login } from './helpers';

/*
 * The owner's decision (Nov 23): approving a roadmap version settles every item that version
 * keeps. On the mock layer, "plan-approve-stale" (lib/api/mock/roadmap.ts) flags the Weekly
 * alert digest of the approved plan with a stale alert on the Usage alerts track; the mock's approve route settles the kept
 * items as the API's staleness.settle_on_approval does (api/tests/test_stale_settled_on_approval.py
 * proves the rule). Here a person proposes a plan change that keeps the item and approves it,
 * and the Inbox and the Plan follow without a reload.
 */

const STALE = 'Weekly alert digest';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Oracle' });
const trackLabel = (page: Page) =>
  page.locator('[data-need="Track"]').filter({ visible: true }).getByTestId('track-label');
const alertRows = (page: Page) =>
  page.locator('[data-need="Track alert"]').filter({ visible: true });
const changes = (page: Page) => page.getByTestId('plan-changes').filter({ visible: true });
const panel = (page: Page) => page.getByTestId('plan-inspector').filter({ visible: true });
const staleReason = (page: Page) =>
  panel(page).locator(
    '[data-testid="plan-reason"][data-kind="stale"], [data-testid="plan-alert"][data-kind="stale"]',
  );
const staleRow = (page: Page) =>
  page.locator('[data-testid="plan-row"][data-item="alert-digest"]').filter({ visible: true });

async function openInbox(page: Page) {
  await rail(page).getByTestId('nav-inbox').click();
  await expect(page).toHaveURL(/\/inbox$/);
}

// protects = approving a roadmap version that keeps a flagged item settles it: its stale reason
// leaves its Plan panel, and its stale alert the Inbox's track rows and count, with no reload;
// fails_when = the mock's approve leaves the item flagged, or the Inbox keeps its old rows until
// a reload; no_claim = the API's rule (api/tests/test_stale_settled_on_approval.py).
test('approving a version that keeps a flagged item settles it on the Plan and in the Inbox', async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, 'plan-approve-stale'),
    MOCK_SCENARIO_KEY,
  );
  await login(page);
  await openInbox(page);
  await expect(trackLabel(page)).toHaveText('Usage alerts PRD · At risk · 1 need you');
  await expect(alertRows(page).filter({ hasText: STALE })).toHaveCount(1);

  await rail(page).getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await staleRow(page).getByTestId('plan-title').click();
  await expect(staleReason(page)).toHaveCount(1);

  // A change that keeps the Weekly alert digest as it is: Usage dashboard moves to Next.
  await page.getByTestId('plan-edit').click();
  await changes(page)
    .getByTestId('edit-item')
    .filter({ hasText: 'Usage dashboard' })
    .getByLabel('Horizon of Usage dashboard')
    .selectOption('next');
  await changes(page).getByRole('button', { name: 'Propose changes' }).click();
  await changes(page).getByRole('button', { name: 'Approve version 2' }).click();
  await expect(page.getByTestId('plan-live')).toHaveText('Version 2 is the live plan.');

  await staleRow(page).getByTestId('plan-title').click();
  await expect(panel(page)).toBeVisible();
  await expect(staleReason(page)).toHaveCount(0);

  await openInbox(page);
  await expect(trackLabel(page)).toHaveCount(0);
  await expect(alertRows(page).filter({ hasText: STALE })).toHaveCount(0);
});

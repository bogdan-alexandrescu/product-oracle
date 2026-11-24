import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * inbox-ux (Nov 24): the UX audit's Inbox findings (#1782 to #1786) and the Plan header's
 * at-risk count (#1741). The "inbox-ux" mock scenario (lib/api/mock/roadmap.ts) puts two stale
 * alerts on the Usage alerts track: F-31 Alert routing by team (two reasons) and the Weekly
 * alert digest (no code). The API's item code is proven by api/tests/test_inbox_alert_codes.py.
 */

async function withAlerts(page: Page, scenario = 'inbox-ux') {
  await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [
    MOCK_SCENARIO_KEY,
    scenario,
  ] as const);
  await login(page);
}

const alertRow = (page: Page, text: string) =>
  page.locator('[data-need="Track alert"]').filter({ visible: true, hasText: text });

// protects=#1782; fails_when=Simple's Inbox is drawn full width with Detailed's header, not the
// shared Simple page; no_claim=the Simple page's own styles.
test("Simple's Inbox is a Simple page; Detailed's keeps its own header", async ({ page }) => {
  await login(page);
  await page.goto('/simple/inbox');
  const simple = page.getByTestId('simple-page');
  await expect(simple.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(simple.getByTestId('inbox-needs')).toBeVisible();
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-needs')).toBeVisible();
  await expect(page.getByTestId('simple-page')).toHaveCount(0);
});

// protects=#1783; fails_when=a tab with nothing hides its count, or the Inbox opens on a tab that
// does not hold what Needs you counts; no_claim=the counts' sums (inbox-one.spec.ts).
test('every tab shows its count and the Inbox opens on the tab that holds what needs you', async ({
  page,
}) => {
  await login(page);
  await page.goto('/simple/inbox');
  const tabs = page.getByTestId('inbox-state-tabs');
  await expect(tabs.getByRole('tab', { name: /^New\s*\d+$/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Seen holds nothing on the first visit: it still shows its 0.
  await expect(tabs.getByRole('tab', { name: 'Seen 0' })).toBeVisible();
  // The next visit: New is empty, so the Inbox opens on Seen, which holds what Needs you counts.
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'New 0' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /^Seen [1-9]\d*$/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

// protects=#1785; fails_when=the Inbox words a track "At risk" where the Roadmap says "Needs a
// look"; no_claim=the track's health itself.
test("a track's status reads as on the Roadmap: Needs a look", async ({ page }) => {
  await withAlerts(page);
  await page.goto('/simple/inbox');
  await expect(
    page.locator('[data-need="Track"]').filter({ visible: true }).getByTestId('track-label'),
  ).toHaveText('Usage alerts PRD · Needs a look · 2 need you');
  // #1786: the row's age carries its label (a clock named "Age").
  const age = page.locator('[data-need="Track"]').filter({ visible: true }).getByTestId('need-age');
  await expect(age.getByRole('img', { name: 'Age', exact: true })).toHaveCount(1);
  await expect(age.locator('svg')).toHaveCount(1);
  await expect(age).toHaveText(/^\d+[mhdw]$/);
});

// protects=#1786; fails_when=an alert's item shows no code (or no flag when it has none), its
// reasons run on cut off with no way to read them whole, or the child's kind column is a bare
// rule; no_claim=the reasons' wording (inbox-track-alerts-walk.spec.ts).
test('an alert names its item with its code and its reasons in one line, whole on expand', async ({
  page,
}) => {
  await withAlerts(page);
  await page.goto('/simple/inbox');
  const coded = alertRow(page, 'Alert routing by team');
  await expect(coded.getByTestId('child-title')).toHaveText('F-31 Alert routing by team');
  await expect(coded.getByTestId('not-in-gt')).toHaveCount(0);
  const plain = alertRow(page, 'Weekly alert digest');
  await expect(plain.getByTestId('not-in-gt')).toBeVisible();
  // The kind sits in the left column, no empty rule.
  await expect(coded.locator('td').first()).toHaveText('May be stale');
  const detail = coded.getByTestId('track-alert-detail');
  await expect(detail).toHaveText('5 Ground Truth items changed');
  await coded.getByRole('button', { name: 'Show 1 more' }).click();
  await expect(detail).toHaveText(
    '5 Ground Truth items changed; PRD section Behaviour changed in version 2',
  );
  await coded.getByRole('button', { name: 'Show less' }).click();
  await expect(detail).toHaveText('5 Ground Truth items changed');
});

// protects=#1784; fails_when=an alert row offers its actions side by side (Review, Keep
// watching, Open) instead of one primary and the rest in a menu; no_claim=Keep watching's write
// (track-alerts.spec.ts).
test('an alert row has one primary action and the rest in a menu', async ({ page }) => {
  await withAlerts(page);
  await page.goto('/simple/inbox');
  const row = alertRow(page, 'Alert routing by team');
  const actions = row.locator('[data-child-actions]');
  await expect(
    actions.getByRole('link', { name: 'Review F-31 Alert routing by team' }),
  ).toBeVisible();
  await expect(actions.getByRole('button', { name: /^Keep watching/ })).toHaveCount(0);
  await expect(actions.getByRole('link', { name: /^Open/ })).toHaveCount(0);
  await actions
    .getByRole('button', { name: 'More actions for F-31 Alert routing by team' })
    .click();
  const menu = actions.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Keep watching', 'Open in Plan']);
  await menu.getByRole('menuitem', { name: 'Keep watching' }).click();
  await expect(row.getByTestId('track-keep-field')).toBeVisible();
});

// protects=#1741; fails_when=the Plan header says "N at risk" without naming items, or the count
// leads nowhere; no_claim=the count's rule (api/tests for plan.service and the stale rule).
test("the Plan's at-risk count names items and opens the items it counts", async ({ page }) => {
  // "track-alerts": the Plan's Weekly alert digest is at risk (its date slipped).
  await withAlerts(page, 'track-alerts');
  await page.goto('/plan');
  const chip = page.getByTestId('plan-count-at-risk');
  const button = chip.getByRole('button', { name: /^\d+ items? at risk$/ });
  await expect(button).toBeVisible();
  const n = Number((await button.innerText()).match(/\d+/)![0]);
  await button.click();
  const items = chip.getByRole('menuitem');
  await expect(items).toHaveCount(n);
  const first = (await items.first().innerText()).trim();
  await items.first().click();
  await expect(chip.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('plan-inspector').filter({ visible: true })).toContainText(
    first.replace(/^F-\d+\s+/, ''),
  );
});

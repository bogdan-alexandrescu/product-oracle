import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/**
 * owner-filter (owner, Nov 23: "filter by owner as well"): Simple > Roadmap's filter row has an
 * Owner select right after Track: All, each person who owns an item (its own owner, else its
 * track's) by name, then No owner. It narrows the Timeline and Now / Next / Later, combines with
 * Track, is cleared by Clear filters and comes back after a reload. Driven through the UI against
 * the mock's "simple-deciders" scenario (invented people: the alerts track's Avery Lane, the
 * onboarding track's Cory Hale, the welcome track's Vic Moss; "Price tiers" has no track, so no
 * owner); desktop (1366x820).
 *
 * Card: protects=the Simple roadmap's Owner filter sits after Track, lists each owner by name then
 * No owner, narrows the Timeline and Now / Next / Later, combines with Track, clears, and
 * survives a reload; fails_when=an option is missing or misplaced, an owner shows others' items,
 * a reload forgets it, or Clear filters leaves it; no_claim=owners set in the real API.
 */

const ROADMAP = '/simple/roadmap';
const ALERTS = ['alert-rules', 'alert-digest'];
const ONBOARDING = ['setup-checklist', 'setup-import'];
const WELCOME = ['setup-tour', 'setup-video'];
const NOBODY = ['price-tiers'];

const filter = (page: Page, name: string): Locator =>
  page.getByTestId('filters').getByRole('combobox', { name, exact: true });
const row = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);
const boardCard = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="board-card"][data-item="${key}"]`);

/** Every key in `shown` is drawn at least once by `at`, and none in `hidden`. */
async function only(at: (key: string) => Locator, shown: string[], hidden: string[]) {
  for (const k of shown) await expect(at(k).first()).toBeAttached();
  for (const k of hidden) await expect(at(k)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, 'simple-deciders']);
  await login(page);
  await page.goto(ROADMAP);
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await expect(page.getByTestId('timeline-row').first()).toBeAttached();
});

test('Owner sits after Track and lists each owner by name, then No owner', async ({ page }) => {
  const labels = await page
    .getByTestId('filters')
    .getByRole('combobox')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(labels.indexOf('Owner')).toBe(labels.indexOf('Track') + 1);
  const options = await filter(page, 'Owner').locator('option').allTextContents();
  expect(options[0]).toBe('All');
  expect(options.at(-1)).toBe('No owner');
  for (const name of ['Avery Lane', 'Cory Hale', 'Vic Moss']) expect(options).toContain(name);
});

test('an owner shows only their items in the Timeline and Now / Next / Later', async ({ page }) => {
  await filter(page, 'Owner').selectOption({ label: 'Avery Lane' });
  await only((k) => row(page, k), ALERTS, [...ONBOARDING, ...WELCOME, ...NOBODY]);
  await page.getByTestId('format-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await only((k) => boardCard(page, k), ALERTS, [...ONBOARDING, ...WELCOME, ...NOBODY]);

  // No owner: only the items nobody owns.
  await filter(page, 'Owner').selectOption({ label: 'No owner' });
  await only((k) => boardCard(page, k), NOBODY, [...ALERTS, ...ONBOARDING, ...WELCOME]);
  await page.getByTestId('format-timeline').click();
  await only((k) => row(page, k), NOBODY, [...ALERTS, ...ONBOARDING, ...WELCOME]);
});

test('Owner survives a reload, combines with Track and clears with the others', async ({
  page,
}) => {
  await filter(page, 'Owner').selectOption({ label: 'Vic Moss' });
  await only((k) => row(page, k), WELCOME, [...ALERTS, ...ONBOARDING, ...NOBODY]);

  await page.reload();
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await expect(filter(page, 'Owner').locator('option:checked')).toHaveText('Vic Moss');
  await only((k) => row(page, k), WELCOME, [...ALERTS, ...ONBOARDING, ...NOBODY]);

  await filter(page, 'Track').selectOption({ label: 'Guided setup track' });
  // Vic Moss owns nothing on the onboarding track.
  await expect(page.getByTestId('filters-empty')).toBeVisible();
  await filter(page, 'Owner').selectOption({ label: 'Cory Hale' });
  await only((k) => row(page, k), ONBOARDING, [...ALERTS, ...WELCOME, ...NOBODY]);
  await filter(page, 'Owner').selectOption({ label: 'Avery Lane' });
  await expect(page.getByTestId('filters-empty')).toBeVisible();
  await page.getByTestId('filters-empty').getByRole('button', { name: 'Clear filters' }).click();
  await expect(filter(page, 'Owner')).toHaveValue('');
  await expect(filter(page, 'Track')).toHaveValue('');
  await only((k) => row(page, k), [...ALERTS, ...WELCOME, ...NOBODY], []);
});

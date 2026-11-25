import { MOCK_ZONE_STATE_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * #1721: when the Company time zone cannot be read, every page that shows dates says so once,
 * behind an (i) ("Company time zone not available · Pacific is used"); read as fetched, no
 * tip. Detailed and Simple through the shell (GET /v1/me's state); the Claude accounts pool
 * through its own read's `time_zone_state`, which can fail alone.
 */

const TIP = 'Company time zone not available · Pacific is used';

async function zoneState(page: Page, state: 'unavailable' | 'pool-unavailable') {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_ZONE_STATE_KEY,
    state,
  ] as const);
}

async function saysIt(page: Page) {
  const tip = page.getByTestId('zone-unavailable');
  await expect(tip).toHaveCount(1);
  await tip.click();
  await expect(page.getByText(TIP)).toBeVisible();
}

for (const [where, path, ready] of [
  ['Detailed Home', '/home', 'nav-home'],
  ['Simple Home', '/simple', 'simple-nav-home'],
] as const) {
  test(`${where}: an unreadable Company time zone is said once`, async ({ page }) => {
    await zoneState(page, 'unavailable');
    await login(page);
    await page.goto(path);
    await expect(page.getByTestId(ready).first()).toBeVisible();
    await saysIt(page);
  });

  test(`${where}: a fetched Company time zone says nothing`, async ({ page }) => {
    await login(page);
    await page.goto(path);
    await expect(page.getByTestId(ready).first()).toBeVisible();
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.getByTestId('zone-unavailable')).toHaveCount(0);
  });
}

test('Claude accounts: the pool says its own read of the zone failed', async ({ page }) => {
  await zoneState(page, 'pool-unavailable');
  await login(page);
  await page.goto('/settings/claude-accounts');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await saysIt(page);
});

test('Claude accounts: a fetched zone says nothing', async ({ page }) => {
  await login(page);
  await page.goto('/settings/claude-accounts');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByTestId('zone-unavailable')).toHaveCount(0);
});

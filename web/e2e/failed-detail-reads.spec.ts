
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/**
 * #1713: a read that failed never looks like nothing. A metric's or a decision's detail that
 * answered once and then fails for the next row picked shows Could not load with Try again in
 * the inspector (and in the sheet on a phone), not an empty inspector; Members' list of what
 * Oracle could not revoke, read once, then failing on its next read, says it could not check,
 * with Try again, instead of hiding access that may still be held.
 * fails_when = the inspector or sheet shows nothing for a failed detail read, or the revoke
 * section disappears when its read fails.
 */

const failGets = (page: Page, path: string) =>
  page.evaluate((p) => localStorage.setItem('po-mock-fail', p), path);
const stopFailing = (page: Page) => page.evaluate(() => localStorage.removeItem('po-mock-fail'));
/** Past the time a read's answer is shared (lib/api/shared-reads FRESH_MS), so the next read fetches. */
const pastSharing = (page: Page) => page.clock.fastForward(5_000);

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** The failed read's notice: plain words, the server's behind an (i), Try again. */
async function expectFailed(scope: Locator, what: string) {
  const notice = scope.getByTestId('load-error');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`Could not load ${what}.`);
  await expect(notice.getByText('Mock failure')).toBeHidden();
  return notice;
}

type Case = {
  page: string;
  what: string;
  row: string;
  inspector: string;
  sheet: string;
  scenario?: string;
  /** The API path of the row the URL now has picked. */
  path: (url: URL) => string;
};

const CASES: Case[] = [
  {
    page: '/company/metrics',
    what: 'the metric',
    row: 'metric-row',
    inspector: 'metric-inspector',
    sheet: 'metric-sheet',
    scenario: 'metrics',
    path: (url) => `/v1/metrics/${url.searchParams.get('metric')}`,
  },
  {
    page: '/company/decisions',
    what: 'the decision',
    row: 'decision-row',
    inspector: 'decision-inspector',
    sheet: 'decision-sheet',
    path: (url) => `/v1/decisions/${url.searchParams.get('d')}`,
  },
];

for (const c of CASES) {
  test(`${c.page}: a detail read that fails after one answered says so in the inspector`, async ({
    page,
  }) => {
    if (c.scenario) await scenario(page, c.scenario);
    await login(page);
    await page.goto(c.page);
    const rows = page.getByTestId(c.row);
    await rows.nth(1).click();
    await expect(page.getByTestId(c.inspector)).toBeVisible();
    const second = c.path(new URL(page.url()));
    await rows.nth(0).click();
    await expect(page.getByTestId(c.inspector)).toBeVisible();
    await failGets(page, second);
    await pastSharing(page);
    await rows.nth(1).click();
    const notice = await expectFailed(page.getByRole('main'), c.what);
    await expect(page.getByTestId(c.inspector)).toHaveCount(0);
    await stopFailing(page);
    await notice.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId(c.inspector)).toBeVisible();
    await expect(page.getByTestId('load-error')).toHaveCount(0);
  });

  test(`${c.page}: on a phone, the sheet opens on a failed detail read`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (c.scenario) await scenario(page, c.scenario);
    await login(page);
    await page.goto(c.page);
    const rows = page.getByTestId(c.row);
    await rows.nth(1).click();
    const sheet = page.getByTestId(c.sheet);
    await expect(sheet.getByTestId(c.inspector)).toBeVisible();
    const second = c.path(new URL(page.url()));
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await rows.nth(0).click();
    await expect(sheet.getByTestId(c.inspector)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await failGets(page, second);
    await pastSharing(page);
    await rows.nth(1).click();
    const notice = await expectFailed(sheet, c.what);
    await stopFailing(page);
    await notice.getByRole('button', { name: 'Try again' }).click();
    await expect(sheet.getByTestId(c.inspector)).toBeVisible();
  });
}

test('Members: a failed read of what Oracle could not revoke says so, and Try again reads it', async ({
  page,
}) => {
  await scenario(page, 'revoke-failures');
  await login(page);
  await page.getByRole('navigation', { name: 'Oracle' }).getByTestId('nav-settings').click();
  await page.getByRole('navigation', { name: 'Settings' }).getByTestId('nav-members').click();
  const section = page.getByTestId('revoke-failures');
  const items = section.getByTestId('revoke-failure');
  await expect(items).toHaveCount(2);
  // Answered once; the next read (after this Retry) fails.
  await failGets(page, '/v1/inbox');
  await items.filter({ hasText: 'GitHub' }).getByRole('button', { name: 'Retry' }).click();
  const notice = section.getByTestId('revoke-failures-error');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Could not check what Oracle could not revoke.');
  await expect(notice.getByText('Mock failure')).toBeHidden();
  await stopFailing(page);
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice).toHaveCount(0);
  await expect(items).toHaveCount(1);
});

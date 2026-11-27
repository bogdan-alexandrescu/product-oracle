import { HOME_3_SCENARIO } from '../lib/api/mock/home-3';
import { HOME_MILESTONES_SCENARIO } from '../lib/api/mock/home-milestones';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * home-3 (issues 1900, 1897), Simple's Home on the live shapes the tidy mock lacked (invented
 * data, desktop).
 *
 * 1900: protects = every "Since your last visit" entry names its item by code and name, opening
 * its panel, though the change stores only the id an older roadmap version gave the item; an item
 * since dropped keeps its last name, with no link; fails_when = "changed the owner of an item".
 * 1897: protects = an undated milestone with no pencil says who sets its date, and where, in its
 * (i); fails_when = "No date" with nothing to act on.
 */

test.use({ viewport: { width: 1512, height: 756 } });

const scenario = (page: Page) =>
  page
    .context()
    .addInitScript(([key, v]) => localStorage.setItem(key, v), [
      MOCK_SCENARIO_KEY,
      HOME_3_SCENARIO,
    ] as const);

test('1900: every change since my last visit names its item and opens its panel', async ({
  page,
}) => {
  await scenario(page);
  await login(page);
  await page.goto('/simple');
  const rows = page.getByTestId('home-since').getByTestId('home-since-row');
  await expect(rows).toHaveCount(5);
  for (const text of await rows.allInnerTexts()) expect(text).not.toContain('an item');
  for (const [said, name] of [
    ['changed the owner of', 'Alert rules engine'],
    ["accepted Oracle's dates for", 'Mobile alert push'],
    ['marked', 'Alert history export'],
    ['added', 'In-app tour'],
  ]) {
    const row = rows.filter({ hasText: `Theo Brandt ${said} ${name}` });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('home-since-item')).toHaveText(new RegExp(name));
  }
  // The dropped item: its last name, nothing to open.
  const gone = rows.filter({ hasText: 'Theo Brandt changed the owner of Example widget' });
  await expect(gone.getByTestId('home-since-item')).toHaveCount(0);
  await rows.filter({ hasText: 'Mobile alert push' }).getByTestId('home-since-item').click();
  await expect(page.getByTestId('item-panel')).toContainText('Mobile alert push');
});

test('1897: an undated milestone with no pencil says who sets its date and where', async ({
  page,
}) => {
  await scenario(page);
  await login(page);
  await page.goto('/simple');
  const line = page
    .getByTestId('home-plan')
    .getByTestId('home-strip-line')
    .filter({ hasText: /Field trial/ });
  await expect(line.getByTestId('home-strip-no-date')).toHaveText('No date');
  await expect(line.getByTestId('home-strip-rename')).toHaveCount(0);
  await line.getByTestId('home-strip-items-tip').click();
  await expect(page.locator('[data-testid=home-strip-date-by]:visible')).toHaveText(
    'Its date is set on the Plan page.',
  );
});

test('1897: a viewer who may not date a roadmap milestone is told who does', async ({ page }) => {
  await page
    .context()
    .addInitScript(([key, v]) => localStorage.setItem(key, v), [
      MOCK_SCENARIO_KEY,
      HOME_MILESTONES_SCENARIO,
    ] as const);
  await login(page, 'viewer@example.com');
  await page.goto('/simple');
  const line = page
    .getByTestId('home-plan')
    .getByTestId('home-strip-line')
    .filter({ hasText: /^M\d+ · Launch \(beta\) · 3 items/ });
  await expect(line.getByTestId('home-strip-no-date')).toHaveText('No date');
  await expect(line.getByTestId('home-strip-rename')).toHaveCount(0);
  await line.getByTestId('home-strip-items-tip').click();
  await expect(page.locator('[data-testid=home-strip-date-by]:visible')).toHaveText(
    "The roadmap's owner or decider sets its date.",
  );
});

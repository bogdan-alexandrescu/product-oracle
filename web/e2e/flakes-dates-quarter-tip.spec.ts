import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';
import { login, openRoadmapItem } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * flakes-dates 4a: an item added to a quarter whose date suggestion a new dependency outdates,
 * its new dates still inside that quarter: the Dates (i) names the quarter. Mock scenario
 * "simple-quarter-dates" (invented data): Health log added to Q2 2027, suggested Apr 1 – Apr 28.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId('floating-card');

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

async function openItem(page: Page, key: string) {
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

test('a dependency that moves an item inside its picked quarter: the Dates (i) names the quarter', async ({
  page,
}) => {
  // protects: the (i) of dates moved after what it depends on, still inside the quarter it was
  // added to, names that quarter; fails_when: it reads the column's window words alone
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    'simple-quarter-dates',
  ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();

  await openItem(page, 'setup-import');
  await tap(panel(page).getByRole('button', { name: 'Change the dates' }));
  await panel(page).getByLabel('Start', { exact: true }).fill('2027-03-01');
  await panel(page).getByLabel('End', { exact: true }).fill('2027-04-10');
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-dates')).toContainText('Apr 10, 2027');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);

  await openItem(page, 'setup-health-log');
  const why = panel(page).getByTestId('card-dates-why');
  await expect(panel(page).getByTestId('card-dates')).toContainText('Apr 1 – Apr 28, 2027');
  await expect(why).toHaveAccessibleDescription(/Oracle suggested these dates/);
  await tap(panel(page).getByRole('button', { name: 'Add a dependency' }));
  await panel(page)
    .getByLabel('Feature it depends on')
    .selectOption({ label: 'Sample data import' });
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(
    panel(page).getByTestId('card-depends-row').filter({ hasText: 'Sample data import' }),
  ).toBeVisible();
  await expect(panel(page).getByTestId('card-dates')).toContainText('Apr 11 – May 8, 2027');
  await expect(why).not.toHaveAccessibleDescription(/fall outside/);
  await expect(why).toHaveAccessibleDescription(
    /after what it depends on, inside Q2 2027, the quarter it was added to/,
  );
});

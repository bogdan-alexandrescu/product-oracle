import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { login, openRoadmapItem } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * panel-2 (#1906, #1907): the feature panel's read-only words, on the mock's "panel-words"
 * scenario (invented data): the company's three owners decide Weekly alert digest, its title
 * carries its PRD's name and "(P0)", its note is the one Oracle writes on a roadmap version, and
 * its goal's target ends in milestone shorthand.
 */

test.use({ viewport: { width: 1512, height: 756 } });

const panel = (page: Page) => page.getByTestId('floating-card');

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await l.click();
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, 'panel-words'), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-digest');
  await expect(panel(page)).toBeVisible();
});

test('#1906 several deciders read as any one of them, with why behind an (i)', async ({ page }) => {
  const decider = panel(page).getByTestId('card-decider');
  await expect(decider).toContainText(/^Any of: .*Robin Hart, Sam Ortiz/);
  await tap(decider.getByRole('button', { name: 'About who decides' }));
  await expect(page.getByText('Any one of them can decide.')).toBeVisible();
});

test("#1907 the title is the feature's name; Notes, Dates and Target read in plain words", async ({
  page,
}) => {
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Weekly alert digest');
  await expect(panel(page).getByTestId('card-prd')).toHaveText('Usage alerts');

  await expect(panel(page).getByTestId('card-notes')).toHaveText(
    'Carried over from the last roadmap',
  );
  await expect(panel(page).getByTestId('card-goal-target')).toHaveText('70% of teams');
  await expect(panel(page).getByTestId('card-goal-reading')).toContainText(
    'target 70% of teams by',
  );
  await expect(panel(page).getByTestId('card-goal-reading')).not.toContainText('(M2)');

  await tap(panel(page).getByRole('button', { name: 'Change the dates' }));
  await panel(page).getByLabel('Start', { exact: true }).fill('2026-12-01');
  await panel(page).getByLabel('End', { exact: true }).fill('2027-01-29');
  await tap(panel(page).getByRole('button', { name: 'Save' }));
  await expect(panel(page).getByTestId('card-dates-kind')).toHaveText('Set by a person');
});

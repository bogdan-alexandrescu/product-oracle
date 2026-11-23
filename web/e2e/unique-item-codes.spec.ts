import { MOCK_SCENARIO_KEY, UNIQUE_CODES_SCENARIO } from '../lib/api/mock/server';

import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/*
 * unique-codes (the owner, Nov 23): every roadmap item has its own code; nothing shares one.
 * Two items of one Ground Truth feature (F-01, invented data): Setup checklist reads the
 * feature's code, Sample data import its own (F-88), on the Roadmap and in the panel, which
 * still names the feature it is part of; a code another item reads is refused in plain words.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId('floating-card');
const row = (page: Page, key: string) =>
  page.locator(`[data-testid="timeline-row"][data-item="${key}"]`).first();

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    UNIQUE_CODES_SCENARIO,
  ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

test('two items of one feature read two codes, on the Roadmap and in the panel', async ({
  page,
}) => {
  // protects=an item's own code (its title's) before its feature's, the feature still named in
  // its panel; fails_when=both items read F-01; no_claim=the migration renumbering (pytest).
  await open(page);
  await expect(row(page, 'setup-checklist')).toContainText('F-01');
  await expect(row(page, 'setup-import')).toContainText('F-88');
  await expect(row(page, 'setup-import')).not.toContainText('F-01');
  await openRoadmapItem(page, 'setup-import');
  // Its own code first; the feature's name is behind the (i) beside it.
  await expect(panel(page).getByTestId('card-code')).toHaveText(/^F-88(?!\d)/);
  await panel(page).getByRole('button', { name: 'About its feature' }).click();
  await expect(panel(page).getByText(/Part of the Ground Truth feature F-01 /)).toBeVisible();
  await page.keyboard.press('Escape');
  await openRoadmapItem(page, 'setup-checklist');
  await expect(panel(page).getByTestId('card-code')).toHaveText(/^F-01(?!\d)/);
});

test('a code another item reads is refused, naming that item', async ({ page }) => {
  // protects=set_code on an item of a feature takes a code of its own; one another item reads
  // is refused in plain words and nothing changes; fails_when=the item reads F-01 after Save, or
  // its code may not be changed at all; no_claim=a Ground Truth feature's own key (pytest).
  await open(page);
  await openRoadmapItem(page, 'setup-import');
  await panel(page).getByRole('button', { name: 'Change the code' }).click();
  await panel(page).getByLabel('Code').fill('F-01');
  await panel(page).getByTestId('card-code-edit').getByRole('button', { name: 'Save' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /F-01 is already the code of F-01 Setup checklist/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, 'setup-import')).toContainText('F-88');
});

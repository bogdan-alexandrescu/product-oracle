import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * de-r2 (the owner, Nov 23): a goal's name is changed right on its Roadmap card: a click opens it
 * for typing, Enter saves it at once (no Save, no dialog), Esc cancels. A viewer reads it with no
 * handle. Mock scenario "simple-milestones" (invented goals and people).
 */

const VIEWER = 'viewer@example.com';

async function open(page: Page, email?: string) {
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      'simple-milestones',
    ] as const);
  await login(page, email);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('goal-counters')).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test("a click on a goal's name renames it in place: Enter saves, Esc cancels", async ({ page }) => {
  await open(page);
  const name = page.getByTestId('goal-counter-title-edit').first();
  const was = (await name.textContent())!;
  await name.click();
  const input = page.getByTestId('goal-counter-title-input');
  await expect(input).toBeFocused();
  await input.fill('Should not stay');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('goal-counter-title-edit').first()).toHaveText(was);

  await page.getByTestId('goal-counter-title-edit').first().click();
  await input.fill('Teams keep using alerts');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(
    page.getByTestId('goal-counter-title').filter({ hasText: 'Teams keep using alerts' }),
  ).toBeVisible();
  await expect(page.getByTestId('goal-counter-title').filter({ hasText: was })).toHaveCount(0);
});

test("a viewer reads a goal's name with no handle", async ({ page }) => {
  await open(page, VIEWER);
  await expect(page.getByTestId('goal-counter-title').first()).toBeVisible();
  await expect(page.getByTestId('goal-counter-title-edit')).toHaveCount(0);
});

import { PALETTE_KR_SCENARIO } from '../lib/api/mock/palette';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { ADMIN } from './helpers';
import { fitsTheScreen, palette, paletteBox, pressFind, rows, signIn } from './palette-helpers';
import { expect, test } from './test';

/*
 * build-palette (#1794), CP3 a 'Find in the rail': a Find row at the top of the Simple rail with
 * its ⌘K hint, a Find tile in Detailed's narrow rail, a search button in the phone's top bar
 * beside Ask; each opens the same palette as ⌘K. Mock API, invented data.
 */

for (const dark of [false, true]) {
  test(`Find in the Simple rail finds a key result and lands on its goal on Goal map${dark ? ' (dark)' : ''}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
      MOCK_SCENARIO_KEY,
      PALETTE_KR_SCENARIO,
    ] as const);
    await signIn(page, ADMIN.email, '/simple');
    const find = page.getByTestId('palette-entry').filter({ visible: true });
    await expect(find).toContainText('Find');
    await expect(find).toContainText('⌘K');
    await find.click();
    await expect(palette(page)).toBeVisible();
    await paletteBox(page).fill('sign-ups per rep');
    await expect(page.getByTestId('palette-list')).toContainText('Key results');
    await expect(rows(page).first()).toContainText('Sign-ups per rep per day');
    await expect(rows(page).first()).toContainText('Key result · Growth');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
    const goal = page.getByTestId('gm-goal').filter({ hasText: 'Growth' });
    await expect(goal).toBeInViewport();
    expect(page.url()).toContain((await goal.getAttribute('data-goal'))!);
  });
}

test('A goal is found as a goal and lands on Goal map', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('revenue per day');
  await expect(rows(page).first()).toContainText('Goal · Goal map');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
});

test('Detailed’s narrow rail has a Find tile', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, ADMIN.email, '/home');
  await page.getByTestId('palette-entry').filter({ visible: true }).click();
  await expect(palette(page)).toBeVisible();
});

test('On a phone a search button in the top bar opens it full screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN.email, '/simple/roadmap');
  const button = page.getByTestId('palette-entry-phone').filter({ visible: true });
  await expect(button).toHaveAccessibleName('Find');
  await fitsTheScreen(page);
  await button.click();
  await expect(palette(page)).toBeVisible();
  await expect(page.getByTestId('palette-close')).toBeVisible();
  await page.getByTestId('palette-close').click();
  await expect(button).toBeFocused();
});

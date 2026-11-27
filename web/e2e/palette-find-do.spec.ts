import { ADMIN } from './helpers';
import { palette, paletteBox, pressFind, rows, signIn } from './palette-helpers';
import { expect, test } from './test';

/*
 * build-palette (#1794), CP2 b 'Find and do': actions sit in the same list as what it finds (New
 * item, New PRD, Ask Oracle, a page). "new …" turns the words into a new item's title and adds it
 * on the roadmap; Tab on a feature shows its own actions; with no match Enter adds the words as an
 * item. The palette goes by the person's role through can(): a commenter proposes, a viewer adds
 * nothing, and a short line says so. Mock API, invented members (example.com).
 */

test('The empty box shows Do and Go to; Enter on a page goes there', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  const list = page.getByTestId('palette-list');
  for (const name of ['New item', 'New PRD', 'Ask Oracle', 'Roadmap', 'Goal map'])
    await expect(rows(page).filter({ hasText: name }).first()).toBeVisible();
  await expect(page.getByTestId('palette-role')).toHaveCount(0);
  await paletteBox(page).fill('goal map');
  await expect(list).toContainText('Go to');
  await rows(page).filter({ hasText: 'Goal map' }).first().click();
  await expect(page).toHaveURL(/\/simple\/goals/);
});

test('Typing "new Quiet hours for alerts" adds the item on the roadmap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('new Quiet hours for alerts');
  await expect(rows(page).first()).toContainText('New item: Quiet hours for alerts');
  await expect(rows(page).first()).toContainText('Roadmap · last track used');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple\/roadmap/);
  await expect(page.getByText('Quiet hours for alerts').first()).toBeVisible({ timeout: 15_000 });
});

test('Tab on a feature shows its own actions; Show it on the Roadmap opens its panel there', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('F-79');
  await expect(rows(page).first()).toContainText('Weekly alert digest');
  await page.keyboard.press('Tab');
  await expect(rows(page)).toHaveText([
    /Open its panel/,
    /Show it on the Roadmap/,
    /Ask Oracle about F-79 Weekly alert digest/,
  ]);
  await expect(paletteBox(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple\/roadmap/);
  await expect(page.getByTestId('item-panel').first()).toContainText('Weekly alert digest');
});

test('No match: Enter puts the words in the roadmap’s add box', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('Zebra export');
  await expect(page.getByTestId('palette-none')).toContainText('Nothing matches');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple\/roadmap/);
  await expect(page.locator('#quick-add-title')).toHaveValue('Zebra export');
});

test('An approver sees the add and no line about proposing', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, 'approver@example.com', '/simple');
  await pressFind(page);
  // New item, or Propose a new item where no roadmap item is theirs to decide (as the roadmap's add).
  await expect(rows(page).filter({ hasText: /New item|new item/ })).toHaveCount(1);
  await expect(page.getByTestId('palette-role')).toHaveCount(0);
});

test('A commenter sees Propose a new item, no New PRD, and a line saying so', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, 'commenter@example.com', '/simple');
  await pressFind(page);
  await expect(palette(page)).toBeVisible();
  await expect(rows(page).filter({ hasText: 'Propose a new item' })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: 'New PRD' })).toHaveCount(0);
  await expect(page.getByTestId('palette-role')).toContainText('commenter');
});

test('A viewer finds and opens but adds nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, 'viewer@example.com', '/simple');
  await pressFind(page);
  await expect(page.getByTestId('palette-role')).toContainText('viewer');
  await expect(rows(page).filter({ hasText: /New item|New PRD|Propose/ })).toHaveCount(0);
  await expect(rows(page).filter({ hasText: 'Ask Oracle' })).toHaveCount(1);
  await paletteBox(page).fill('weekly alert');
  await expect(rows(page).first()).toContainText('F-79');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('item-panel').first()).toContainText('Weekly alert digest');
});

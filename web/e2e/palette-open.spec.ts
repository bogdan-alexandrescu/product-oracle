import { ADMIN } from './helpers';
import { fitsTheScreen, palette, paletteBox, pressFind, rows, signIn } from './palette-helpers';
import { expect, test } from './test';

/*
 * build-palette (#1794), CP1 a 'Centered sheet': ⌘K or Ctrl+K opens the palette over the dimmed
 * page on every Simple and Detailed page, the box at the top; each row shows the code and name
 * and its kind and place; Enter on a feature opens the one feature panel over the page you are on;
 * Esc closes it and the focus goes back. On a phone it fills the screen. Mock API, invented data.
 */

for (const dark of [false, true]) {
  test(`Ctrl+K on Simple Home finds F-79 Weekly alert digest and opens its panel there${dark ? ' (dark)' : ''}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await signIn(page, ADMIN.email, '/simple');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    await pressFind(page);
    await expect(palette(page)).toBeVisible();
    await expect(paletteBox(page)).toBeFocused();
    await expect(page.getByTestId('palette-list')).toContainText('Go to');
    await paletteBox(page).fill('weekly alert');
    const first = rows(page).first();
    await expect(first).toContainText('F-79');
    await expect(first).toContainText('Weekly alert digest');
    await expect(first).toContainText('Feature ·');
    await expect(page.getByText('more for a feature')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    // The one feature panel, over Home: its link (#1796) is on the address; Esc or Back closes it.
    const panel = page.getByTestId('item-panel').first();
    await expect(panel).toContainText('Weekly alert digest');
    await expect(page).toHaveURL(/\/simple\?feature=F-79$/);
    if (dark) await page.goBack();
    else await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/\/simple$/);
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  });
}

test('Esc closes the palette and the focus goes back where it was', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, ADMIN.email, '/simple');
  const find = page.getByTestId('palette-entry').filter({ visible: true });
  await find.focus();
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(find).toBeFocused();
});

test('Ctrl+K opens the same palette on Detailed Home', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, ADMIN.email, '/home');
  await pressFind(page);
  await expect(palette(page)).toBeVisible();
  await paletteBox(page).fill('billing');
  await expect(page.getByTestId('palette-list')).toContainText('Annual billing PRD');
  await expect(page.getByTestId('palette-list')).toContainText('PRD · One-pagers');
});

test('Enter on a PRD opens its one-pager', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  await paletteBox(page).fill('annual billing');
  await expect(rows(page).first()).toContainText('Annual billing PRD');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple\/one-pagers\/[^/]+$/);
});

for (const phone of [false, true]) {
  test(`Enter on a milestone found by its code opens its card on the Roadmap${phone ? ' (phone)' : ''}`, async ({
    page,
  }) => {
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await signIn(page, ADMIN.email, '/simple');
    await pressFind(page);
    await paletteBox(page).fill('M3');
    const row = rows(page).filter({ hasText: /^M3/ });
    await expect(row).toHaveCount(1);
    if (!phone) await expect(row).toContainText('Milestone · Roadmap');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/simple\/roadmap\?milestone=/);
    const card = page.locator('[data-testid="ms-card"], [data-testid="ms-prd-card"]');
    await expect(card).toContainText('M3');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(page).toHaveURL(/\/simple\/roadmap$/);
  });
}

test('On a phone the palette fills the screen and Close shuts it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, ADMIN.email, '/simple');
  await pressFind(page);
  const box = await palette(page).boundingBox();
  expect(box?.width).toBe(390);
  await paletteBox(page).fill('weekly alert');
  await expect(rows(page).first()).toContainText('F-79');
  await fitsTheScreen(page);
  await page.getByTestId('palette-close').click();
  await expect(palette(page)).toBeHidden();
});

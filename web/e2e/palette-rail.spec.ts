import { ADMIN } from './helpers';
import { fitsTheScreen, palette, paletteBox, rows, signIn } from './palette-helpers';
import { expect, test } from './test';

/*
 * build-palette (#1794), CP3 a 'Find in the rail': a Find row at the top of the Simple rail with
 * its ⌘K hint, a Find tile in Detailed's narrow rail, a search button in the phone's top bar
 * beside Ask; each opens the same palette as ⌘K. Mock API, invented data.
 */

for (const dark of [false, true]) {
  test(`Find in the Simple rail opens the palette; a goal lands on Goal map${dark ? ' (dark)' : ''}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await signIn(page, ADMIN.email, '/simple');
    const find = page.getByTestId('palette-entry').filter({ visible: true });
    await expect(find).toContainText('Find');
    await expect(find).toContainText('⌘K');
    await find.click();
    await expect(palette(page)).toBeVisible();
    await paletteBox(page).fill('sign-ups per rep');
    await expect(rows(page).first()).toContainText('Sign-ups per rep per day');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/simple\/goals\?goal=/);
  });
}

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

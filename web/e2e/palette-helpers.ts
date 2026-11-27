import { ADMIN } from './helpers';
import { expect, type Page } from './test';

/** build-palette (#1794): sign in as one of the mock's members (invented people), then open `to`. */
export async function signIn(page: Page, email: string, to: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

export const palette = (page: Page) => page.getByRole('dialog', { name: 'Find' });
export const paletteBox = (page: Page) => page.getByTestId('palette-input');
export const rows = (page: Page) => page.getByTestId('palette-row');

/** Nothing on the page is wider than the screen. */
export async function fitsTheScreen(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

/** ⌘K (Ctrl+K) once the page's shell is up (its Find entry is there). */
export async function pressFind(page: Page) {
  await expect(
    page.locator('[data-testid^="palette-entry"]').filter({ visible: true }),
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette(page)).toBeVisible();
}

import { MOCK_FAIL_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from '../lib/api/mock/server';

import { ADMIN } from './helpers';
import { palette, paletteBox, pressFind, rows, signIn } from './palette-helpers';
import { expect, test, type Page } from './test';

/*
 * build-palette (#1794), the palette by keyboard and over other layers: every row, the "N more"
 * row, the no-match choices and Close are reached without a mouse; Esc closes the palette alone,
 * never the panel or sheet under it; the focus goes back where it was; what it opened stays with
 * its page; reads still on their way or failed are never "Nothing matches". Invented data.
 */

const find = (page: Page) => page.getByTestId('palette-entry').filter({ visible: true });
const panel = (page: Page) => page.getByTestId('item-panel');
const newPrd = (page: Page) => page.getByRole('dialog', { name: 'New PRD' });

async function home(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await signIn(page, ADMIN.email, '/simple');
}

/** From the rail's Find, by keyboard: type the words, Enter. */
async function pick(page: Page, words: string, row: string) {
  await find(page).focus();
  await page.keyboard.press('Enter');
  await paletteBox(page).fill(words);
  await expect(rows(page).first()).toContainText(row);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
}

test('The arrow keys reach "more" of a kind, and Enter shows the rest of it', async ({ page }) => {
  await home(page);
  await pressFind(page);
  await paletteBox(page).fill('f');
  const more = page.getByTestId('palette-more').first();
  await expect(more).toContainText('more features');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(more).toHaveAttribute('aria-selected', 'true');
  await expect(paletteBox(page)).toHaveAttribute(
    'aria-activedescendant',
    (await more.getAttribute('id'))!,
  );
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  await expect(page.getByTestId('palette-more').filter({ hasText: 'features' })).toHaveCount(0);
  await expect(rows(page).nth(5)).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).nth(5)).toContainText('Feature ·');
});

test('With no match the arrow keys reach Ask Oracle; Enter asks the words', async ({ page }) => {
  await home(page);
  await pressFind(page);
  await paletteBox(page).fill('Zebra export');
  const none = page.getByTestId('palette-none');
  await expect(none.getByRole('option')).toHaveText([/as an item/, /Ask Oracle/]);
  await page.keyboard.press('ArrowDown');
  await expect(none.getByRole('option', { name: /Ask Oracle/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/simple$/);
  await expect(page.locator('#simple-ask-panel textarea').first()).toHaveValue(/Zebra export/);
});

test('On a phone Close is reached with Tab, and Tab stays inside the sheet', async ({ page }) => {
  await home(page, 390, 844);
  await pressFind(page);
  await paletteBox(page).fill('roadmap');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('palette-close')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(paletteBox(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
});

test('A feature panel opened from the palette gives the focus back when it closes', async ({
  page,
}) => {
  await home(page);
  await pick(page, 'weekly alert', 'F-79');
  await expect(panel(page).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(find(page)).toBeFocused();
});

test('New PRD’s sheet opened from the palette gives the focus back when it closes', async ({
  page,
}) => {
  await home(page);
  await pick(page, 'new', 'New item');
  await expect(page).toHaveURL(/\/simple\/roadmap/);
  await page.goto('/simple');
  await find(page).focus();
  await page.keyboard.press('Enter');
  await rows(page).filter({ hasText: 'New PRD' }).click();
  await expect(newPrd(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(newPrd(page)).toHaveCount(0);
  await expect(find(page)).toBeFocused();
});

test('Esc over a feature panel closes the palette alone', async ({ page }) => {
  await home(page);
  await pick(page, 'weekly alert', 'F-79');
  await expect(panel(page).first()).toBeVisible();
  await pressFind(page);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(panel(page).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
});

test('Esc over New PRD’s sheet closes the palette alone', async ({ page }) => {
  await home(page);
  await pressFind(page);
  await rows(page).filter({ hasText: 'New PRD' }).click();
  await expect(newPrd(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+K');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(newPrd(page)).toBeVisible();
});

test('A panel opened from the palette stays with its page', async ({ page }) => {
  await home(page);
  await pick(page, 'weekly alert', 'F-79');
  await expect(panel(page).first()).toBeVisible();
  await page.getByTestId('simple-nav-meetings').click();
  await expect(page).toHaveURL(/\/simple\/meetings/);
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId('simple-nav-home').click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(panel(page)).toHaveCount(0);
});

test('While the reads are on their way nothing is missing and Enter adds nothing', async ({
  page,
}) => {
  await home(page);
  await expect(find(page)).toBeVisible();
  await page.evaluate(
    ([slow, ms]) => {
      localStorage.setItem(slow, '/v1/simple/roadmap');
      localStorage.setItem(ms, '4000');
    },
    [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY],
  );
  await pressFind(page);
  await paletteBox(page).fill('F-79');
  await expect(page.getByTestId('palette-loading')).toBeVisible();
  await expect(page.getByTestId('palette-none')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(rows(page).first()).toContainText('F-79', { timeout: 15_000 });
  await expect(page.getByTestId('palette-loading')).toHaveCount(0);
});

test('A failed read says so, with Try again; it is never "Nothing matches"', async ({ page }) => {
  await home(page);
  await expect(find(page)).toBeVisible();
  await page.evaluate((k) => localStorage.setItem(k, '/v1/simple/palette'), MOCK_FAIL_KEY);
  await pressFind(page);
  await paletteBox(page).fill('annual billing PRD');
  await expect(page.getByTestId('palette-failed')).toBeVisible();
  await expect(page.getByTestId('palette-none')).toHaveCount(0);
  await page.evaluate((k) => localStorage.removeItem(k), MOCK_FAIL_KEY);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('palette-again')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows(page).first()).toContainText('Annual billing PRD');
  await expect(page.getByTestId('palette-failed')).toHaveCount(0);
  await expect(paletteBox(page)).toBeFocused();
});

test('A viewer’s "new …" is a plain search, with its own no match', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, 'viewer@example.com', '/simple');
  await pressFind(page);
  await paletteBox(page).fill('new zebra');
  await expect(page.getByTestId('palette-none').getByRole('option')).toHaveText([/Ask Oracle/]);
});

test('Go to finds each shell’s pages: Settings and Runs from Detailed, Runs from Simple', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 945 });
  await signIn(page, ADMIN.email, '/home');
  for (const [words, url] of [
    ['settings', /\/settings\//],
    ['runs', /\/runs/],
  ] as const) {
    await pressFind(page);
    await paletteBox(page).fill(words);
    const row = rows(page).filter({ hasText: 'Detailed' }).first();
    await expect(row).toContainText(new RegExp(words, 'i'));
    await row.click();
    await expect(page).toHaveURL(url);
  }
  await page.goto('/simple');
  await pressFind(page);
  await expect(page.getByTestId('palette-list')).not.toContainText('Runs');
  await paletteBox(page).fill('runs');
  await rows(page).filter({ hasText: 'Runs' }).first().click();
  await expect(page).toHaveURL(/\/runs/);
});

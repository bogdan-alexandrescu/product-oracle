import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * de-r1 part 4: with a bar or card selected (its panel open), Delete or Backspace moves it to
 * Trash at once, with Undo in the note (the panel's Move to Trash: DELETE .../roadmap/items/{id}).
 * Driven through the UI against the mock. Invented data: each test adds its own feature first.
 *
 * Cards (protects / fails_when / no_claim):
 * - Delete on a Timeline bar: protects=the row leaves at once, no dialog, and Undo brings it
 *   back; fails_when=the key does nothing, a dialog asks, or Undo fails; no_claim=Settings > Trash.
 * - Backspace on a Now / Next / Later card: protects=the card leaves; fails_when=it stays.
 * - a field: protects=Backspace while typing a title deletes nothing; fails_when=the item goes.
 */

const coded = (title: string) => new RegExp(`^[A-Z][A-Z0-9]*-\\d+ ${title}`);
const toastWith = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text });
const rowOf = (page: Page, title: string) =>
  page
    .getByTestId('timeline-row')
    .filter({ has: page.getByTestId('timeline-row-name').getByText(coded(title)) });

async function open(page: Page, format: 'timeline' | 'board') {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
}

test.describe('de-r1 delete', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('Delete on a selected Timeline bar moves it to Trash; Undo brings it back', async ({
    page,
  }) => {
    await open(page, 'timeline');
    await page.getByRole('button', { name: 'Add to Guided setup track' }).click();
    await page.getByTestId('add-row-title').fill('Rain barrel gauge');
    await page.getByTestId('add-row-title').press('Enter');
    await expect(rowOf(page, 'Rain barrel gauge')).toHaveCount(1);
    await expect(page.locator('[data-just-added]')).toHaveCount(0);
    // Backspace in a field deletes nothing.
    await page.getByRole('button', { name: 'Add to Guided setup track' }).click();
    await page.getByTestId('add-row-title').press('Backspace');
    await page.getByTestId('add-row-title').press('Escape');
    await expect(rowOf(page, 'Rain barrel gauge')).toHaveCount(1);
    // Its panel open (selected), the bar focused: Delete.
    const bar = rowOf(page, 'Rain barrel gauge').getByTestId('timeline-bar');
    if (!(await page.getByTestId('item-panel').isVisible())) await bar.click();
    await expect(page.getByTestId('item-panel')).toBeVisible();
    await bar.focus();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(rowOf(page, 'Rain barrel gauge')).toHaveCount(0);
    const note = toastWith(page, /Moved .*Rain barrel gauge to Trash/);
    await note.getByRole('button', { name: 'Undo' }).click();
    await expect(rowOf(page, 'Rain barrel gauge')).toHaveCount(1);
  });

  test('Backspace on a selected card moves it to Trash', async ({ page }) => {
    await open(page, 'board');
    const later = page.locator('[data-horizon-column="later"]');
    await later.getByRole('button', { name: 'Add to Later' }).click();
    await page.getByTestId('add-card-title').fill('Porch step light');
    await page.getByTestId('add-card-title').press('Enter');
    const card = later.getByTestId('board-card').filter({ hasText: coded('Porch step light') });
    await expect(card).toHaveCount(1);
    await page.getByTestId('add-card-title').press('Escape');
    if (!(await page.getByTestId('item-panel').isVisible())) await card.click();
    await expect(page.getByTestId('item-panel')).toBeVisible();
    await card.focus();
    await page.keyboard.press('Backspace');
    await expect(card).toHaveCount(0);
    await expect(toastWith(page, /Moved .*Porch step light to Trash/)).toBeVisible();
  });
});

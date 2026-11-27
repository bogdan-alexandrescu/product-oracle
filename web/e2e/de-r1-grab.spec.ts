import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/**
 * de-r1 part 2 (RE2 A, Grab the bar): on the Timeline the bar is the control. Dragging it moves
 * its dates, dragging an end stretches it, dragging it up or down onto another track's band
 * moves it there; a click on the open row's name renames it in place. Each saves at once (no
 * Save, no dialog). Driven through the UI against the mock (move_dates, set_track, edit_title).
 * Invented data: each test first adds its own feature on a track with the "+ Add" row.
 *
 * Cards (protects / fails_when / no_claim):
 * - move and stretch: no_claim here (they were built before; roadmap-r2-timeline-drag.spec.ts).
 * - re-track: protects=a bar dropped on another track's band sits under that track;
 *   fails_when=it stays on its own track.
 * - owner: protects=the open bar's initials pick a person, saved at once (the panel shows them);
 *   fails_when=no pick on the bar, or the owner stays.
 * - rename: protects=a click on the open row's name gives a field; Enter saves the new name,
 *   kept with its code; Escape leaves the old name; fails_when=no field, or the name stays.
 * - rename while the page reads again: protects=the field keeps the focus and what was typed
 *   when the page's data is read again behind it (a change made elsewhere, the add's own late
 *   reads); fails_when=the open panel takes the focus back, so the field saves half a name or
 *   closes before Enter.
 */

const coded = (title: string) => new RegExp(`^[A-Z][A-Z0-9]*-\\d+ ${title}`);

const rowOf = (page: Page, title: string): Locator =>
  page
    .getByTestId('timeline-row')
    .filter({ has: page.getByTestId('timeline-row-name').getByText(coded(title)) });

async function addOn(page: Page, track: string, title: string) {
  await page.getByRole('button', { name: `Add to ${track}` }).click();
  await page.getByTestId('add-row-title').fill(title);
  await page.getByTestId('add-row-title').press('Enter');
  await expect(rowOf(page, title)).toHaveCount(1);
  // The added item's panel opens; close it so the chart is full width, and let its row's
  // scroll into sight and mark settle before a drag measures it. Close, not Escape: the field
  // for the next add may hold the focus, and Escape there closes that field instead.
  const panel = page.getByTestId('item-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('[data-just-added]')).toHaveCount(0);
}

async function open(page: Page) {
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId('format-timeline').click();
  await expect(page.getByRole('button', { name: 'Add to Guided setup track' })).toBeVisible();
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let n = 1; n <= 8; n++) await page.mouse.move(from.x + (dx * n) / 8, from.y + (dy * n) / 8);
  await page.mouse.up();
}

test.describe('de-r1 grab the bar', () => {
  // timeline-order: a new row sits after its track's ranked rows, so the band it is dropped on can
  // be far above it; the page is tall enough for both to be in sight.
  test.use({ viewport: { width: 1366, height: 1400 } });

  test('a bar dropped on another track moves there', async ({ page }) => {
    await open(page);
    await addOn(page, 'Guided setup track', 'Sump pump check');
    const row = rowOf(page, 'Sump pump check');
    const from = await row.getAttribute('data-lane');
    // Another track's band: its header row.
    const other = page
      .getByTestId('timeline-lane')
      .filter({ hasNotText: 'Guided setup track' })
      .and(page.locator('[data-lane-head]'))
      .first();
    const to = (await other.getAttribute('data-lane'))!;
    expect(to).not.toBe(from);
    await other.scrollIntoViewIfNeeded();
    const bar = row.getByTestId('timeline-bar');
    const b = (await bar.boundingBox())!;
    const h = (await other.boundingBox())!;
    await drag(
      page,
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
      0,
      h.y + h.height / 2 - (b.y + b.height / 2),
    );
    await expect(rowOf(page, 'Sump pump check')).toHaveAttribute('data-lane', to);
  });

  test("a click on the open row's name renames it in place", async ({ page }) => {
    await open(page);
    await addOn(page, 'Guided setup track', 'Gutter sensor');
    const label = rowOf(page, 'Gutter sensor').getByTestId('timeline-row-label');
    await label.click();
    await expect(page.getByTestId('item-panel')).toBeVisible();
    await label.click();
    const field = page.getByTestId('timeline-row-rename');
    await expect(field).toBeFocused();
    // Escape keeps the old name.
    await field.fill('Not this');
    await field.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(rowOf(page, 'Gutter sensor')).toHaveCount(1);
    await rowOf(page, 'Gutter sensor').getByTestId('timeline-row-label').click();
    // The field holds the name; the code stays the item's own.
    await expect(page.getByTestId('timeline-row-rename')).toHaveValue('Gutter sensor');
    await page.getByTestId('timeline-row-rename').fill('Gutter flow sensor');
    await page.getByTestId('timeline-row-rename').press('Enter');
    await expect(rowOf(page, 'Gutter flow sensor')).toHaveCount(1);
    await expect(rowOf(page, 'Gutter sensor')).toHaveCount(0);
  });

  test('the name field keeps the focus while the page reads again', async ({ page }) => {
    await open(page);
    await addOn(page, 'Guided setup track', 'Rain barrel');
    const label = rowOf(page, 'Rain barrel').getByTestId('timeline-row-label');
    await label.click();
    await expect(page.getByTestId('item-panel')).toBeVisible();
    await label.click();
    const field = page.getByTestId('timeline-row-rename');
    await expect(field).toBeFocused();
    await field.fill('Rain barrel');
    await field.pressSequentially(' gauge');
    // A change made elsewhere: every read on the page runs again (lib/use-query.ts).
    const calls = () =>
      page.evaluate(() => (globalThis as { __poMockCalls?: string[] }).__poMockCalls?.length ?? 0);
    const before = await calls();
    await page.evaluate(() => window.dispatchEvent(new Event('po:data-changed')));
    await expect.poll(calls).toBeGreaterThan(before);
    // The reads answer after the mock's 60 ms; give the page time to draw them.
    await page.waitForTimeout(600);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Rain barrel gauge');
    await field.press('Enter');
    await expect(rowOf(page, 'Rain barrel gauge')).toHaveCount(1);
  });

  test("the open bar's owner initials pick a person, saved at once", async ({ page }) => {
    await open(page);
    // Added, its panel opens: the bar is the open (selected) one.
    await page.getByRole('button', { name: 'Add to Guided setup track' }).click();
    await page.getByTestId('add-row-title').fill('Fence post light');
    await page.getByTestId('add-row-title').press('Enter');
    const row = rowOf(page, 'Fence post light');
    await expect(row).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('item-panel')).toBeVisible();
    const pick = row.getByTestId('bar-owner-pick');
    await expect(pick.locator('option')).not.toHaveCount(1);
    const name = (await pick.locator('option').nth(1).textContent())!;
    await pick.selectOption({ label: name });
    await expect(page.getByTestId('card-owner')).toContainText(name);
    await expect(row.getByTestId('bar-owner')).toHaveAttribute('title', name);
  });
});

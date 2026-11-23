import { GM_TRACKS_SCENARIO } from '../lib/api/mock/goal-map-tracks';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * de-gm part 1: features edited directly on the Goal map ("Goals by tracks grid"), driven through
 * the UI against the mock ("goal-map-tracks": invented goals, tracks and features).
 *
 * Cards (protects / fails_when / no_claim):
 * - add in a cell: protects=a cell's + Add takes a name and Enter, and the feature sits in that
 *   cell (that goal, that track) with its code, the field kept for the next; fails_when=it opens a
 *   drawer, lands in another cell, or shows no code; no_claim=Oracle's suggestions.
 * - drag to a cell: protects=a chip dropped on another goal's and track's cell sits there at once
 *   and stays after the map reads again; fails_when=a second step is needed or it snaps back.
 * - rename in place: protects=F2 or a double-click turns the name into a field, Enter saves, Esc
 *   leaves it as it was; fails_when=the name stays or Esc saves.
 * - delete with Undo: protects=Delete on a chip moves it to Trash with no dialog and Undo puts it
 *   back; fails_when=a dialog asks or the chip stays.
 * - who: a viewer gets no + Add and no drag; someone who may only propose files a proposal, and
 *   nothing lands on the map until it is accepted.
 */

test.use({ viewport: { width: 1512, height: 900 } });

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    GM_TRACKS_SCENARIO,
  ] as const);
  await login(page, email);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
}

/** A cell by its goal's and track's names (the ids are made when the mock seeds). */
async function cell(page: Page, goal: string, track: string): Promise<Locator> {
  const g = await page.getByTestId('gm-goal').filter({ hasText: goal }).getAttribute('data-goal');
  const t = await page
    .getByTestId('gm-track')
    .filter({ hasText: new RegExp(`^${track}$`) })
    .getAttribute('data-track');
  return page.locator(`[data-testid="gm-cell"][data-goal="${g}"][data-track="${t}"]`);
}
const PAY = 'Failed payments per day';
const REV = 'Revenue per day';
const chip = (page: Page, name: string) => page.getByTestId('gm-chip').filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

test.describe('Goal map: features edited in place', () => {
  test('+ Add in a cell adds a feature to that goal and track, with its code', async ({ page }) => {
    await open(page);
    const c = await cell(page, PAY, 'Scale');
    await c.hover();
    await c.getByTestId('gm-cell-new').click();
    const field = c.getByTestId('gm-cell-input');
    await field.fill('Example retry digest');
    await field.press('Enter');
    // Enter keeps the field for the next one.
    await expect(field).toBeFocused();
    await field.fill('Example card reminder');
    await field.press('Enter');
    for (const name of ['Example retry digest', 'Example card reminder']) {
      const added = c.getByTestId('gm-chip').filter({ hasText: name });
      await expect(added).toBeVisible();
      await expect(added.getByTestId('gm-chip-name')).toHaveText(new RegExp(`^\\S+-\\d+.*${name}`));
    }
    await field.press('Escape');
    await expect(c.getByTestId('gm-cell-input')).toHaveCount(0);
    await page.reload();
    await expect(
      (await cell(page, PAY, 'Scale'))
        .getByTestId('gm-chip')
        .filter({ hasText: 'Example retry digest' }),
    ).toBeVisible();
  });

  test('dragging a chip to another cell changes its goal and track at once', async ({ page }) => {
    // Both cells in sight, so the drag is one gesture.
    await page.setViewportSize({ width: 1512, height: 2000 });
    await open(page);
    const from = chip(page, 'Lead list ranking');
    await from.dragTo(await cell(page, REV, 'Account Management'));
    const moved = (await cell(page, REV, 'Account Management')).getByTestId('gm-chip').filter({
      hasText: 'Lead list ranking',
    });
    await expect(moved).toBeVisible();
    await expect(chip(page, 'Lead list ranking')).toHaveCount(1);
    // Saved with no second step: the notes say so, and the map reads it so after a reload.
    await expect(toast(page, /Moved .*Lead list ranking from/)).toBeVisible();
    await page.reload();
    await expect(
      (await cell(page, REV, 'Account Management'))
        .getByTestId('gm-chip')
        .filter({ hasText: 'Lead list ranking' }),
    ).toBeVisible();
  });

  test('F2 or a double-click renames a chip in place; Esc leaves it', async ({ page }) => {
    await open(page);
    const name = chip(page, 'Plain cancel button').getByRole('button').first();
    await name.focus();
    await page.keyboard.press('F2');
    const field = page.getByTestId('gm-rename');
    await field.fill('Example keep-it button');
    await field.press('Escape');
    await expect(chip(page, 'Plain cancel button')).toBeVisible();
    await chip(page, 'Plain cancel button').getByTestId('gm-chip-name').dblclick();
    await page.getByTestId('gm-rename').fill('Example one-click cancel');
    await page.getByTestId('gm-rename').press('Enter');
    await expect(chip(page, 'Example one-click cancel')).toBeVisible();
    await expect(chip(page, 'Plain cancel button')).toHaveCount(0);
  });

  test('Delete moves a chip to Trash with no dialog; Undo puts it back', async ({ page }) => {
    await open(page);
    await chip(page, 'Usage add-ons').getByRole('button').first().focus();
    await page.keyboard.press('Delete');
    await expect(chip(page, 'Usage add-ons')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await toast(page, /Moved .*Usage add-ons to Trash/)
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(chip(page, 'Usage add-ons')).toBeVisible();
  });

  test('a viewer gets no + Add and cannot drag a chip', async ({ page }) => {
    await open(page, 'viewer@example.com');
    await expect(chip(page, 'Lead list ranking')).toBeVisible();
    await expect(page.getByTestId('gm-cell-new')).toHaveCount(0);
    await expect(chip(page, 'Lead list ranking')).not.toHaveAttribute('draggable', 'true');
  });

  test('someone who may only propose files the add as a proposal', async ({ page }) => {
    await open(page, 'commenter@example.com');
    const c = await cell(page, PAY, 'Scale');
    await c.hover();
    await c.getByTestId('gm-cell-new').click();
    await c.getByTestId('gm-cell-input').fill('Example proposed digest');
    await c.getByTestId('gm-cell-input').press('Enter');
    await expect(toast(page, /proposed/i)).toBeVisible();
    await expect(chip(page, 'Example proposed digest')).toHaveCount(0);
    await expect(
      c.getByTestId('gm-chip-pending').filter({ hasText: 'Example proposed digest' }),
    ).toHaveAttribute('data-proposed', '1');
  });

  test('a milestone renames in place and changes its date in one step', async ({ page }) => {
    await open(page);
    const strip = (name: string) =>
      page.getByTestId('gm-strip-milestone').filter({ hasText: name });
    await strip('Annual plans live').getByTestId('gm-strip-name').dblclick();
    await page.getByTestId('gm-rename').fill('Example yearly plans');
    await page.getByTestId('gm-rename').press('Enter');
    await expect(strip('Example yearly plans')).toBeVisible();
    await strip('Example yearly plans').getByTestId('gm-strip-date').click();
    await page.getByTestId('gm-strip-date-input').fill('2027-01-15');
    await page.getByTestId('gm-strip-date-input').press('Enter');
    await expect(strip('Example yearly plans').getByTestId('gm-strip-date')).toHaveText('Jan 15');
    await expect(toast(page, /to Jan 15/)).toBeVisible();
    await page.reload();
    await expect(strip('Example yearly plans').getByTestId('gm-strip-date')).toHaveText('Jan 15');
  });

  test('a viewer cannot change a milestone date', async ({ page }) => {
    await open(page, 'viewer@example.com');
    await expect(page.getByTestId('gm-strip-milestone').first()).toBeVisible();
    await expect(page.getByTestId('gm-strip-date')).toHaveCount(0);
  });
});

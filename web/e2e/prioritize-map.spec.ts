import { GM_TRACKS_SCENARIO } from '../lib/api/mock/goal-map-tracks';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * prioritize part 3: a Goal map chip moved up or down within its cell takes its neighbour's place
 * in the one feature order (Priorities' rank), saved at once (invented goals and features: the
 * goal map's tracks scenario).
 *
 * Cards (protects / fails_when / no_claim):
 * - keys: protects=Alt+ArrowDown on a focused chip moves it one place in its cell, kept after a
 *   reload; fails_when=it stays or comes back.
 * - drag: protects=a chip dropped on the chip above it in its cell takes its place.
 * - viewer: protects=Alt+Arrow moves nothing and no chip can be dragged.
 * no_claim=moving a chip to another cell (de-gm-map-features).
 */

test.use({ viewport: { width: 1512, height: 900 } });

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    GM_TRACKS_SCENARIO,
  ] as const);
  await login(page, email);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-chip').first()).toBeVisible();
}

/** The first cell with two chips or more, by its goal and track. */
async function fullCell(page: Page): Promise<Locator> {
  const at = await page
    .getByTestId('gm-cell')
    .evaluateAll((els) =>
      els
        .filter((e) => e.querySelectorAll('[data-testid=gm-chip]').length > 1)
        .map((e) => [e.getAttribute('data-goal'), e.getAttribute('data-track')]),
    );
  expect(at.length).toBeGreaterThan(0);
  return page.locator(`[data-testid=gm-cell][data-goal="${at[0][0]}"][data-track="${at[0][1]}"]`);
}
const chips = (cell: Locator) =>
  cell.getByTestId('gm-chip').evaluateAll((els) => els.map((e) => e.dataset.feature));

test.describe('Goal map: prioritize chips in their cell', () => {
  test('Alt+ArrowDown moves a chip one place, a drag moves it back; kept after a reload', async ({
    page,
  }) => {
    await open(page);
    const cell = await fullCell(page);
    const before = await chips(cell);
    await cell.getByTestId('gm-chip').nth(0).getByRole('button').first().focus();
    await page.keyboard.press('Alt+ArrowDown');
    const after = [before[1], before[0], ...before.slice(2)];
    await expect.poll(() => chips(cell)).toEqual(after);
    await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('gm-chip').first()).toBeVisible();
    await expect.poll(() => chips(cell)).toEqual(after);
    await cell.getByTestId('gm-chip').nth(1).dragTo(cell.getByTestId('gm-chip').nth(0));
    await expect.poll(() => chips(cell)).toEqual(before);
  });

  test('a viewer: no chip can be dragged and Alt+Arrow moves nothing', async ({ page }) => {
    await open(page, 'viewer@example.com');
    const cell = await fullCell(page);
    const before = await chips(cell);
    await expect(cell.locator('[data-testid=gm-chip][draggable=true]')).toHaveCount(0);
    await cell.getByTestId('gm-chip').nth(0).getByRole('button').first().focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(300);
    expect(await chips(cell)).toEqual(before);
  });

  test('someone who may only propose files the move: a pending mark, the order kept', async ({
    page,
  }) => {
    await open(page, 'approver@example.com');
    const cell = await fullCell(page);
    const before = await chips(cell);
    await cell.getByTestId('gm-chip').nth(0).getByRole('button').first().focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByRole('status').filter({ hasText: 'Proposed moving' })).toBeVisible();
    await expect(cell.getByTestId('order-pending')).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId('gm-chip').first()).toBeVisible();
    expect(await chips(cell)).toEqual(before);
    await expect(cell.getByTestId('order-pending')).toHaveCount(1);
  });
});

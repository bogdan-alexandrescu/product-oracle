import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * prioritize part 1: a feature's place in its goal bucket is its priority, set in place on
 * Priorities > Goal buckets (no dated plan, "goal-buckets-undated": invented goals and features).
 *
 * Cards (protects / fails_when / no_claim):
 * - drag: protects=dragging a feature's grip onto the row above it in its own bucket moves it there
 *   at once and the order stays after a reload; fails_when=it stays, waits for a Save, or comes back.
 * - keys: protects=Alt+ArrowDown on a focused feature moves it one place; fails_when=it stays.
 * - proposer: protects=who may only propose files the move and its row shows a pending mark, the
 *   order unchanged; fails_when=no mark, or the order changes for everyone.
 * - viewer: protects=no grip and Alt+Arrow moves nothing.
 * no_claim=the Priorities list's own move dialog (priorities specs).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const GOAL = 'Reliability';

async function open(page: Page, email?: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    'goal-buckets-undated',
  ] as const);
  await login(page, email);
  await page.goto('/simple/priorities?tab=buckets');
  await expect(rows(page).first()).toBeVisible();
}

const bucket = (page: Page) =>
  page
    .getByTestId('goal-bucket')
    .filter({ has: page.getByRole('heading', { name: GOAL, exact: true }) });
const rows = (page: Page) => bucket(page).getByTestId('plan-feature');
const order = (page: Page) => rows(page).evaluateAll((els) => els.map((e) => e.dataset.code));

test.describe('Goal buckets: prioritize in place', () => {
  test('drag a feature above its neighbour: saved at once, kept after a reload', async ({
    page,
  }) => {
    await open(page);
    const before = await order(page);
    expect(before.length).toBeGreaterThan(1);
    const grip = rows(page).nth(1).getByTestId('feature-grip');
    const onto = rows(page).nth(0).getByTestId('plan-feature-name');
    const from = (await grip.boundingBox())!;
    const to = (await onto.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = [before[1], before[0], ...before.slice(2)];
    await expect.poll(() => order(page)).toEqual(after);
    await expect(page.getByTestId('bucket-note')).toContainText('Moved');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    await expect.poll(() => order(page)).toEqual(after);
  });

  test('Alt+ArrowDown on a focused feature moves it one place, kept after a reload', async ({
    page,
  }) => {
    await open(page);
    const before = await order(page);
    await rows(page).nth(0).getByTestId('plan-feature-open').focus();
    await page.keyboard.press('Alt+ArrowDown');
    const after = [before[1], before[0], ...before.slice(2)];
    await expect.poll(() => order(page)).toEqual(after);
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    await expect.poll(() => order(page)).toEqual(after);
  });

  test('someone who may only propose files the move: a pending mark, the order kept', async ({
    page,
  }) => {
    await open(page, 'approver@example.com');
    const before = await order(page);
    await rows(page).nth(1).getByTestId('plan-feature-open').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(rows(page).nth(1).getByTestId('order-pending')).toBeVisible();
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    expect(await order(page)).toEqual(before);
    await expect(rows(page).nth(1).getByTestId('order-pending')).toBeVisible();
  });

  test('a viewer has no grip and Alt+Arrow moves nothing', async ({ page }) => {
    await open(page, 'viewer@example.com');
    const before = await order(page);
    await expect(bucket(page).getByTestId('feature-grip')).toHaveCount(0);
    await rows(page).nth(0).getByTestId('plan-feature-open').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(300);
    expect(await order(page)).toEqual(before);
  });
});

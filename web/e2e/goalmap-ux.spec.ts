import { GM_TRACKS_HARD_SCENARIO, GM_TRACKS_SCENARIO } from '../lib/api/mock/goal-map-tracks';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * Goal map UX audit of Nov 23 (#1748, #1769, #1770, #1771, #1772), driven through the UI against
 * the mock ("goal-map-tracks" and its "-hard" case: invented goals, milestones and features), in
 * the audit's window (about 1500 x 620).
 *
 * Test cards (protects / fails_when) are each test's comment.
 */

test.use({ viewport: { width: 1500, height: 620 } });

async function open(page: Page, scenario: string = GM_TRACKS_SCENARIO) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [
    MOCK_SCENARIO_KEY,
    scenario,
  ] as const);
  await login(page);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
}

const chip = (page: Page, name: string) => page.getByTestId('gm-chip').filter({ hasText: name });
const strip = (page: Page, name: string) =>
  page.getByTestId('gm-strip-milestone').filter({ hasText: name });
const style = (el: ReturnType<Page['locator']>, prop: string) =>
  el.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test.describe('Goal map UX (Nov 23 audit)', () => {
  test('#1748 the chip whose panel is open is marked until the panel closes', async ({ page }) => {
    // protects: which card the panel shows. fails_when: the open chip looks like every other one.
    await open(page);
    const c = chip(page, 'Rep calendar sync');
    const other = chip(page, 'Lead list ranking');
    const before = await style(c, 'background-color');
    await c.getByRole('button', { name: /Rep calendar sync/ }).click();
    await expect(page.getByTestId('floating-card').getByTestId('card-name')).toContainText(
      'Rep calendar sync',
    );
    await expect(c).toHaveAttribute('aria-current', 'true');
    await expect(other).not.toHaveAttribute('aria-current', 'true');
    await expect.poll(() => style(c, 'background-color')).not.toBe(before);
    expect(await style(c, 'background-color')).not.toBe(await style(other, 'background-color'));
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('floating-card')).toHaveCount(0);
    await expect(c).not.toHaveAttribute('aria-current', 'true');
  });

  test('#1748 the mark follows a dependency the panel opens in its place', async ({ page }) => {
    // protects: the mark names the feature the panel shows. fails_when: it stays on the clicked chip
    // after the panel moved to another feature that has its own chip.
    await open(page);
    const [from, to] = [chip(page, 'Rep calendar sync'), chip(page, 'Lead list ranking')];
    await from.getByRole('button', { name: /Rep calendar sync/ }).click();
    const card = page.getByTestId('floating-card');
    await card.getByRole('button', { name: 'Add a dependency' }).click();
    await card
      .getByLabel('Feature it depends on')
      .selectOption({ label: 'F-204 Lead list ranking' });
    await card.getByRole('button', { name: 'Save' }).click();
    await card
      .getByTestId('card-depends')
      .getByRole('button', { name: 'F-204 Lead list ranking' })
      .click();
    await expect(card.getByTestId('card-name')).toContainText('Lead list ranking');
    await expect(to).toHaveAttribute('aria-current', 'true');
    await expect(from).not.toHaveAttribute('aria-current', 'true');
  });

  test('#1769 the goal row stays in sight while a long column scrolls', async ({ page }) => {
    // protects: which goal a column belongs to. fails_when: the goal row scrolls away with the cards.
    await open(page, GM_TRACKS_HARD_SCENARIO);
    const goals = page.getByTestId('gm-goal');
    const last = page.getByTestId('gm-chip').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    const n = await goals.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) await expect(goals.nth(i)).toBeInViewport();
  });

  for (const [label, size, ask] of [
    ['a 1280 laptop', { width: 1280, height: 720 }, false],
    ['the audit window with Ask Oracle open', { width: 1500, height: 620 }, true],
    ['a phone', { width: 390, height: 844 }, false],
  ] as const)
    test(`#1769 the goal row holds on ${label}, in step with its columns`, async ({ page }) => {
      // protects: the goal row where the grid scrolls sideways. fails_when: the row scrolls away
      // with the cards, or its goals stop lining up with their columns.
      await page.setViewportSize(size);
      await open(page, GM_TRACKS_HARD_SCENARIO);
      if (ask) {
        await page.getByRole('button', { name: 'Ask Oracle', exact: true }).first().click();
        await expect(page.locator('#simple-ask-panel')).toBeVisible();
      }
      const grid = page.getByTestId('gm-grid');
      expect(await grid.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
      const row = page.getByTestId('gm-head');
      const last = page.getByTestId('gm-chip').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      const bar = size.width <= 600 ? 44 : 0;
      await expect.poll(async () => (await row.boundingBox())!.y).toBeGreaterThanOrEqual(bar - 1);
      expect((await row.boundingBox())!.y).toBeLessThan(bar + 2);
      const held = () =>
        Promise.all(
          [page.getByTestId('gm-corner'), page.getByTestId('gm-track').first()].map(
            async (e) => (await e.boundingBox())!.x,
          ),
        );
      const was = await held();
      await grid.evaluate((e) => (e.scrollLeft = 300));
      const goal = page.getByTestId('gm-goal').nth(1);
      const id = await goal.getAttribute('data-goal');
      const cell = page.locator(`[data-testid=gm-cell][data-goal="${id}"]`).first();
      await expect
        .poll(async () => (await goal.boundingBox())!.x - (await cell.boundingBox())!.x)
        .toBeCloseTo(0, 0);
      if (size.width <= 600) {
        // The corner and the track names hold at the left.
        expect(await held()).toEqual(was);
      }
      // The last goal's ⋯ comes into sight when focused, its column with it, and its menu is not cut.
      const end = page.getByTestId('gm-goal').last();
      const more = end.getByRole('button', { name: /^More for/ });
      await more.focus();
      await expect(more).toBeInViewport({ ratio: 1 });
      const endCell = page
        .locator(`[data-testid=gm-cell][data-goal="${await end.getAttribute('data-goal')}"]`)
        .first();
      await expect
        .poll(async () => (await end.boundingBox())!.x - (await endCell.boundingBox())!.x)
        .toBeCloseTo(0, 0);
      await more.click();
      const item = page.getByRole('menu').getByRole('menuitem').last();
      await expect(item).toBeInViewport({ ratio: 1 });
      expect(
        await item.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      ).toBe(true);
    });

  test('#1769 keyboard focus never hides under the goal row', async ({ page }) => {
    // protects: what a keyboard user has focused stays in sight. fails_when: Shift+Tab up a
    // column lands focus under the held goal row.
    await open(page, GM_TRACKS_HARD_SCENARIO);
    const last = page.getByTestId('gm-chip').last().getByRole('button').first();
    await last.focus();
    const row = page.getByTestId('gm-head');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      const at = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e?.closest('[data-testid=gm-grid]')) return null;
        return e.getBoundingClientRect().top;
      });
      if (at === null) continue;
      const b = (await row.boundingBox())!;
      expect(at).toBeGreaterThanOrEqual(b.y + b.height - 1);
    }
  });

  test('#1770 no "No milestone" line on a chip; the marks have a legend', async ({ page }) => {
    // protects: a quiet chip and a legend for its mark. fails_when: "No milestone" shows on a chip,
    // or the ✓ and ○ go unexplained.
    await open(page);
    const ms = chip(page, 'Rep daily scoreboard').getByTestId('gm-chip-ms');
    await expect.poll(() => ms.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(2);
    const legend = page.getByTestId('gm-legend-marks');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('✓Shipped');
    await expect(legend).toContainText('Planned');
  });

  test('#1771 a milestone with no gate says so plainly, as a button', async ({ page }) => {
    // protects: plain words for a missing gate, clickable in look. fails_when: it says "No gate",
    // or the clickable chip looks like a plain badge.
    await open(page);
    const m = strip(page, 'Self-serve setup');
    await expect(m.getByText('No gate')).toHaveCount(0);
    const set = m.getByRole('button', { name: '+ Target' });
    await expect(set).toBeVisible();
    expect(await style(set, 'border-top-style')).toBe('dashed');
    expect(await style(set, 'cursor')).toBe('pointer');
    await set.click();
    await expect(page.getByText('The gate of Self-serve setup')).toBeVisible();
  });

  test('#1772 long feature names wrap instead of cutting off', async ({ page }) => {
    // protects: a whole name in a wide column. fails_when: a name is cut on one line ("Crawling pace sched…").
    await open(page, GM_TRACKS_HARD_SCENARIO);
    const names = page.getByTestId('gm-chip-name');
    await expect(names.first()).toBeVisible();
    const cut = await names.evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    );
    expect(cut).toEqual([]);
    const twoLines = await names.evaluateAll(
      (els) =>
        els.filter(
          (e) =>
            e.getBoundingClientRect().height > 1.5 * parseFloat(getComputedStyle(e).lineHeight),
        ).length,
    );
    expect(twoLines).toBeGreaterThan(0);
  });
});

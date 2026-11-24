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

import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Locator, type Page } from './test';

/*
 * The UX re-audit of Nov 25, 2026 on Simple > Roadmap's Timeline (a laptop window, about
 * 1512x756), driven as a person does against the mock's invented data:
 * #1901 the rows above the timeline: the key sits in the filter row, no "No broken links" row,
 *       no jargon chip for a PRD's milestones, and the goal cards fold away (the pick holds).
 * #1902 the milestone lines and the dotted line from a bar to its milestone have key entries.
 * #1903 the Today pill never covers a milestone's diamond; counts never sit on each other.
 * #1904 a bar too short for its dates has them beside it; every bar names its dates on hover.
 * #1908 the circle beside the open bar says it is the owner.
 */

const LAPTOP = { viewport: { width: 1512, height: 756 } };
type Box = { x: number; y: number; width: number; height: number };

const meets = (a: Box, b: Box) =>
  a.x + 0.5 < b.x + b.width &&
  b.x + 0.5 < a.x + a.width &&
  a.y + 0.5 < b.y + b.height &&
  b.y + 0.5 < a.y + a.height;

async function boxes(l: Locator): Promise<Box[]> {
  const out: Box[] = [];
  for (const el of await l.all()) {
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (box && box.width > 0) out.push(box);
  }
  return out;
}

async function open(page: Page, scenario = '') {
  await page
    .context()
    .addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('zoom-timeline')).toBeVisible();
}

test.describe('the Timeline on a laptop window', () => {
  test.use(LAPTOP);

  test('#1901: the key sits in the filter row, the goal cards fold away and stay folded', async ({
    page,
  }) => {
    await open(page);
    const filters = page.getByTestId('filters');
    await expect(filters.getByTestId('timeline-key')).toBeVisible();
    await expect(filters.getByTestId('timeline-key').locator('[data-key="today"]')).toHaveText(
      'Today Oct 22',
    );
    const cards = page.getByTestId('goal-counters');
    await expect(cards).toBeVisible();
    const toggle = page.getByTestId('goals-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = page.getByTestId('timeline-row').first();
    const before = (await row.boundingBox())!.y;
    await toggle.click();
    await expect(cards).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((await row.boundingBox())!.y).toBeLessThan(before - 150);
    // The pick holds on the next visit; a click brings the cards back, as they were.
    await page.reload();
    await expect(page.getByTestId('zoom-timeline')).toBeVisible();
    await expect(page.getByTestId('goal-counters')).toHaveCount(0);
    await page.getByTestId('goals-toggle').click();
    await expect(page.getByTestId('goal-counters')).toBeVisible();
  });

  test("#1901: no row says there are no broken links; a PRD's milestones read in the key", async ({
    page,
  }) => {
    await open(page, 'simple-prd-milestones');
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    await expect(page.getByText('No broken links', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('ms3-key')).toHaveCount(0);
    await expect(page.getByText(/Hollow, dashed/)).toHaveCount(0);
    const prd = page.getByTestId('timeline-key').locator('[data-key="prd"]');
    await expect(prd).toHaveText('From a PRD · 1 with no date yet');
    await expect(prd).toHaveAttribute('title', /^From the PRD .+ · a change asks its owner$/);
    // With the goal cards folded, the timeline starts above the fold.
    await page.getByTestId('goals-toggle').click();
    const top = (await page.getByTestId('timeline-row').first().boundingBox())!.y;
    expect(top).toBeLessThan(756 - 40);
  });

  test("#1902: the key names the milestones' lines and the dotted line to one", async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByTestId('ms-line').first()).toBeAttached();
    const key = page.getByTestId('timeline-key');
    await expect(key.locator('[data-key="ms"]')).toHaveText('Milestone');
    await expect(key.locator('[data-key="tie"]')).toHaveText('Due by a milestone');
    // The roadmap's own milestone draws a grey dashed line: the key's Milestone entry shows it too.
    await expect(page.getByTestId('timeline-milestone-line').first()).toBeAttached();
    await expect(key.locator('[data-key="ms"]').getByTestId('key-ms-own')).toBeAttached();
  });

  test('#1904: a short bar has its dates beside it; every bar names them on hover', async ({
    page,
  }) => {
    await open(page);
    const bars = page.getByTestId('timeline-bar');
    await expect(bars.first()).toBeVisible();
    for (const bar of await bars.all())
      await expect(bar).toHaveAttribute('title', /[A-Z][a-z]{2} \d+(, \d{4})? – [A-Z][a-z]{2} \d+/);
    // At 6 months a bar of a few weeks has no room for its dates: they sit beside it, whole.
    await page.getByTestId('zoom-6m').click();
    const beside = page.getByTestId('bar-dates-beside');
    await expect(beside.first()).toBeVisible();
    const row = page.getByTestId('timeline-row').filter({ has: beside }).first();
    const bar = row.getByTestId('timeline-bar');
    const words = row.getByTestId('bar-dates-beside');
    await expect(words).toHaveText((await bar.getAttribute('title'))!);
    const [b, w] = [(await bar.boundingBox())!, (await words.boundingBox())!];
    expect(meets(b, w)).toBe(false);
    // No date words on a bar are cut.
    const cut = await page
      .getByTestId('timeline-row')
      .evaluateAll((rows) =>
        rows.flatMap((r) =>
          [...r.querySelectorAll<HTMLElement>('span.truncate.rounded')].filter(
            (e) => e.scrollWidth > e.clientWidth + 1,
          ),
        ),
      );
    expect(cut).toHaveLength(0);
    // At All 3 years a bar reached with Tab shows its dates, on it or beside it.
    await page.getByTestId('zoom-all').click();
    await expect(page.getByTestId('zoom-all')).toHaveAttribute('aria-pressed', 'true');
    const first = page.getByTestId('timeline-row').filter({ has: bars }).first();
    await first.getByTestId('timeline-row-label').focus();
    const focused = page.locator('[data-testid="timeline-bar"]:focus');
    for (let n = 0; n < 6 && !(await focused.count()); n++) await page.keyboard.press('Tab');
    await expect(focused).toHaveCount(1);
    const title = (await focused.getAttribute('title'))!;
    const host = page.locator('[data-testid="timeline-row"]').filter({ has: focused });
    await expect(host.getByText(title, { exact: true })).toBeVisible();
  });

  test('#1908: the circle beside the open bar says it is its owner', async ({ page }) => {
    await open(page);
    const row = page.getByTestId('timeline-row').filter({ has: page.getByTestId('timeline-bar') });
    const key = (await row.first().getAttribute('data-item'))!;
    const it = page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);
    await it.getByTestId('timeline-bar').click();
    await expect(it).toHaveAttribute('data-open', 'true');
    await expect(it.getByTestId('bar-owner')).toHaveAttribute('title', /^Owner: .+/);
    await expect(it.getByTestId('bar-owner-pick')).toHaveAttribute('title', /^Owner: .+/);
  });

  test('#1903: the Today pill never covers a diamond; counts never sit on each other', async ({
    page,
  }) => {
    await open(page);
    // A milestone the day after today, added from the band as a person does.
    const axis = page.getByTestId('ms-axis').first();
    const box = (await axis.boundingBox())!;
    const pill = page.getByTestId('today-pill');
    const p0 = (await pill.boundingBox())!;
    await page.mouse.click(p0.x + p0.width + 40, box.y + box.height / 2);
    await page.getByTestId('ms-quick-more').click();
    await page.getByTestId('ms-kind-picker').getByRole('option').first().click();
    const card = page.getByTestId('ms-card');
    await card.getByLabel('Name').fill('Example pilot');
    await card.getByLabel('Date').fill('2026-10-23');
    await card.getByTestId('ms-save').click();
    await expect(card).toBeHidden();
    const diamonds = page.locator('[data-testid="ms-diamond"], [data-testid="ms-prd-diamond"]');
    await expect(diamonds.locator('xpath=self::*[@data-day="2026-10-23"]')).toHaveCount(1);
    for (const z of ['3m', '6m', '1y', 'all']) {
      await page.getByTestId(`zoom-${z}`).click();
      const at = (await pill.boundingBox())!;
      // At 3 and 6 months the pill finds a place clear of them; crowded, it lies under them.
      if (z === '3m' || z === '6m')
        for (const d of await boxes(diamonds))
          expect(meets(at, d), `Today covers a diamond at ${z}`).toBe(false);
      const hidden = await diamonds.evaluateAll(
        (els) =>
          els.filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width) return false;
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return top?.getAttribute('data-testid') === 'today-pill';
          }).length,
      );
      expect(hidden, `Today hides a diamond at ${z}`).toBe(0);
      const counts = await boxes(page.getByTestId('ms-same-day'));
      for (const [n, a] of counts.entries())
        for (const b of counts.slice(n + 1))
          expect(meets(a, b), `two counts meet at ${z}`).toBe(false);
    }
  });

  test('#1903: at All 3 years the whole word Today stays clear of every diamond', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('zoom-all').click();
    await expect(page.getByTestId('zoom-all')).toHaveAttribute('aria-pressed', 'true');
    const at = (await page.getByTestId('today-pill').boundingBox())!;
    const diamonds = await boxes(page.getByTestId('ms-diamond'));
    expect(diamonds.length).toBeGreaterThan(0);
    for (const d of diamonds) expect(meets(at, d), 'Today meets a diamond at all').toBe(false);
  });

  test('#1903: crowded milestones: no chip, "+N" or count meets another; none is cut at the left edge', async ({
    page,
  }) => {
    await open(page, 'roadmap-band-crowd');
    await expect(page.getByTestId('ms-label').first()).toBeVisible();
    const head = page.getByTestId('timeline-names-head');
    for (const z of ['3m', '6m', '1y', 'all']) {
      await page.getByTestId(`zoom-${z}`).click();
      await expect(page.getByTestId(`zoom-${z}`)).toHaveAttribute('aria-pressed', 'true');
      const edge = (await head.boundingBox())!;
      const right = edge.x + edge.width;
      const chips = [
        ...(await boxes(page.getByTestId('ms-label'))),
        ...(await boxes(page.getByTestId('ms-band-more'))),
        ...(await boxes(page.getByTestId('ms-same-day'))),
      ];
      expect(chips.length).toBeGreaterThan(2);
      for (const [n, a] of chips.entries()) {
        expect(a.x < right - 0.5 && a.x + a.width > right + 0.5, `a chip is cut at ${z}`).toBe(
          false,
        );
        for (const b of chips.slice(n + 1))
          expect(meets(a, b), `two chips meet at ${z}`).toBe(false);
      }
    }
  });
});

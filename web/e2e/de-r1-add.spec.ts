import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * de-r1 part 1 (RE1 A, Click the spot): a feature is added right where it goes. On the Timeline
 * each track ends with a faint "+ Add" row: a click at a week puts a six-week bar there with
 * its title field; Enter adds the feature on that track, with its code, at those dates. Every
 * Now / Next / Later column ends with "+ Add": a card with the title field. Driven through the
 * UI against the mock (add_item with after.start_date, end_date and track_id). Invented data.
 *
 * Cards (protects / fails_when / no_claim):
 * - add on a track by clicking a week: protects=the row lands on the track clicked, coded,
 *   starting on that week's Monday and six weeks long; fails_when=no "+ Add" row, the item lands
 *   elsewhere, has no code, or loses the dates clicked; no_claim=the Gantt's add rows.
 * - add in a column: protects=the card added in Later sits in Later, coded; fails_when=no
 *   "+ Add" in the column, or it lands in another column; no_claim=its track.
 * - Escape: protects=Escape drops the open bar and adds nothing; fails_when=it is added.
 * - a commenter: protects=the same click and Enter files a proposal (no row yet); fails_when=no
 *   "+ Add" row for them, or it is added at once.
 * - de-fix: a commenter's add shows faint in its track, and a commenter's move puts a pending mark
 *   on the bar; fails_when=nothing on the Timeline shows the change waits.
 * - a viewer: protects=no "+ Add" anywhere; fails_when=a viewer sees one.
 */

const ROADMAP = '/simple/roadmap';
const coded = (title: string) => new RegExp(`^[A-Z][A-Z0-9]*-\\d+ ${title}`);
const toastWith = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

async function open(page: Page, format: 'timeline' | 'board', email?: string) {
  await login(page, email);
  await page.goto(ROADMAP);
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
}

test.describe('de-r1 add in place', () => {
  test.use({ viewport: { width: 1366, height: 820 } });

  test('a click at a week on a track adds a six-week feature there', async ({ page }) => {
    await open(page, 'timeline');
    const row = page.getByRole('button', { name: 'Add to Guided setup track' });
    await expect(row).toBeVisible();
    const weeks = row.locator('xpath=..').getByTestId('add-row-weeks');
    const box = (await weeks.boundingBox())!;
    await weeks.click({ position: { x: Math.min(box.width - 40, 520), y: box.height / 2 } });
    const bar = page.getByTestId('add-row-bar');
    await expect(bar).toBeVisible();
    const start = (await bar.getAttribute('data-start'))!;
    const end = (await bar.getAttribute('data-end'))!;
    // Snapped to a Monday, six weeks long.
    expect(new Date(`${start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect((Date.parse(end) - Date.parse(start)) / 86_400_000).toBe(41);
    await page.getByTestId('add-row-title').fill('Porch light timer');
    await page.getByTestId('add-row-title').press('Enter');
    await expect(toastWith(page, 'Added Porch light timer as a draft')).toBeVisible();
    const added = page
      .getByTestId('timeline-row')
      .filter({ has: page.getByTestId('timeline-row-name').getByText(coded('Porch light timer')) });
    await expect(added).toHaveCount(1);
    await expect(added.getByTestId('timeline-bar')).toHaveAttribute('data-start', start);
    await expect(added.getByTestId('timeline-bar')).toHaveAttribute('data-end', end);
    // It sits under the track clicked: the nearest lane above it is Guided setup track's.
    const lane = await added.evaluate((el) => {
      let e = el.previousElementSibling;
      while (e && e.getAttribute('data-testid') !== 'timeline-lane') e = e.previousElementSibling;
      return e?.textContent ?? '';
    });
    expect(lane).toContain('Guided setup track');
  });

  test('Escape drops the open bar and adds nothing', async ({ page }) => {
    await open(page, 'timeline');
    const row = page.getByRole('button', { name: 'Add to Guided setup track' });
    await row.click();
    await page.getByTestId('add-row-title').fill('Never added');
    await page.getByTestId('add-row-title').press('Escape');
    await expect(page.getByTestId('add-row-bar')).toHaveCount(0);
    await expect(page.getByTestId('timeline-row-name').getByText('Never added')).toHaveCount(0);
  });

  test("a card added at a column's end sits in that column", async ({ page }) => {
    await open(page, 'board');
    const later = page.locator('[data-horizon-column="later"]');
    await later.getByRole('button', { name: 'Add to Later' }).click();
    await page.getByTestId('add-card-title').fill('Garden hose meter');
    await page.getByTestId('add-card-title').press('Enter');
    await expect(toastWith(page, 'Added Garden hose meter as a draft')).toBeVisible();
    await expect(
      later.getByTestId('board-card').filter({ hasText: coded('Garden hose meter') }),
    ).toHaveCount(1);
  });

  test('a commenter, who may only propose, files a proposal with the same click', async ({
    page,
  }) => {
    await open(page, 'timeline', 'commenter@example.com');
    await page.getByRole('button', { name: 'Add to Guided setup track' }).click();
    await page.getByTestId('add-row-title').fill('Shed door alarm');
    await page.getByTestId('add-row-title').press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: /^Proposed Shed door alarm .*Needs a decision/ }),
    ).toBeVisible();
    await expect(
      page.getByTestId('timeline-row-name').getByText(coded('Shed door alarm')),
    ).toHaveCount(0);
    // de-fix: until its decider decides, it shows faint in the track it was added to.
    await expect(
      page
        .getByRole('button', { name: 'Add to Guided setup track' })
        .locator('xpath=..')
        .getByTestId('pending-add')
        .filter({ hasText: 'Shed door alarm' }),
    ).toBeVisible();
  });

  test("a commenter's move of a bar shows a pending mark on it", async ({ page }) => {
    await open(page, 'timeline', 'commenter@example.com');
    const bar = page.locator('[data-testid="timeline-bar"][data-start]:not([disabled])').first();
    const mark = bar.locator('xpath=..').getByTestId('pending-mark');
    await expect(mark).toHaveCount(0);
    await bar.focus();
    await page.keyboard.press('ArrowRight');
    await bar.blur();
    await expect(page.getByRole('status').filter({ hasText: /Needs a decision/ })).toBeVisible();
    await expect(mark).toBeVisible();
  });

  test('a viewer sees no add rows', async ({ page }) => {
    await open(page, 'timeline', 'viewer@example.com');
    await expect(page.getByTestId('timeline-row').first()).toBeVisible();
    await expect(page.getByTestId('add-row')).toHaveCount(0);
    await page.getByTestId('format-board').click();
    await expect(page.getByTestId('board-card').first()).toBeVisible();
    await expect(page.getByTestId('add-card-button')).toHaveCount(0);
  });
});

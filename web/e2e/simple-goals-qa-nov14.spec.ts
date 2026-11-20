import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * Simple Goal map and Goal buckets, the visual QA of Nov 14, on the default mock scenario (invented data).
 *
 * Card map-codes: protects = every milestone in the Goal map's strip carries its roadmap code, and a feature's
 * panel offers every milestone of its goal; fails_when = the strip's code slot is empty or the picker holds one
 * milestone only.
 * Card map-off: protects = a goal the roadmap's features serve that is not on the map is named in a line, each a
 * way to it; fails_when = Faster activation or Grow retention is left out in silence.
 * Card map-empty-cell: protects = an empty cell of the map adds a feature there; fails_when = it has no action.
 * Card map-phone-names: protects = on a phone a chip's name wraps rather than being cut; fails_when = it ends in "…".
 * Card gb-controls: protects = with no dated plan every goal card has its controls and an Add goal tile adds one;
 * fails_when = a card lacks ✎ or the tile is missing.
 * Card gb-move: protects = the arrow keys step through the goals drawn on the page and Enter moves the row
 * there; fails_when = it announces a goal not shown, or the row stays put after "Moved".
 * Card gb-code: protects = Sample data import has one code everywhere: none on Priorities, as its panel;
 * fails_when = Priorities shows a code its panel does not.
 * Card ve-side: protects = a side-list row's "after …" pill leaves its name readable; fails_when = the name is cut.
 * Card ve-quadrant: protects = a quadrant's count lists its features in the side list; fails_when = it is inert.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openMap(page: Page) {
  await login(page);
  await page.goto('/simple/goals');
  await expect(page.getByTestId('gm-grid')).toBeVisible();
}

async function openPriorities(page: Page, tab: string) {
  await login(page);
  await page.goto(`/simple/priorities?tab=${tab}`);
}

const card = (page: Page) => page.getByTestId('floating-card');
const cutOff = (page: Page, loc: ReturnType<Page['locator']>) =>
  loc.evaluate((el) => el.scrollWidth > el.clientWidth + 1);

test.describe('Goal map', () => {
  test.use({ viewport: DESKTOP });

  test("each strip milestone shows its code; a feature's panel offers every milestone of its goal", async ({
    page,
  }) => {
    await openMap(page);
    const strip = page.getByTestId('gm-strip-milestone');
    await expect(strip.first()).toBeVisible();
    for (const b of await strip.locator('b').all()) await expect(b).toHaveText(/^M\d+$/);
    await page
      .getByTestId('gm-chip')
      .filter({ hasText: 'Complaint early warning' })
      .first()
      .getByRole('button')
      .first()
      .click();
    await expect(card(page)).toBeVisible();
    await card(page).getByRole('button', { name: 'Change the milestone' }).click();
    const options = card(page).getByLabel('Milestone', { exact: true }).locator('option');
    for (const name of [
      '3 paid conversions per rep',
      '6 paid conversions per rep',
      '10 paid conversions per rep',
    ])
      await expect(
        options.filter({ hasText: new RegExp(`^M\\d+ ${name}$`) }).first(),
      ).toBeAttached();
  });

  test('goals the roadmap serves but the map leaves out are named, each a way to it', async ({
    page,
  }) => {
    await openMap(page);
    const off = page.getByTestId('gm-off-map-all');
    await expect(off).toBeVisible();
    await expect(off.getByRole('link', { name: 'Faster activation' })).toHaveAttribute(
      'href',
      /^\/simple\/priorities\?goal=/,
    );
    await expect(off.getByRole('link', { name: 'Grow retention' })).toBeVisible();
  });

  test('an empty cell adds a feature there', async ({ page }) => {
    await openMap(page);
    const cell = page
      .getByTestId('gm-cell')
      .filter({ has: page.getByTestId('gm-cell-add') })
      .first();
    await cell.hover();
    await cell.getByTestId('gm-cell-add').click();
    await expect(page.getByRole('dialog', { name: 'Add a feature' })).toBeVisible();
  });
});

test.describe('Goal map on a phone', () => {
  test.use({ viewport: PHONE });

  test("a chip's name wraps rather than being cut", async ({ page }) => {
    await openMap(page);
    const name = page
      .getByTestId('gm-chip')
      .filter({ hasText: 'Guided first week' })
      .first()
      .getByTestId('gm-chip-name');
    await name.scrollIntoViewIfNeeded();
    await expect(name).toBeVisible();
    expect(await cutOff(page, name)).toBe(false);
    expect(await name.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('normal');
  });
});

test.describe('Goal buckets with no dated plan', () => {
  test.use({ viewport: DESKTOP });

  test('every goal card has its controls, and Add goal adds one', async ({ page }) => {
    await openPriorities(page, 'buckets');
    const buckets = page.getByTestId('goal-bucket');
    await expect(buckets.first()).toBeVisible();
    for (const title of ['Faster activation', 'Grow retention'])
      await expect(page.getByRole('button', { name: `Edit ${title}` })).toBeVisible();
    // Every goal card is a goal of the one store: none is drawn without its controls.
    for (const b of await buckets.all()) await expect(b).toHaveAttribute('data-goal-id', /.+/);
    await page.getByTestId('add-goal').getByRole('button', { name: '+ Add goal' }).click();
    const form = page.getByTestId('add-goal').getByTestId('goal-form');
    await form.getByLabel('Goal').fill('Fewer support tickets');
    await form.getByLabel('Measure: the number that shows it').fill('Support tickets a week');
    await form.getByLabel('Target').fill('Under 40');
    await form.getByLabel('By').fill('Mar 31, 2027');
    await form.getByRole('button', { name: 'Save goal' }).click();
    await expect(page.getByRole('button', { name: 'Edit Fewer support tickets' })).toBeVisible();
  });

  test('the arrow keys step through the goals on the page and Enter moves the row there', async ({
    page,
  }) => {
    await openPriorities(page, 'buckets');
    const retention = page
      .getByTestId('goal-bucket')
      .filter({ has: page.getByRole('button', { name: 'Edit Grow retention' }) });
    await expect(retention.getByTestId('feature-grip').first()).toBeVisible();
    const grip = page.getByRole('button', { name: 'Move Setup checklist to another goal' });
    await grip.focus();
    await page.keyboard.press('Enter');
    const live = page.getByTestId('bucket-live');
    await expect(live).toContainText('Picked up Setup checklist');
    const shown = await page.getByTestId('goal-bucket').evaluateAll((els) =>
      els
        .filter((e) => e.getAttribute('data-goal-id'))
        .map(
          (e) =>
            e
              .querySelector("[aria-label^='Edit ']")
              ?.getAttribute('aria-label')
              ?.replace(/^Edit /, '') ?? '',
        ),
    );
    const others = shown.filter((t) => t && t !== 'Faster activation');
    expect(others.length).toBeGreaterThan(1);
    // Each step names a goal drawn on the page, in its order there.
    for (const t of others) {
      await page.keyboard.press('ArrowDown');
      await expect(live).toContainText(`, ${t}. Enter drops it there.`);
    }
    await page.keyboard.press('ArrowDown');
    await expect(live).toContainText(`, Grow retention. Enter drops it there.`);
    await page.keyboard.press('Enter');
    await expect(
      retention.getByTestId('plan-feature').filter({ hasText: 'Setup checklist' }),
    ).toHaveCount(1);
  });

  test('Sample data import has one code everywhere: none, as its panel says', async ({ page }) => {
    await openPriorities(page, 'buckets');
    const row = page.getByTestId('plan-feature').filter({ hasText: 'Sample data import' }).first();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('F-12');
    await row.getByRole('button', { name: 'Sample data import', exact: true }).click();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).not.toContainText('F-12');
  });
});

test.describe('Value / effort', () => {
  test.use({ viewport: DESKTOP });

  test("a side-list row's after pill leaves the name readable", async ({ page }) => {
    await openPriorities(page, 'value-effort');
    // A row that also carries the Misses tag has less room (a 318 px list): its name is checked for most of its room below.
    const held = page
      .getByTestId('side-row')
      .filter({ has: page.getByTestId('side-held') })
      .filter({ hasNot: page.getByTestId('prio-misses') });
    await expect(held.first()).toBeVisible();
    for (const r of await held.all())
      expect(await cutOff(page, r.getByTestId('prio-title'))).toBe(false);
    const routing = page
      .getByTestId('side-row')
      .filter({ hasText: 'Alert routing by team' })
      .getByTestId('prio-title');
    expect(await routing.evaluate((el) => el.clientWidth / el.scrollWidth)).toBeGreaterThan(0.9);
    // The feature it needs is still named: on the selected row's second line.
    const digest = held.filter({ hasText: 'Weekly alert digest' });
    await digest.getByRole('button').first().click();
    await expect(digest.getByTestId('side-after')).toHaveText('after Alert rules engine');
  });

  test('a row held after a coded feature names it with its code and name', async ({ page }) => {
    // fails_when: the pill reads "after F-79" with the name only in its tip, and the selected row has no second line
    await openPriorities(page, 'value-effort');
    const setup = page.getByTestId('side-row').filter({ hasText: 'Setup checklist' });
    await setup.getByRole('button').first().click();
    await card(page).getByRole('button', { name: 'Add a dependency' }).click();
    await card(page)
      .getByLabel('Feature it depends on')
      .selectOption({ label: 'F-79 Weekly alert digest' });
    await card(page).getByRole('button', { name: 'Save' }).click();
    const held = setup.getByTestId('side-held');
    await expect(held).toBeVisible();
    // No code without its name: the pill says "after", the selected row's second line names the feature.
    await expect(held).toHaveText(/^after(\s+F-79\s+Weekly alert digest)?$/);
    await expect(setup.getByTestId('side-after')).toHaveText(
      /^after\s+F-79\s+Weekly alert digest$/,
    );
    await expect(setup.getByTestId('side-after').locator('.simple-code')).toHaveText('F-79');
    expect(await cutOff(page, setup.getByTestId('prio-title'))).toBe(false);
  });

  test("a quadrant's count lists its features in the side list", async ({ page }) => {
    await openPriorities(page, 'value-effort');
    await expect(page.getByTestId('side-row').first()).toBeVisible();
    const all = await page.getByTestId('side-row').count();
    const quick = page.getByRole('button', { name: /^Quick wins · \d+$/ });
    const n = Number(((await quick.textContent()) ?? '').replace(/\D+/g, ''));
    await quick.click();
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('side-row')).toHaveCount(n);
    await quick.click();
    await expect(page.getByTestId('side-row')).toHaveCount(all);
  });
});

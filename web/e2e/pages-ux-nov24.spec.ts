import { MOCK_SCENARIO_KEY, MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/**
 * UX audit of Nov 23 (#1766, #1767, #1768, #1778, #1779, #1780, #1781), driven on the mock as an
 * owner at a desktop width:
 * - One-pagers: Delete PRD sits under a divider in a row's ⋯ and asks first; a row takes a
 *   visible hover background and opens its PRD from anywhere on it; "Company order" is a caption
 *   over the list, not a word beside New PRD.
 * - Meetings: every row's Start review sits at the row's right, on the text's line; the page's own
 *   Start says it starts a review of any PRD.
 * - Decisions: Waiting for you shows a skeleton while its list is read; a run stop's long note folds
 *   behind Show more; the Runs subtitle reads "Steps people…".
 * fails_when = no divider, no confirm, a faint or no row hover, the caption in the action row, a
 *   Start review under its text, an unlabelled top Start, plain loading text, a long note in full, or "Stops people approved".
 */

test.use({ viewport: { width: 1000, height: 800 } });

async function scenario(page: Page, s: string) {
  await page.addInitScript(([key, v]) => localStorage.setItem(key, v), [
    MOCK_SCENARIO_KEY,
    s,
  ] as const);
}

test.describe('One-pagers', () => {
  test('Delete PRD sits under a divider and asks first', async ({ page }) => {
    await login(page);
    await page.goto('/simple/one-pagers');
    const row = page.getByTestId('one-pager-row').nth(1);
    await row.getByRole('button', { name: /^More for / }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Move down' })).toBeVisible();
    // The divider comes right before Delete PRD, after the moves.
    const order = await menu
      .locator('[role=menuitem], [role=separator]')
      .evaluateAll((xs) => xs.map((x) => x.getAttribute('role') + ':' + (x.textContent ?? '')));
    expect(order.slice(-2)).toEqual(['separator:', 'menuitem:Delete PRD']);
    await menu.getByRole('menuitem', { name: 'Delete PRD' }).click();
    const dialog = page.getByRole('dialog', { name: /^Delete / });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('a row reacts to hover and opens its PRD from anywhere on it', async ({ page }) => {
    await login(page);
    await page.goto('/simple/one-pagers');
    const row = page.getByTestId('one-pager-row').first();
    const surface2 = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--surface2)';
      document.body.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    });
    await page.mouse.move(0, 0);
    const bg = () => row.evaluate((x) => getComputedStyle(x).backgroundColor);
    expect(await bg()).not.toBe(surface2);
    await row.hover({ position: { x: 300, y: 10 } });
    await expect.poll(bg).toBe(surface2);
    const href = await row.getByRole('link').first().getAttribute('href');
    // The row's middle, away from its title, opens the PRD.
    await row.click({ position: { x: 400, y: 10 } });
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test('"Company order" is a caption over the list, not beside New PRD', async ({ page }) => {
    await login(page);
    await page.goto('/simple/one-pagers');
    const list = page.getByTestId('simple-one-pagers');
    const caption = list.getByTestId('one-pagers-order');
    await expect(caption).toHaveText('Company order');
    await expect(caption).toHaveCSS('font-style', 'italic');
    const newPrd = list.getByRole('button', { name: /New PRD/ });
    await expect(newPrd).toBeVisible();
    // Below the action row, above the first row.
    const c = (await caption.boundingBox())!;
    const b = (await newPrd.boundingBox())!;
    const first = (await list.getByTestId('one-pager-row').first().boundingBox())!;
    expect(c.y).toBeGreaterThanOrEqual(b.y + b.height);
    expect(c.y + c.height).toBeLessThanOrEqual(first.y + 1);
  });
});

test.describe('Meetings', () => {
  test("each row's Start review sits at the row's right; the top one names what it starts", async ({
    page,
  }) => {
    await login(page);
    await page.goto('/simple/meetings');
    await expect(page.getByTestId('meetings-start-any')).toHaveText('Start review of any PRD');
    const rows = page.getByTestId('meetings-upcoming-row');
    await expect(rows.first()).toBeVisible();
    const starts = page
      .getByTestId('meetings-upcoming')
      .getByRole('button', { name: /^Start review: / });
    expect(await starts.count()).toBeGreaterThan(1);
    const places = await rows.evaluateAll((xs) =>
      xs.flatMap((x) => {
        const btn = x.querySelector('button');
        if (!btn) return [];
        const r = x.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const text = x.firstElementChild!.getBoundingClientRect();
        return [{ right: r.right - b.right, beside: b.left >= text.right - 1 }];
      }),
    );
    for (const p of places) {
      expect(p.right).toBeLessThan(1);
      expect(p.beside).toBe(true);
    }
    // The top Start opens the sheet with no review picked.
    await page.getByTestId('meetings-start-any').click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('Decisions', () => {
  test('Waiting for you shows a skeleton while its list is read', async ({ page }) => {
    // A viewer: no question waits on them, so the card waits on the one list alone.
    await login(page, 'viewer@example.com');
    await page.evaluate(
      ([slowKey, msKey]) => {
        localStorage.setItem(slowKey, '/v1/simple/decisions/waiting');
        localStorage.setItem(msKey, '2500');
      },
      [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY] as const,
    );
    await page.goto('/simple/decisions');
    const card = page.getByTestId('questions-mine');
    await expect(card.getByTestId('waiting-skeleton')).toBeVisible();
    await expect(card.getByRole('status', { name: 'Loading what waits on you' })).toBeVisible();
    await expect(card).not.toContainText('Loading what waits on you');
    await expect(card.getByTestId('waiting-skeleton')).toHaveCount(0, { timeout: 15_000 });
  });

  test('a long run note folds, and the subtitle reads plainly', async ({ page }) => {
    await scenario(page, 'run-decisions-many');
    await login(page);
    await page.goto('/simple/decisions');
    const runs = page.getByRole('region', { name: 'Runs' });
    await expect(runs).toContainText('Steps people approved while Oracle drafted a plan');
    await expect(runs).not.toContainText('Stops people');
    const note = runs.getByTestId('run-stop-note').filter({ hasText: 'Host it ourselves' });
    await expect(note).toBeVisible();
    await expect(note).not.toContainText('tax rules we still have to check');
    await note.getByRole('button', { name: 'Show more' }).click();
    await expect(note).toContainText('tax rules we still have to check');
    await note.getByRole('button', { name: 'Show less' }).click();
    await expect(note).not.toContainText('tax rules we still have to check');
  });
});

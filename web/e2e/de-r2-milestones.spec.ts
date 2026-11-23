import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test, type Page } from './test';

/*
 * de-r2 (the owner, Nov 23): milestones are changed right on the Roadmap's Milestones band, as in
 * re1-a-ms: a click on the band adds one there with its name open (Enter adds it, Esc cancels), a
 * drag moves it, its card takes each field at once (no Save), Delete removes it at once and the
 * note's Undo (or Ctrl+Z) brings it back. Who may only propose gets the card's Propose and no drag;
 * a viewer gets no band to click. Mock scenario "simple-milestones" (invented goals and people).
 */

const APPROVER = 'approver@example.com';
const VIEWER = 'viewer@example.com';
const M1 = 'M1 Alerts live for 50 teams';

async function open(page: Page, email?: string) {
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      MOCK_SCENARIO_KEY,
      'simple-milestones',
    ] as const);
  await login(page, email);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

const label = (page: Page, words: string) =>
  page.locator(`[data-testid="ms-label"][aria-label^="${words}"]`);
const card = (page: Page) => page.getByTestId('ms-card');
const toast = (page: Page) => page.getByTestId('ms-toast');

/** A point on the band, in the part of the chart in sight. */
async function onBand(page: Page, at = 0.7) {
  const axis = page.getByTestId('ms-axis').first();
  const box = (await axis.boundingBox())!;
  const seen = await axis.evaluate((el) => {
    let sc = el.parentElement;
    while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
    const r = (sc ?? document.body).getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const from = Math.max(box.x, seen.left);
  return {
    x: from + (Math.min(box.x + box.width, seen.right) - from) * at,
    y: box.y + box.height / 2,
  };
}

test.describe('milestones on the band', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a click on the band adds one with its name open; Enter adds it, Esc cancels', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('zoom-6m').click();
    let at = await onBand(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    const quick = page.getByTestId('ms-quick');
    await expect(quick).toBeVisible();
    await expect(page.getByTestId('ms-kind-picker')).toHaveCount(0);
    await expect(quick.getByLabel('Name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(quick).toHaveCount(0);

    at = await onBand(page, 0.6);
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.type('Beta for example teams');
    await page.keyboard.press('Enter');
    await expect(quick).toHaveCount(0);
    await expect(
      page.locator('[data-testid="ms-label"][aria-label*="Beta for example teams"]'),
    ).toBeVisible();
    await expect(toast(page)).toContainText('Beta for example teams added');
  });

  test('a drag on its mark moves it; on its label an arrow nudges it a day', async ({ page }) => {
    await open(page);
    const m = page.getByRole('button', { name: `${M1}, Nov 20, 2026`, exact: true });
    await expect(m).toBeVisible();
    const box = (await m.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + 124, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(toast(page)).toContainText(`${M1} moved to`);
    await expect(label(page, `${M1} · Nov 20,`)).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(label(page, `${M1} · Nov 20,`)).toBeVisible();
    await label(page, M1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(toast(page)).toContainText(`${M1} moved to Nov 21`);
    await expect(label(page, `${M1} · Nov 21,`)).toBeVisible();
    // de-fix: a quick burst of three moves it three days, drawn at once; Undo goes back to before the burst.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(label(page, `${M1} · Nov 24,`)).toBeVisible();
    await expect(toast(page)).toContainText(`${M1} moved to Nov 24`);
    await page.keyboard.press('Control+z');
    await expect(label(page, `${M1} · Nov 21,`)).toBeVisible();
  });

  test('its card saves each field at once: a rename on Enter, a status on its pick', async ({
    page,
  }) => {
    await open(page);
    await label(page, M1).click();
    const c = card(page);
    await expect(c).toHaveAttribute('data-rights', 'change');
    await expect(c.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await c.getByLabel('Name').fill('Alerts live for 70 teams');
    await c.getByLabel('Name').press('Enter');
    await expect(toast(page)).toContainText('M1 Alerts live for 70 teams saved');
    await expect(c).toBeVisible();
    await expect(label(page, 'M1 Alerts live for 70 teams')).toBeVisible();
    await c.getByLabel('Status').selectOption({ label: 'At risk' });
    await expect(
      label(page, 'M1 Alerts live for 70 teams').getByTestId('ms-status'),
    ).toHaveAttribute('data-status', 'at_risk');
    await page.keyboard.press('Escape');
    await expect(c).toHaveCount(0);
    await label(page, 'M1 Alerts live for 70 teams').click();
    await expect(card(page).getByLabel('Status')).toHaveValue('at_risk');
  });

  test('Delete removes it at once; Ctrl+Z brings it back', async ({ page }) => {
    await open(page);
    await label(page, M1).focus();
    await page.keyboard.press('Delete');
    await expect(label(page, M1)).toHaveCount(0);
    await expect(toast(page)).toContainText(`${M1} removed`);
    await page.keyboard.press('Control+z');
    await expect(label(page, M1)).toBeVisible();
  });

  test('who may only propose: no drag, the card proposes, Delete removes nothing', async ({
    page,
  }) => {
    await open(page, APPROVER);
    const m = page.getByRole('button', { name: `${M1}, Nov 20, 2026`, exact: true });
    const box = (await m.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 124, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(card(page)).toHaveAttribute('data-rights', 'propose');
    await expect(toast(page)).toHaveCount(0);
    await expect(card(page).getByTestId('ms-propose')).toBeVisible();
    await page.keyboard.press('Escape');
    await label(page, M1).focus();
    await page.keyboard.press('Delete');
    await expect(label(page, M1)).toBeVisible();
  });

  test('a viewer has no band to click and no drag', async ({ page }) => {
    await open(page, VIEWER);
    await expect(label(page, M1)).toBeVisible();
    await expect(page.getByTestId('ms-axis')).toHaveCount(0);
    await label(page, M1).focus();
    await page.keyboard.press('Delete');
    await page.keyboard.press('ArrowRight');
    await expect(toast(page)).toHaveCount(0);
    await label(page, M1).click();
    await expect(card(page)).toHaveAttribute('data-rights', 'read');
  });
});

import { HOME_MILESTONE_FOLD_SCENARIO } from '../lib/api/mock/home-milestones';
import { MOCK_SCENARIO_KEY } from '../lib/api/mock/ids';

import { login, openRoadmapItem } from './helpers';
import { expect, test, type Page } from './test';

/*
 * panel-ux (#1747, #1754, #1755, #1756, #1796), on the mock's invented roadmap, in the audit's
 * desktop window (about 1500x620), signed in as the Owner:
 * - #1747 protects = a click in the page's empty space closes the feature panel; a click inside it
 *   keeps it; another feature's bar switches it; Esc still closes it; fails_when = it stays open.
 * - #1754 protects = the panel's head is ruled off and the details scroll below it, never into its
 *   last line; fails_when = the first field slides under the title block with nothing between.
 * - #1755 protects = the × under Needed by says "Remove link" on hover, and its note offers Undo,
 *   which brings the link back; fails_when = a bare × with no tip or no Undo.
 * - #1756 protects = the Milestone field reads one code with the name ("M7 Measured and mapped");
 *   fails_when = two codes ("M7 M1 Measured and mapped").
 * - #1796 protects = an open panel puts ?feature=<code> in the address, loading it opens the panel
 *   (Roadmap, Goal map, Priorities, Home), closing takes it off, Back and Forward follow, and the
 *   panel's menu copies the link; fails_when = no parameter, the link opens nothing, or no Copy link.
 */

const panel = (page: Page) => page.getByTestId('floating-card');

async function roadmap(page: Page, scenario?: string) {
  await page.setViewportSize({ width: 1500, height: 620 });
  if (scenario)
    await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [
      MOCK_SCENARIO_KEY,
      scenario,
    ] as const);
  await login(page);
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
}

test('#1747 an outside click closes the feature panel; inside keeps it, another bar switches it', async ({
  page,
}) => {
  await roadmap(page);
  await openRoadmapItem(page, 'setup-checklist');
  await expect(panel(page)).toHaveAttribute('aria-label', 'Setup checklist');
  // Inside the panel (a field's label): it stays.
  await panel(page).getByText('Status', { exact: true }).first().click();
  await expect(panel(page)).toBeVisible();
  // Another feature's bar: the panel shows that feature.
  await openRoadmapItem(page, 'setup-import');
  await expect(panel(page)).toHaveAttribute('aria-label', 'Sample data import');
  // The page's empty space: it closes.
  await page.getByText('Scroll sideways for earlier and later').click();
  await expect(panel(page)).toHaveCount(0);
  // Esc still closes it.
  await openRoadmapItem(page, 'setup-checklist');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
});

test('#1747 a panel opened from a link closes on an outside click on Priorities', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 620 });
  await login(page);
  await page.goto('/simple/priorities?feature=F-01');
  await expect(panel(page)).toHaveAttribute('aria-label', 'Setup checklist');
  await page.getByRole('heading', { level: 1 }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/feature=/);
});

test('#1754 the panel head is ruled off and the details scroll below it', async ({ page }) => {
  await roadmap(page);
  await openRoadmapItem(page, 'setup-checklist');
  const head = panel(page).getByTestId('card-head');
  await expect(head).toBeVisible();
  expect(await head.evaluate((e) => parseFloat(getComputedStyle(e).borderBottomWidth))).toBe(1);
  const body = panel(page).locator('[data-fit-body]');
  await body.evaluate((e) => (e.scrollTop = 90));
  const headBox = (await head.boundingBox())!;
  const bodyBox = (await body.boundingBox())!;
  expect(bodyBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 0.5);
});

test('#1755 the × under Needed by is labelled Remove link and its note offers Undo', async ({
  page,
}) => {
  await roadmap(page);
  await openRoadmapItem(page, 'alert-rules');
  const needed = panel(page).getByTestId('card-needed-row');
  const count = await needed.count();
  expect(count).toBeGreaterThan(0);
  const x = needed.first().getByRole('button', { name: /from what needs it/ });
  await expect(x).toHaveAttribute('title', 'Remove link');
  await x.click();
  await expect(needed).toHaveCount(count - 1);
  await page.getByTestId('toasts').getByRole('button', { name: 'Undo' }).click();
  await expect(needed).toHaveCount(count);
});

test('#1756 the Milestone field reads one code with the name', async ({ page }) => {
  await roadmap(page, HOME_MILESTONE_FOLD_SCENARIO);
  await openRoadmapItem(page, 'setup-checklist');
  const ms = panel(page).getByTestId('card-milestone');
  // Onboarding's own "M1 Measured and mapped", picked in the field as a person would.
  await panel(page).getByRole('button', { name: 'Change the milestone' }).click();
  const pick = panel(page).getByRole('combobox', { name: 'Milestone' });
  const label = (await pick.locator('option').allTextContents()).find((o) =>
    o.includes('Measured and mapped'),
  )!;
  expect(label).toMatch(/^M\d+ Measured and mapped/);
  await pick.selectOption({ label });
  await expect(ms).toContainText(/M\d+ Measured and mapped/);
  await expect(ms).not.toContainText(/M\d+ M\d+/);
});

test('#1796 the panel writes ?feature=, the link opens it, Back and Forward follow', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await roadmap(page);
  await openRoadmapItem(page, 'setup-checklist');
  await expect(page).toHaveURL(/[?&]feature=F-01(&|$)/);
  // Copy link, from the panel's menu.
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  await panel(page).getByRole('menuitem', { name: 'Copy link' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).searchParams.get('feature')).toBe('F-01');
  expect(new URL(copied).pathname).toBe('/simple/roadmap');
  // Closing takes the parameter off; Back opens it again; Forward closes it.
  await panel(page).getByRole('button', { name: 'Close' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/feature=/);
  await page.goBack();
  await expect(page).toHaveURL(/feature=F-01/);
  await expect(panel(page)).toHaveAttribute('aria-label', 'Setup checklist');
  await page.goForward();
  await expect(page).not.toHaveURL(/feature=/);
  await expect(panel(page)).toHaveCount(0);
  // Back again, then Back past the open: the panel closes with the address.
  await page.goBack();
  await expect(panel(page)).toBeVisible();
  // The copied link opens the panel on a fresh load.
  await page.goto(copied);
  await expect(panel(page)).toHaveAttribute('aria-label', 'Setup checklist');
});

for (const [where, path] of [
  ['Home', '/simple'],
  ['Goal map', '/simple/goals'],
  ['Priorities', '/simple/priorities'],
  ['Roadmap', '/simple/roadmap'],
] as const)
  test(`#1796 ${where} opens the panel a link names, by its code in any case`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 620 });
    await login(page);
    await page.goto(`${path}?feature=f-79`);
    await expect(panel(page)).toHaveAttribute('aria-label', 'Weekly alert digest');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/feature=/);
  });

test('#1796 a phone panel that switches to its parent stays one panel, with the parent in the address', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(([k]) => localStorage.setItem(k, 'parts-tree'), [
    MOCK_SCENARIO_KEY,
  ] as const);
  await login(page, 'avery.lane@example.com');
  await page.goto('/simple/roadmap');
  await expect(page.getByTestId('simple-roadmap')).toBeVisible();
  await openRoadmapItem(page, 'alert-export');
  await expect(panel(page)).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]feature=/);
  const before = new URL(page.url()).searchParams.get('feature');
  await panel(page)
    .getByTestId('card-part-of')
    .getByRole('button', { name: 'Alert rules engine' })
    .click();
  await expect(panel(page).getByTestId('card-name')).toContainText('Alert rules engine');
  await expect(page).not.toHaveURL(new RegExp(`feature=${before}(&|$)`));
  await expect(page).toHaveURL(/[?&]feature=/);
  await expect(panel(page)).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

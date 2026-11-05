import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_BLOCKED_RUN, PRIORITY_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * walk-docs-priorities: the Priorities screen as a person reads it, live and in a run's order.
 *
 * Test cards (protects / fails_when / no_claim):
 * - "1 the band names the PRD by its title": protects=a run's order names a PRD not imported
 *   yet by the brief's title; fails_when=it reads words made from the slug; no_claim=the API
 *   (api/tests/test_priority_run_order.py).
 * - "2 the inspector's tiles fit their content": fails_when=a tile's label or figure breaks
 *   inside a word ("Confidenc e", "0.6 0") at 1456 px.
 * - "3 a snapshot's Top names its features": fails_when=a feature the order on screen lacks
 *   shows as its key.
 * - "4 the run's Goal column breaks no goal name inside a word" at 1512 px: a guard only; the
 *   break was not reproduced on the mock, so no change is claimed for it.
 * - "5 Depends on names a dependency the PRD left out and says so": fails_when=its key shows,
 *   or nothing says it is outside the PRD's scope.
 * - "6 at 390 px every table row fits the phone".
 */

const APPROVER = "approver@example.com";

async function seeded(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "priority-order"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
}

async function runOrder(page: Page, run = PRIORITY_RUN) {
  await page.goto(`/runs/${run}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await expect(page).toHaveURL(/\/priorities\?snapshot=/);
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible();
}

/** The words under `root` that a line break cuts in two. */
function brokenWords(root: Locator): Promise<string[]> {
  return root.evaluateAll((els) => {
    const out: string[] = [];
    for (const el of els) {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
        for (const m of n.data.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(n, m.index!);
          r.setEnd(n, m.index! + m[0].length);
          if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1) out.push(m[0]);
        }
      }
    }
    return out;
  });
}

test("1 the band names the PRD by its title, never its slug", async ({ page }) => {
  await seeded(page);
  await runOrder(page, PRIORITY_BLOCKED_RUN);
  await expect(page.getByTestId("snapshot-band")).toContainText("Example Co · Usage alerts");
});

test("2 the inspector's tiles fit their content at 1456 px", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 900 });
  await seeded(page);
  await runOrder(page);
  const tiles = page.getByTestId("priority-inspector").locator("dl");
  await expect(tiles).toContainText("Confidence");
  await expect(tiles).toContainText("Score");
  expect(await brokenWords(tiles)).toEqual([]);
  // Live too: the same tiles.
  await page.goto("/priorities");
  await expect(page.getByTestId("priority-inspector").locator("dl")).toContainText("Confidence");
  expect(await brokenWords(page.getByTestId("priority-inspector").locator("dl"))).toEqual([]);
});

test("3 a snapshot's Top names its features, also those the order on screen lacks", async ({ page }) => {
  await seeded(page);
  await page.goto("/priorities");
  await page.getByRole("button", { name: "Save snapshot" }).click();
  await expect(page.getByTestId("snapshot-list").getByRole("listitem")).toHaveCount(2);
  await runOrder(page);
  const list = page.getByTestId("snapshot-list");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Top: ");
  // The Checkout redesign order's fifth feature was dropped since: by its name, not "F-41".
  await expect(list).toContainText("Gift wrap at checkout");
  await expect(list).not.toContainText(/\bF-\d+\b/);
});

test("4 the run's Goal column breaks no goal name inside a word at 1512 px", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await seeded(page);
  await runOrder(page);
  const goals = page.getByTestId("row-goals");
  await expect(goals.first()).toBeVisible();
  expect(await brokenWords(goals)).toEqual([]);
});

test("5 Depends on names a dependency the PRD left out, with no extra note (RP1 a)", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await seeded(page);
  await runOrder(page);
  const deps = page.getByTestId("row-deps");
  await expect(deps.filter({ hasText: "Address lookup service" })).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText(/\bF-8\b/);
  await expect(deps.filter({ hasText: "Scheduled exports" })).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("Outside this PRD's scope");
  // The cycle banner names it too.
  await expect(page.getByTestId("cycles-banner")).toContainText("Bulk export → Scheduled exports");
});

test("6 at 390 px every table row of the run's order fits the phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seeded(page);
  await runOrder(page);
  const wide = await page.locator("tr").evaluateAll((rows) =>
    rows.map((r) => Math.ceil(r.getBoundingClientRect().width)).filter((w) => w > window.innerWidth),
  );
  expect(wide).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

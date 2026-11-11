import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Goal map editing gaps (the owner's Nov 6 "no delete or drag-drop"), on the goals by tracks
 * grid, against the mock ("goal-ladder" scenario: invented goals, milestones and features). A
 * move that fails half way leaves nothing half done; a milestone in Settings › Trash comes back
 * on Restore.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("gm-goal").first()).toBeVisible();
}

/** A feature's chip by its code (F-03, never F-031). */
const chip = (page: Page, code: string) => page.getByTestId("gm-chip").filter({ hasText: new RegExp(`${code}(?!\\d)`) });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });

async function menu(page: Page, on: Locator, item: string) {
  await on.hover();
  await on.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("a move to another goal's milestone that fails leaves the feature on its milestone", async ({ page }) => {
  // protects=a move never leaves partial state: the owner moves F-03 from Goal 1's Weekly active
  // teams first measured onto Goal 2's Imports finish without help and the move fails (500); the
  // chip stays on its milestone in Goal 1's column, after a reload too; fails_when=the chip ends on
  // no milestone or in the other goal; no_claim=the API's own rollback.
  await open(page);
  const goal1 = await page.getByTestId("gm-goal").first().getAttribute("data-goal");
  // F-03 serves Goal 2 too, so it has a chip there as well: this is Goal 1's.
  const inGoal1 = () => page.locator(`[data-testid="gm-cell"][data-goal="${goal1}"]`).filter({ has: chip(page, "F-03") });
  const own = () => page.locator(`[data-testid="gm-cell"][data-goal="${goal1}"]`).getByTestId("gm-chip").filter({ hasText: /F-03(?!\d)/ });
  await expect(own()).toContainText("Weekly active teams first measured");
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [MOCK_FAIL_ONCE_KEY, "POST /v1/simple/goal-map/links/move"] as const);
  await menu(page, own(), "Move to…");
  await page.getByTestId("gm-mover").getByRole("button", { name: /Imports finish without help/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Mock failure" })).toBeVisible();
  await expect(own()).toContainText("Weekly active teams first measured");
  await expect(inGoal1()).toHaveCount(1);
  await page.reload();
  await expect(own()).toContainText("Weekly active teams first measured");
  await expect(inGoal1()).toHaveCount(1);
});

test("a milestone moved to Trash comes back on the map from Settings › Trash", async ({ page }) => {
  // protects=a milestone's Move to Trash lists it in Settings › Trash as a Milestone, and Restore
  // there puts it back on the map; fails_when=Trash does not list it or Restore leaves it gone;
  // no_claim=the goal-in-Trash refusal (pytest).
  await open(page);
  const m = strip(page, "Renewal rate at 85% for spring renewals");
  await menu(page, m, "Move to Trash");
  await expect(m).toHaveCount(0);
  await page.goto("/settings/trash");
  const row = page.getByRole("listitem").filter({ hasText: "Renewal rate at 85% for spring renewals" }).first();
  await expect(row.getByTestId("trash-kind")).toHaveText("Milestone");
  await row.getByRole("button", { name: /Restore/ }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Renewal rate at 85% for spring renewals" })).toHaveCount(0);
  await page.goto("/simple/goals");
  await expect(strip(page, "Renewal rate at 85% for spring renewals")).toHaveCount(1);
});

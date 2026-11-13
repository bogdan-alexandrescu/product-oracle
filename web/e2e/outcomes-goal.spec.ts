import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes edits (owner, Nov 13), Change goal: an outcome's goal is picked from the company
 * goals in its inspector; the table's Goal follows and the prediction stays as written. Mock
 * API, "outcomes" scenario (synthetic: Order status emails measures Raise activation).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("an approver moves an outcome to another goal from its inspector", async ({ page }) => {
  // protects=the inspector's Goal picks another company goal; the row and the inspector show
  // it after a reload and the prediction is unchanged; fails_when=there is no picker, the goal
  // does not save, or the prediction is cleared; no_claim=the track record's per-goal split.
  await start(page);
  await row(page, "Order status emails").click();
  const goal = inspector(page).getByLabel("Goal");
  await expect(goal).toHaveValue(/.+/);
  await goal.selectOption({ label: "Cut early churn" });
  await expect(row(page, "Order status emails")).toContainText("Cut early churn");
  await page.reload();
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
  await row(page, "Order status emails").click();
  await expect(inspector(page).getByLabel("Goal").locator("option:checked")).toHaveText("Cut early churn");
  await expect(inspector(page)).toContainText("Predicted 38% → 42%");
});

test("a viewer reads the goal without a picker", async ({ page }) => {
  // protects=only roles that may update an outcome get the picker; fails_when=a viewer sees
  // one; no_claim=the API's 403 (tests/test_outcome_goal_change.py).
  await start(page, "viewer");
  await row(page, "Order status emails").click();
  await expect(inspector(page)).toContainText("Raise activation");
  await expect(inspector(page).getByLabel("Goal")).toHaveCount(0);
});

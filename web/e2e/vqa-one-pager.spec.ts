import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA of the one-pager (the mock's invented PRD "guided-setup"), driven through the UI.
 *
 * vqa one-pager 1: protects = a drawn flow stays with the bet it was drawn for when the PRD's
 * next version adds a bet above it ("one-pager-bet-added": every bet's line moved down one);
 * the new bet offers "Draw the flow"; fails_when = each bet shows the flow of the bet above it
 * (the new first bet shows "Finish setup from the checklist", the checklist bet none);
 * no_claim = the API's test_simple_bet_flow_versions.py.
 *
 * vqa one-pager 2 is in simple-one-pager-run-prd.spec.ts (an outcome's measure).
 *
 * vqa one-pager 3: protects = every milestone row of the Timeline strip reads its name: a
 * milestone record named only by its code ("M2") reads the name another item gives that code
 * ("one-pager-milestone-names"); fails_when = a row reads "Milestone M2 · 1 roadmap item";
 * no_claim = which code a row shows (an owner's decision).
 */

const URL = "/simple/one-pagers/guided-setup";

async function scenario(page: Page, s: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);
}

test("vqa one-pager 1: a drawn flow stays on its bet when a bet is added above it", async ({ page }) => {
  await scenario(page, "one-pager-bet-added");
  await login(page);
  await page.goto(URL);
  const bets = page.getByRole("region", { name: "What we will build" });
  await expect(bets.locator('[data-line="bets-1"]')).toContainText("Workspace templates for common teams");
  const checklist = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
  await expect(checklist).toContainText("Finish setup from the checklist");
  await expect(page.getByRole("button", { name: "Draw the flow for “A setup checklist" })).toHaveCount(0);
  // The new bet has no flow of its own: it offers to draw one, never the checklist's.
  await expect(page.getByRole("group", { name: "User flow of “Workspace templates for common" })).toHaveCount(0);
  await expect(bets.locator('[data-line="bets-1"]')).not.toContainText("Finish setup from the checklist");
  await expect(page.getByRole("button", { name: "Draw the flow for “Workspace templates for common" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw the flow for “Invite suggestions from the admin's" })).toBeVisible();
});

test("vqa one-pager 3: every milestone row of the Timeline strip reads its name", async ({ page }) => {
  await scenario(page, "one-pager-milestone-names");
  await login(page);
  await page.goto(URL);
  const labels = page.getByLabel("Timeline strip").getByTestId("plan-strip-label");
  await expect(labels).toHaveText([
    "M1 · Measured and mapped · 1 roadmap item",
    "M2 · Ship to beta · 1 roadmap item",
    "M2 · Ship to beta · 1 roadmap item",
  ]);
});

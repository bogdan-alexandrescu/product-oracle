import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * stuck-milestone-decline: a change asked of a PRD's milestone whose milestone has since moved on
 * to another ask used to answer 409 on Accept and Decline both, so it waited forever on Home.
 * Driven through the UI against the mock (scenario "simple-prd-milestone-stuck": M2 Digest for
 * all teams, asked on Nov 4 to move to Jan 5 and on Nov 5 to Jan 12; it waits on the Nov 5 ask only).
 *
 * The Simple roadmap's Needs a decision panel lists both asks, newest first, in the same words
 * (no date), so the stuck one is the second, and the refused Accept says which it is.
 *
 * The scenario also has an ask (Nov 3) on M4 Routing by team, whose milestone is gone; Usage
 * alerts is owned there by its track's owner, Priya Raman (approver@example.com), who is not a
 * company owner.
 *
 * fails_when: Decline is refused or the stuck ask stays on Home or in Needs a decision, Accept
 * goes through, or the milestone's newer ask goes with it; the PRD's owner is not shown, or may
 * not decline, an ask whose milestone is gone; no_claim: the API's own rules
 * (api/tests/test_simple_goal_milestones_api.py).
 */

async function open(page: Page, path: string, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-prd-milestone-stuck"] as const);
  await login(page, email);
  await page.goto(path);
}

test("the company's owner declines a stuck milestone ask on Home and it goes, the newer ask stays", async ({ page }) => {
  await open(page, "/simple");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  const asks = proposals.getByTestId("home-proposal");
  const stuck = asks.filter({ hasText: "Nov 4," });
  await expect(stuck).toHaveCount(1);
  await expect(asks.filter({ hasText: "Nov 5," })).toHaveCount(1);
  // Accepting it is still refused, in words, and it stays.
  await stuck.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("This proposal no longer waits on this milestone")).toBeVisible();
  await expect(stuck).toHaveCount(1);
  await stuck.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(stuck).toHaveCount(0);
  await expect(asks.filter({ hasText: "Nov 5," })).toHaveCount(1);
  // It stays gone after a reload.
  await page.reload();
  await expect(asks.filter({ hasText: "Nov 5," })).toHaveCount(1);
  await expect(stuck).toHaveCount(0);
});

test("the company's owner declines a stuck milestone ask in the roadmap's Needs a decision, the newer ask stays", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  const tray = page.getByTestId("decision-tray");
  const asks = tray.getByTestId("tray-proposal").filter({ hasText: "PRD milestone ‘Digest for all teams’: change a milestone" });
  await page.getByTestId("needs-decision").click();
  await expect(tray).toBeVisible();
  await expect(asks).toHaveCount(2);
  // Newest first: the Nov 4 ask is the second. Accepting it is refused, in words, and both stay.
  const stuck = asks.nth(1);
  await stuck.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("This proposal no longer waits on this milestone")).toBeVisible();
  await expect(asks).toHaveCount(2);
  await stuck.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(asks).toHaveCount(1);
  // It stays gone after a reload; the one left is the Nov 5 ask, as Home says.
  await page.reload();
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("needs-decision").click();
  await expect(tray).toBeVisible();
  await expect(asks).toHaveCount(1);
  await page.goto("/simple");
  const home = page.getByTestId("home-proposals").getByTestId("home-proposal");
  await expect(home.filter({ hasText: "Nov 5," })).toHaveCount(1);
  await expect(home.filter({ hasText: "Nov 4," })).toHaveCount(0);
});

test("the PRD's owner, not a company owner, declines on Home an ask whose milestone is gone", async ({ page }) => {
  await open(page, "/simple", "approver@example.com");
  const proposals = page.getByTestId("home-proposals");
  await expect(proposals.getByRole("heading", { name: "Proposals on your items" })).toBeVisible();
  const asks = proposals.getByTestId("home-proposal");
  const gone = asks.filter({ hasText: "Nov 3," });
  await expect(gone).toHaveCount(1);
  // Accepting it is refused, in words, and it stays.
  await gone.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("The milestone is gone")).toBeVisible();
  await expect(gone).toHaveCount(1);
  await gone.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  await expect(gone).toHaveCount(0);
  await expect(asks.filter({ hasText: "Nov 5," })).toHaveCount(1);
  // It stays gone after a reload.
  await page.reload();
  await expect(asks.filter({ hasText: "Nov 5," })).toHaveCount(1);
  await expect(gone).toHaveCount(0);
});

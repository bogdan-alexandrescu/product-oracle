import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * stuck-milestone-decline: a change asked of a PRD's milestone whose milestone has since moved on
 * to another ask used to answer 409 on Accept and Decline both, so it waited forever on Home.
 * Driven through the UI against the mock (scenario "simple-prd-milestone-stuck": M2 Digest for
 * all teams, asked on Nov 4 to move to Jan 5 and on Nov 5 to Jan 12; it waits on the Nov 5 ask only).
 *
 * fails_when: Decline is refused or the stuck ask stays on Home, Accept goes through, or the
 * milestone's newer ask goes with it; no_claim: the API's own rules
 * (api/tests/test_simple_goal_milestones_api.py).
 */

test("the company's owner declines a stuck milestone ask on Home and it goes, the newer ask stays", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-prd-milestone-stuck"] as const);
  await login(page);
  await page.goto("/simple");
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

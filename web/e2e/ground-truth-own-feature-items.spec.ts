import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_SHARED_NAMED_SCENARIO, GROUND_TRUTH_SHARED_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * Its own feature, per item (PR 1524's re-review): a proposal two items share, named after one of them, is
 * confirmed for that item only when it adds it as its own feature (fixes.own_feature's confirmed_for); and a
 * person's link back to the match an item declined clears the decline (changes._apply's set_feature). The
 * "ground-truth-shared" scenarios: a run's proposal shared by Chat alerts (its PRD section f-140) and Forum
 * alerts, named Community alerts, or Chat alerts in "ground-truth-shared-named". Invented data only.
 */

async function open(page: Page, scenario: string, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await toList(page);
}

async function toList(page: Page) {
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
  await page.getByTestId("gt-count-unlinked_item").click();
  await expect(list(page)).toBeVisible();
}

const list = (page: Page) => page.getByTestId("gt-list-unlinked_item");
// An item's row by its own name (a row also names the feature it waits on).
const row = (page: Page, name: string) => list(page).getByTestId("gt-row").filter({ has: page.getByRole("button", { name: `About ${name}`, exact: true }) });

test("its own feature on a shared proposal of its name leaves the other item to confirm", async ({ page }) => {
  await open(page, GROUND_TRUTH_SHARED_NAMED_SCENARIO, "approver@example.com");
  await expect(row(page, "Forum alerts")).toContainText("Waiting to be confirmed");
  await row(page, "Chat alerts").getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByTestId("gt-own-feature").click();
  await expect(page.getByTestId("gt-notice")).toContainText("Added “Chat alerts” to the Ground Truth as F-140.");
  await expect(row(page, "Chat alerts")).toHaveCount(0);
  // Forum alerts is not in the Ground Truth until it is confirmed itself.
  await expect(row(page, "Forum alerts")).toContainText("Waiting to be confirmed");
  await row(page, "Forum alerts").getByRole("button", { name: /Confirm it/ }).click();
  await expect(row(page, "Forum alerts")).toHaveCount(0);
});

test("linking an item back to the match it declined takes it off the list", async ({ page }) => {
  await open(page, GROUND_TRUTH_SHARED_SCENARIO, "approver@example.com");
  await row(page, "Chat alerts").getByRole("button", { name: /Confirm it/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Community alerts”");
  // The approver adds Forum alerts as its own feature: the link waits for the roadmap's decider.
  await row(page, "Forum alerts").getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByTestId("gt-own-feature").click();
  await expect(page.getByTestId("gt-notice")).toContainText("Added “Forum alerts” to the Ground Truth");
  await signOut(page);
  // The owner declines that link on Home, so Forum alerts is flagged again.
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("home-proposal").filter({ hasText: "Forum alerts" }).getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("home-proposal").filter({ hasText: "Forum alerts" })).toHaveCount(0);
  await toList(page);
  await row(page, "Forum alerts").getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Community alerts" }).click();
  await expect(row(page, "Forum alerts")).toHaveCount(0);
  await expect(row(page, "Chat alerts")).toHaveCount(0);
});

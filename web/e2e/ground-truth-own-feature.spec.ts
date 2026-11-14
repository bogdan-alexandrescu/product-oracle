import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_SHARED_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Its own feature (the owner, Nov 13): a roadmap item Oracle matched to a proposed feature can join the
 * Ground Truth as a feature of its own, from Link to a feature's picker; and confirming a proposal two
 * items share confirms it for the one item only, so the other stays flagged. The "ground-truth-shared"
 * scenario: Community alerts, a run's proposal shared by Chat alerts (its PRD section f-140) and Forum
 * alerts. Invented data only.
 */

async function open(page: Page, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_SHARED_SCENARIO] as const);
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
  await page.getByTestId("gt-count-unlinked_item").click();
  await expect(list(page)).toBeVisible();
}

const list = (page: Page) => page.getByTestId("gt-list-unlinked_item");
const row = (page: Page, name: string) => list(page).getByTestId("gt-row").filter({ hasText: name });

test("an approver adds a proposed-match item as its own feature from the picker", async ({ page }) => {
  await open(page, "approver@example.com");
  await expect(row(page, "Chat alerts")).toContainText("Waiting to be confirmed");
  await row(page, "Chat alerts").getByRole("button", { name: /Link to a feature/ }).click();
  const picker = page.getByTestId("gt-picker");
  // The picker's first entry, before the Ground Truth's features.
  await expect(picker.getByRole("button").filter({ hasText: /Its own feature|F-\d+/ }).first()).toHaveText("+ Its own feature");
  await picker.getByTestId("gt-own-feature").click();
  await expect(page.getByTestId("gt-notice")).toContainText("Added “Chat alerts” to the Ground Truth as F-140.");
  await expect(row(page, "Chat alerts")).toHaveCount(0);
  // Forum alerts still waits on the proposal Chat alerts declined.
  await expect(row(page, "Forum alerts")).toContainText("Waiting to be confirmed");
  await expect(row(page, "Forum alerts").getByRole("button", { name: /Confirm it/ })).toBeVisible();
});

test("an item on a shared proposal stays listed after the other is confirmed", async ({ page }) => {
  await open(page, "approver@example.com");
  await row(page, "Chat alerts").getByRole("button", { name: /Confirm it/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Community alerts”");
  await expect(row(page, "Chat alerts")).toHaveCount(0);
  // Forum alerts is not in the Ground Truth until it is confirmed itself.
  await expect(row(page, "Forum alerts")).toContainText("Waiting to be confirmed");
  await row(page, "Forum alerts").getByRole("button", { name: /Confirm it/ }).click();
  await expect(row(page, "Forum alerts")).toHaveCount(0);
});

test("a viewer sees no Its own feature", async ({ page }) => {
  await open(page, "viewer@example.com");
  await expect(row(page, "Forum alerts")).toContainText("Waiting to be confirmed");
  await expect(list(page).getByRole("button", { name: /Link to a feature/ })).toHaveCount(0);
  await expect(page.getByTestId("gt-own-feature")).toHaveCount(0);
});

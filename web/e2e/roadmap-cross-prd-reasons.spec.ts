import { expect, test, type Page } from "./test";

import { login, seedRoadmapCrossPrd } from "./helpers";

/**
 * The owner, Nov 4: a roadmap item may depend on another PRD's feature on the company roadmap.
 * Budget caps (Now) waits on Account health ledger, the Safety PRD's item in Next, and on its
 * own Anomaly detection (Later). The review shows each reason in its own words with its own
 * fixes, the other PRD's feature by name, and acting on one clears that one only.
 */

const CROSS = "Needs Account health ledger (Safety PRD), which is in Next. An item cannot ship before what it depends on.";
const LOCAL = "Needs Anomaly detection, which is in Later. An item cannot ship before what it depends on.";

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("roadmap-item-inspector");
const card = (page: Page, text: string) => inspector(page).getByTestId("reason-card").filter({ hasText: text });

async function openReview(page: Page) {
  await login(page);
  await seedRoadmapCrossPrd(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-6"]').getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
}

test("an item waiting on another PRD's feature and on its own item shows both reasons with their own fixes; acting on one clears it", async ({ page }) => {
  await openReview(page);
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");
  await expect(row(page, "budget-caps").getByTestId("reason-chip")).toHaveText(["Depends on a later item", "Depends on a later item"]);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();

  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await expect(cross).toHaveCount(1);
  await expect(local).toHaveCount(1);
  await expect(cross.getByRole("button")).toHaveText(["Move to Next", "Remove dependency", "Waive…"]);
  await expect(local.getByRole("button")).toHaveText(["Move to Later", "Pull dependency to Now", "Remove dependency", "Waive…"]);
  // The other PRD's feature is named, never shown as its key.
  const depends = inspector(page).getByTestId("item-depends");
  await expect(depends).toContainText("Account health ledger (Safety PRD)");
  await expect(depends).toContainText("Anomaly detection");
  await expect(inspector(page)).not.toContainText("account-health-ledger");

  // Acting on the other PRD's reason clears it, and only it.
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toHaveCount(0);
  await expect(local.getByRole("button", { name: "Move to Later", exact: true })).toBeVisible();
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // Acting on its own item's reason clears that one, and the item leaves the blocking count.
  await local.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(local).toContainText("✓ Moved to Later");
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

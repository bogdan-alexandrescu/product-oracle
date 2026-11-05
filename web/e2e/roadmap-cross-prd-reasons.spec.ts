import { expect, test, type Page } from "./test";

import { login, seedRoadmapCrossPrd } from "./helpers";

const COMMENTER = "commenter@example.com";

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

test("Move to Later on its own item's reason also clears the other PRD's reason in Next", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  // In Later, Budget caps ships after both: the ledger (Next) and Anomaly detection (Later).
  await local.getByRole("button", { name: "Move to Later", exact: true }).click();
  await expect(local).toContainText("✓ Moved to Later");
  await expect(cross).toContainText("✓ Moved to Later");
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

test("Remove dependency pressed on both reasons removes both and clears both", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("✓ Dependency removed");
  // The first removal stays: its dependency does not come back and its reason stays answered.
  await expect(cross).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");
});

test("Undo on one of two joined removals brings back that dependency only; the other stays removed", async ({ page }) => {
  await openReview(page);
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("✓ Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("✓ Dependency removed");
  await expect(page.getByTestId("review-summary")).toHaveText("2 blocking · 7 to confirm");

  // Undo on the ledger's card: its reason and its dependency come back, Anomaly detection stays removed.
  await cross.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(cross.getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
  await expect(local).toContainText("✓ Dependency removed");
  await expect(local.getByRole("button", { name: "Move to Later", exact: true })).toHaveCount(0);
  const depends = inspector(page).getByTestId("item-depends");
  await expect(depends.getByRole("button", { name: "Remove dependency Account health ledger (Safety PRD)" })).toBeVisible();
  await expect(depends.getByRole("button", { name: "Remove dependency Anomaly detection" })).toHaveCount(0);
  // One reason open on Budget caps: it stays blocking, and nothing else changes.
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // A reload reads the same: one removal staged.
  await page.reload();
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  await expect(card(page, LOCAL)).toContainText("✓ Dependency removed");
  await expect(card(page, CROSS).getByRole("button", { name: "Move to Next", exact: true })).toBeVisible();
});

test("a commenter's two Remove dependency suggestions both stay, each card with its own Undo", async ({ page }) => {
  await login(page, COMMENTER);
  await seedRoadmapCrossPrd(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-6"]').getByRole("link").first().click();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  await row(page, "budget-caps").locator('[data-phone="title"]').click();
  const cross = card(page, CROSS);
  const local = card(page, LOCAL);
  const depends = inspector(page).getByTestId("item-depends");

  await cross.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(cross).toContainText("Suggested: Dependency removed");
  await local.getByRole("button", { name: "Remove dependency", exact: true }).click();
  await expect(local).toContainText("Suggested: Dependency removed");
  // The first suggestion stays: both dependencies read as removed.
  await expect(cross).toContainText("Suggested: Dependency removed");
  await expect(depends.getByRole("button", { name: /^Remove dependency / })).toHaveCount(0);
  // A suggestion answers nothing until an approver stages it.
  await expect(page.getByTestId("review-summary")).toHaveText("3 blocking · 7 to confirm");

  // Undo on Anomaly detection's card takes back that suggestion only.
  await local.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(local.getByRole("button", { name: "Remove dependency", exact: true })).toBeVisible();
  await expect(cross).toContainText("Suggested: Dependency removed");
  await expect(depends.getByRole("button", { name: "Remove dependency Anomaly detection" })).toBeVisible();
  await expect(depends.getByRole("button", { name: "Remove dependency Account health ledger (Safety PRD)" })).toHaveCount(0);
});

import { expect, test, type Page } from "./test";

import { login, seedRoadmapDepsChanged } from "./helpers";

/**
 * An item keeps one dependency edit, so an approver's × in the item panel joins the one there.
 * Attempt 2 swapped Webhooks' dependency on Budget caps for Usage export unasked; its Revert
 * stages Budget caps back and Usage export out. Driven through the UI over the mock API.
 */

const CHANGED = "Changed without being asked: dependencies slack-alerts, budget-caps → slack-alerts, usage-export";

const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("roadmap-item-inspector");

// Review follow-up (PR 1275, minor): protects = an approver's × on a dependency keeps what the
// item's dependency edit adds; fails_when = the × stages its removals only and Budget caps is
// not added back; no_claim = a commenter's ×, which meets another person's edit apart.
test("an approver's × on a dependency keeps the dependency the item's edit adds back", async ({ page }) => {
  await login(page);
  await seedRoadmapDepsChanged(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-roadmap-7"]').getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  await page.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();

  await row(page, "webhooks").locator('[data-phone="title"]').click();
  const card = inspector(page).getByTestId("reason-card").filter({ hasText: CHANGED });
  await card.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(card).toContainText("✓ Depends on Budget caps");
  const depends = inspector(page).getByTestId("item-depends");
  await expect(depends.getByRole("button", { name: "Remove dependency Usage export" })).toHaveCount(0);

  await depends.getByRole("button", { name: "Remove dependency Slack alerts" }).click();
  await expect(depends.getByRole("button", { name: /^Remove dependency / })).toHaveCount(0);
  // The joined edit still adds Budget caps back.
  await expect(card).toContainText("✓ Depends on Budget caps");
  await inspector(page).getByRole("tab", { name: "History" }).click();
  await expect(inspector(page).getByTestId("item-history")).toContainText("staged: Depends on Budget caps");
});

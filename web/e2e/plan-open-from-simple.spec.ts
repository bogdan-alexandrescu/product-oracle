import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card plan-open-from-simple: protects = Simple's "Open the detailed view" lands on that item
 * on the Plan, selected, in view and open in the inspector (a phone: the bottom sheet), even when
 * the Plan reads it under another PRD than the card's link names; an item only in a draft gets
 * one line saying so, with a link back to its card; fails_when = the Plan shows its first row or
 * nothing; no_claim = the inspector's own parts (plan-inspector-actions).
 * Invented data: the mock's Alerts and Onboarding roadmaps (web/lib/api/mock).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** From Simple's roadmap, an item's card, then its "Open the detailed view". */
async function openDetailed(page: Page, key: string, title: string) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  const card = page.getByTestId("floating-card");
  await expect(card.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await card.getByRole("link", { name: "Open the detailed view" }).click();
  await expect(page).toHaveURL(new RegExp(`/plan\\?item=${key}&prd=[0-9a-f-]{36}$`));
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test("the detailed view opens the item, though the Plan reads it under another PRD", async ({ page }) => {
      await openDetailed(page, "alert-digest", "Weekly alert digest");
      // The Plan's own row for the key, not its first row.
      const row = page.locator('[data-testid="plan-row"][data-item="alert-digest"]');
      await expect(row).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(1);
      await expect(row).toBeInViewport();
      if (where === "phone") {
        const sheet = page.getByTestId("sheet-plan-item");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByTestId("plan-inspector")).toContainText("Daily alert digest email");
      } else {
        const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
        await expect(inspector).toContainText("Daily alert digest email");
        await expect(inspector).toBeInViewport();
      }
      await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
    });

    test("an item only in a draft says where it is, with a link to its card", async ({ page }) => {
      await openDetailed(page, "setup-ideas", "Team invite nudges");
      const line = page.getByTestId("plan-missing-item");
      await expect(line).toBeVisible();
      await expect(line).toContainText("Team invite nudges is not on the Plan yet: it is in Guided setup's draft");
      await expect(line).toBeInViewport();
      // Nothing unrelated stands in for it.
      await expect(page.locator('[data-testid="plan-row"][aria-selected="true"]')).toHaveCount(0);
      await expect(page.getByTestId("sheet-plan-item")).not.toBeVisible();
      await line.getByRole("link", { name: "Open it on the roadmap" }).click();
      await expect(page).toHaveURL(/\/simple\/roadmap\?item=[0-9a-f-]{36}$/);
      await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Team invite nudges", exact: true })).toBeVisible();
    });
  });
}

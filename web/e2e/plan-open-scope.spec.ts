import { stableUuid } from "../lib/api/mock/ids";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Card plan-open-from-simple (fix round): protects = Simple's "Open the detailed view" on a card
 * whose key another roadmap also holds opens only the card's roadmap's row; when the Plan shows
 * Approved only and that row is only in a draft, one line names the item, says why, and offers
 * Show drafts, which brings the row and selects it; fails_when = the other roadmap's row with the
 * key is opened in its place, or no line shows; no_claim = the rows' own content (plan.spec.ts).
 * Invented data: the mock's "plan-same-key" scenario, Free shipping threshold alert only in the
 * Checkout redesign roadmap's draft, and Threshold alerts on spend approved in Usage alerts'.
 */

const ITEM = "Free shipping threshold alert";
const OTHER = "Threshold alerts on spend";

async function setup(page: Page, scope: "Approved + drafts" | "Approved only") {
  await page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, "plan-same-key"] as const);
  await login(page);
  await page.goto("/plan");
  const bar = page.getByRole("group", { name: "Plan scope" });
  await bar.getByRole("button", { name: scope }).click();
  await expect(bar.getByRole("button", { name: scope })).toHaveAttribute("aria-pressed", "true");
  // Simple's card link (its &roadmap= is the Simple lane's part): the Plan opened by it, with the
  // card's own PRD id (the mock's item.prd for the Checkout redesign roadmap).
  await page.goto(`/plan?item=threshold-alerts&prd=${stableUuid("simple-prd/checkout-redesign-roadmap")}&roadmap=checkout-redesign-roadmap`);
}

const picked = (page: Page) => page.locator('[data-testid="plan-row"][aria-selected="true"]').filter({ visible: true });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });

test("with Approved + drafts, the card's draft row opens, not the other roadmap's", async ({ page }) => {
  await setup(page, "Approved + drafts");
  await expect(picked(page)).toHaveCount(1);
  await expect(picked(page)).toContainText(ITEM);
  await expect(inspector(page)).toContainText(ITEM);
  await expect(inspector(page)).not.toContainText(OTHER);
  await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
});

test("with Approved only, a line names the draft item and Show drafts opens it", async ({ page }) => {
  await setup(page, "Approved only");
  const line = page.getByTestId("plan-missing-item");
  await expect(line).toBeVisible();
  await expect(line).toContainText(`${ITEM} is only in a draft, and the Plan shows Approved only`);
  await expect(line).toBeInViewport();
  // The other roadmap's row with the same key is on the Plan, but nothing stands in for the item.
  await expect(page.locator('[data-testid="plan-row"][data-item="threshold-alerts"]').filter({ visible: true })).toHaveCount(1);
  await expect(picked(page)).toHaveCount(0);
  await expect(page.getByTestId("plan-inspector").filter({ hasText: OTHER })).toHaveCount(0);
  await line.getByRole("button", { name: "Show drafts" }).click();
  await expect(page.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved + drafts" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("plan-missing-item")).toHaveCount(0);
  await expect(picked(page)).toHaveCount(1);
  await expect(picked(page)).toContainText(ITEM);
  await expect(picked(page)).toBeInViewport();
  await expect(inspector(page)).toContainText(ITEM);
});

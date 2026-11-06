import { login } from "./helpers";
import { expect, test } from "./test";

/*
 * prd-order on Plan (its own file, so the change reverts in one piece): Plan's PRD cards, and
 * Group by PRD's lanes that take their order, read in the company PRD order an owner sets on
 * Simple › One-pagers; a card keeps its "waiting for you" and "At risk" marks. Driven through
 * the UI on the mock (invented data).
 *
 * - protects = the cards in the company order after a move; fails_when = waiting-for-me, then
 *   at-risk, then newest first. no_claim = the API's order (api/tests/test_prd_order_plan.py).
 */

test("Plan's PRD cards follow a move on One-pagers and keep their marks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
  await page.getByRole("button", { name: "More for Online deposits at booking" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.getByTestId("one-pager-row").getByRole("link").nth(2)).toHaveText("Online deposits at booking");
  const order = await page.getByTestId("one-pager-row").getByRole("link").allTextContents();

  await page.goto("/plan");
  const card = page.getByTestId("plan-prd-card");
  await expect(card.first()).toBeVisible();
  const slugs = await card.evaluateAll((els) => els.map((e) => e.getAttribute("data-slug") ?? ""));
  expect(slugs.length).toBeGreaterThanOrEqual(4);
  const shown = await Promise.all(slugs.map((slug) => page.locator(`[data-testid="plan-prd-card"][data-slug="${slug}"]`).innerText()));
  const named = shown.map((text) => order.find((t) => text.startsWith(t)) ?? text);
  expect(named).toEqual(order.filter((t) => named.includes(t)));
  // The marks stay: Saved carts still waits for you, Usage alerts is still at risk.
  await expect(card.filter({ hasText: "Saved carts PRD" })).toContainText("waiting for you");
  await expect(card.filter({ hasText: "Usage alerts PRD" })).toContainText("At risk");
});

import { expect, test } from "@playwright/test";

import { login, openCompanyTab, openMarketTab } from "./ui";

// H7 Competitive digest (PR #541) against the real API: Company › Market's Alternatives and Change log.
test("market: an owner adds an alternative, sees it listed and opens the Change log", async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  await openCompanyTab(page, "market");
  await page.getByRole("button", { name: "Add alternative" }).click();
  const dialog = page.getByRole("dialog", { name: "Add alternative" });
  await dialog.getByLabel("Name").fill("Competitor C");
  await dialog.getByLabel("Kind").selectOption("direct");
  await dialog.getByLabel("Website").fill("https://competitor-c.example");
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("alternative-row").filter({ hasText: "Competitor C" })).toContainText("Direct");

  await openMarketTab(page, "changes");
  await expect(page.getByTestId("change-filters")).toBeVisible();
});

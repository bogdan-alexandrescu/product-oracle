import { expect, test } from "@playwright/test";

import { login, openCompanyTab, openMarketTab } from "./ui";

// H9 Pricing input (PR #541) against the real API: Company › Market › Pricing, then Win and loss.
test("pricing: an owner opens Pricing and Win and loss, adds a record and sees it", async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  await openCompanyTab(page, "market");
  await openMarketTab(page, "pricing");
  // qa-company-20: with no memo yet the header's New pricing memo gives way to the empty list's own button.
  await expect(page.getByRole("button", { name: /^(New|Write a) pricing memo$/ })).toBeVisible();

  await openMarketTab(page, "win-loss");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add win or loss" });
  await add.getByLabel("Result").selectOption({ label: "Won" });
  await add.getByLabel("Account").fill("Account 31");
  await add.getByLabel("Main reason").selectOption({ label: "Value not clear" });
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  const row = page.getByTestId("deal-row").filter({ hasText: "Account 31" });
  await expect(row.getByTestId("deal-result")).toHaveText("Won");
  await expect(row.getByTestId("deal-reason")).toHaveText("Value not clear");
});

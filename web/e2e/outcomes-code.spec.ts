import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * outcomes-code: Outcomes names each roadmap item as every other page does, its Ground Truth
 * code before its title ("F-21 Saved payment methods"), in the Item column and the side panel's
 * header; an item with no code keeps its name with the "Not in the Ground Truth" flag. On the
 * mock API ("outcomes" scenario, synthetic: Saved payment methods is F-21, Order status emails
 * has no code, the earlier bets are of no roadmap item).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function openOutcomes(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page).toHaveURL(/\/plan\/outcomes$/);
  await expect(page.getByTestId("outcomes-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });

test("the Item column and the panel show the item's code before its title", async ({ page }) => {
  // protects=a coded item reads "F-21 Saved payment methods" in its row and in the panel's
  // header, the code first; fails_when=the title shows alone or the code comes after it;
  // no_claim=how the API finds the code (its pytest).
  await openOutcomes(page);
  const saved = row(page, "Saved payment methods");
  await expect(saved.locator(".simple-code")).toHaveText("F-21");
  await expect(saved).toContainText("F-21 Saved payment methods");
  await expect(saved.getByTestId("not-in-gt")).toHaveCount(0);

  await saved.click();
  const header = inspector(page).getByRole("heading").first();
  await expect(header.locator(".simple-code")).toHaveText("F-21");
  await expect(header).toHaveText(/^F-21\s+Saved payment methods$/);
  await expect(inspector(page).getByTestId("not-in-gt")).toHaveCount(0);
});

test("an item with no code keeps its name and is flagged Not in the Ground Truth", async ({ page }) => {
  // protects=an uncoded roadmap item's outcome shows its name with the flag, in the row and the
  // panel, and an outcome of no roadmap item carries none; fails_when=the flag is missing, or
  // every outcome is flagged; no_claim=the flag's fixes (the Roadmap's).
  await openOutcomes(page);
  const emails = row(page, "Order status emails");
  await expect(emails.getByTestId("not-in-gt")).toBeVisible();
  await expect(emails.locator(".simple-code")).toHaveCount(0);
  await expect(row(page, "Earlier activation bet 1").getByTestId("not-in-gt")).toHaveCount(0);

  await emails.click();
  await expect(inspector(page).getByTestId("not-in-gt")).toBeVisible();
  await expect(inspector(page).getByRole("heading").first()).toHaveText("Order status emails");
});

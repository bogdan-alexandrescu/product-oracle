import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The owner, Nov 4: a feature may need another PRD's feature on the company roadmap. At the
 * feature set stop ("scope-review-other-prd" scenario) Address lookup needs Address
 * verification, the Trust PRD's: the row says so in plain words, to confirm, and blocks nothing.
 */

async function openReview(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "scope-review-other-prd"), MOCK_SCENARIO_KEY);
  await login(page, "approver@example.com");
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await page.getByTestId("segment-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeAttached();
}

const row = (page: Page, title: string) => page.getByTestId("scope-row").filter({ has: page.getByTestId("feature-title").filter({ hasText: title }) });

test("a feature that needs another PRD's feature reads so in plain words, to confirm, and blocks nothing", async ({ page }) => {
  await openReview(page);
  const lookup = row(page, "Address lookup");
  await expect(lookup.getByTestId("row-reasons")).toHaveText("Needs Address verification from Trust PRD");
  await expect(lookup).not.toContainText("address-verification");
  // Only Bulk edit's left-out dependency blocks.
  await expect(page.getByTestId("decision-bar").getByTestId("approve-blocked")).toHaveText("1 blocking problem left");
  await lookup.getByRole("button", { name: "Include", exact: true }).click();
  await expect(lookup.getByTestId("row-done")).toContainText("✓");
  await expect(page.getByTestId("decision-bar").getByTestId("approve-blocked")).toHaveText("1 blocking problem left");
});

test("the panel names another PRD's feature it depends on, with its PRD", async ({ page }) => {
  await openReview(page);
  await row(page, "Address lookup").getByTestId("feature-title").click();
  const depends = page.getByTestId("scope-inspector").getByTestId("scope-depends");
  await expect(depends.getByRole("listitem")).toContainText("Address verificationTrust PRD");
  await expect(depends).not.toContainText("address-verification");
  await expect(depends).not.toContainText("Unknown");
  await expect(depends.getByRole("button", { name: "Remove dependency on Address verification" })).toBeVisible();
});

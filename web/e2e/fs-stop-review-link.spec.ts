import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * C7 at the feature set's stop: Review feature set on the checkpoint opens this run's feature
 * set (its features, their requirements and the left-out ones with their reasons), never the
 * Runs list.
 *
 * Test card (protects / fails_when / no_claim):
 * - review-link: protects=the checkpoint's Review feature set opens this run's review screen
 *   with its feature list; fails_when=it lands on the Runs list or another run, or the list
 *   lacks the features, requirements or left-out reasons; no_claim=the rows' own actions
 *   (scope-review.spec.ts).
 */

// The run the "feature-set" mock scenario seeds (web/lib/api/mock/runs.ts).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";

async function openRun(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "feature-set"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
}

test("Review feature set on the checkpoint opens this run's feature list, not the Runs list", async ({ page }) => {
  await openRun(page);
  await page.getByTestId("checkpoint-feature_set").getByRole("link", { name: "Review feature set" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}/review/[0-9a-f-]+$`));
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeHidden();
  await expect(page.getByTestId("review-back")).toContainText("Saved addresses");
  // Every feature, with its requirements.
  await page.getByRole("button", { name: /^All/ }).click();
  const rows = page.getByTestId("scope-row");
  await expect(rows.filter({ hasText: "Saved addresses" })).toContainText("3 of 3 kept");
  await expect(rows.filter({ hasText: "Bulk address edit" })).toContainText("2 of 2 kept");
  // The left-out ones, with why.
  await page.getByRole("button", { name: /^Left out/ }).click();
  const out = rows.filter({ hasText: "Shared address book export" });
  await expect(out).toContainText("Left out");
  await out.getByTestId("feature-title").click();
  await expect(page.getByTestId("scope-inspector")).toContainText("Serves no confirmed goal");
});

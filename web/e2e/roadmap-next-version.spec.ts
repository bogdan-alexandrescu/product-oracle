import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * hotfix 4 (Nov 6): the working draft's banner names the number it becomes, the one after the
 * roadmap's latest version (the API's next_version), not its base's number plus one. The company
 * roadmap's banner said "version 1 is published" and Approve and publish made version 8.
 *
 * fails_when: after a version is approved and a new change opens the next draft, the banner names
 * the base's number plus one; no_claim: the API's numbers (api/tests/test_simple_draft_plan_table.py).
 */

async function open(page: Page) {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const strip = (page: Page) => page.getByTestId("conflicts");

test("after version 2 is approved, the next working draft's banner says version 3", async ({ page }) => {
  await open(page);
  const banner = page.getByTestId("draft-banner");
  await strip(page).locator('[data-testid="conflict"][data-item="alert-digest"]').getByRole("button", { name: "Move the dependents" }).click();
  await expect(banner.getByTestId("draft-next")).toContainText("version 2");
  await banner.getByTestId("draft-publish").click();
  await expect(page.getByText(/Approved: .* is published/)).toBeVisible();
  // A new change on the same roadmap opens its next working draft: the digest's bar moves a day on the Gantt.
  await page.getByRole("button", { name: "Gantt", exact: true }).click();
  // The bar's label now names the feature with its code too, per the Ground Truth rule that
  // every feature shows its code with its name ("F-06 Weekly alert digest").
  await page.locator('[aria-label^="F-06 Weekly alert digest:"]').first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(banner.getByTestId("draft-next")).toContainText("version 3");
  await expect(banner.getByTestId("draft-next")).not.toContainText("version 2");
});

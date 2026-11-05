import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * A PRD's feature may depend on a feature of another area PRD (the owner, Nov 4): every PRD
 * feeds one company roadmap, so the Engineering check reads such a brief and names the
 * dependency with its PRD. On the mock layer ("eng-check-cross-prd": the first brief also
 * depends on the account health ledger of the Safety PRD), driven as the engineering lead would.
 *
 * Test cards:
 * - "read": protects=the briefs are read (no "could not be read" line, every brief listed and
 *   decidable); fails_when=a dependency outside the feature set refuses the whole file.
 * - "named": protects=the brief names the dependency with its PRD ("Account health ledger
 *   (Safety PRD)"); fails_when=it shows the raw key or no PRD.
 * - "phone": the same at 390 px, with nothing scrolling sideways.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);

async function openCheck(page: Page) {
  await withScenario(page, "eng-check-cross-prd");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
}

async function checkBrief(page: Page) {
  await expect(page.getByTestId("briefs-problem")).toHaveCount(0);
  await expect(page.getByText("The briefs could not be read")).toHaveCount(0);
  await page.getByTestId("brief-row").first().getByRole("button").first().click();
  const inspector = page.getByTestId("brief-inspector");
  await expect(inspector.getByText("Depends on Account health ledger (Safety PRD)")).toBeVisible();
  await expect(inspector.getByText("account-health-ledger")).toHaveCount(0);
  await expect(page.getByTestId("eng-tally")).not.toHaveText("The briefs could not be read");
}

test("read and named: a brief depending on another PRD's feature is read and names that PRD", async ({ page }) => {
  await openCheck(page);
  await checkBrief(page);
});

test("phone: at 390 px the brief is read, the dependency named, and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  await checkBrief(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

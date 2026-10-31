import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The architect's briefs cite only the run's code maps (F4 Engineering check): the run's maps
 * cover example/shop-app and example/shop-api, the features mostly live in example/shop-web,
 * which has no map, and the briefs cite ids from it. On the mock layer ("eng-check-unmapped"),
 * driven as the engineering lead would.
 *
 * Test cards:
 * - "grouped": protects=an unknown id is one line naming the features that cite it; fails_when=
 *   the refusal repeats an id once per feature; no_claim=the API's grouping
 *   (api/tests/test_eng_briefs_maps.py).
 * - "unmapped": protects=one line above the briefs names the repository with no map and says
 *   its work is described as assumptions; fails_when=the line is missing or sits below the
 *   briefs; no_claim=the architect's prompt (API tests).
 * - "phone": the same at 390 px, with nothing scrolling sideways.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);

async function openCheck(page: Page) {
  await withScenario(page, "eng-check-unmapped");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
}

async function checkScreen(page: Page) {
  const problems = page.getByTestId("briefs-problem");
  await expect(problems.getByText("The briefs could not be read: send them back to the architect.")).toBeVisible();
  await expect(problems.getByRole("listitem")).toHaveText([
    "'model:catalogue' is not in the code map this run used: cited by f.sample-data",
    "'module:storefront' is not in the code map this run used: cited by f.guided-setup, f.sample-data, f.saved-carts",
  ]);
  const unmapped = page.getByTestId("briefs-unmapped");
  await expect(unmapped).toHaveText("No code map covers example/shop-web: its work is described as assumptions.");
  const line = await unmapped.boundingBox();
  const first = await page.getByTestId("brief-row").first().boundingBox();
  expect(line && first && line.y + line.height <= first.y).toBeTruthy();
}

test("grouped and unmapped: one line per unknown id with its features, and the repository with no map above the briefs", async ({ page }) => {
  await openCheck(page);
  await checkScreen(page);
});

test("phone: at 390 px the same lines show and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  await checkScreen(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

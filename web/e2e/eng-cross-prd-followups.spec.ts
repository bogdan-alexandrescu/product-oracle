import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Cross-PRD dependencies follow-ups: the Engineering check names a dependency it cannot take in
 * words a person reads. On the mock layer ("eng-check-no-prd": the first brief, Guided setup, also
 * depends on Export logs, a Ground Truth feature no PRD holds; the second, Sample data, on a code
 * Oracle cannot find), driven as the engineering lead would, from the Inbox.
 *
 * Test cards:
 * - "no PRD": protects=a Ground Truth feature in no PRD is named at the Engineering check ("Export
 *   logs is in no PRD yet"); fails_when=the check accepts it (and the roadmap items stop refuses
 *   it later) or names it by its key.
 * - "unknown": protects=an unknown dependency names the brief's feature by name and code and what
 *   was not found; fails_when=it reads "features[1] (f.sample-data): depends on ...".
 * - "phone": the same at 390 px, with nothing scrolling sideways.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);

async function openCheck(page: Page) {
  await withScenario(page, "eng-check-no-prd");
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
}

async function checkProblems(page: Page) {
  const problems = page.getByTestId("briefs-problem");
  await expect(problems.filter({ hasText: "Export logs is in no PRD yet: Guided setup depends on it" })).toHaveCount(1);
  await expect(problems.filter({ hasText: 'Sample data (f.sample-data) depends on "made-up-feature", a feature Oracle cannot find in any PRD or in Ground Truth' })).toHaveCount(1);
  await expect(page.getByText(/features\[\d\]/)).toHaveCount(0);
  await expect(page.getByText("export-logs")).toHaveCount(0);
}

test("no PRD and unknown: the Engineering check names a feature in no PRD and an unknown dependency in words", async ({ page }) => {
  await openCheck(page);
  await checkProblems(page);
});

test("phone: at 390 px both problems read in words and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  await checkProblems(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

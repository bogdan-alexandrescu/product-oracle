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
 * - "own heading": protects=a feature in no PRD yet is listed under its own heading, "Features in no
 *   PRD yet", with a link that adds it to a PRD, and not under "The briefs could not be read: send
 *   them back"; fails_when=it is listed with the unreadable briefs (PR 1284 review).
 * - "add to a PRD": protects=the link opens the Ground Truth feature, where it is added to a PRD;
 *   fails_when=there is no way from the check to the feature.
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
  const noPrd = page.getByTestId("briefs-no-prd");
  await expect(noPrd.getByText("Features in no PRD yet", { exact: true })).toBeVisible();
  const item = noPrd.getByTestId("no-prd-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Export logs is in no PRD yet: Guided setup depends on it");
  await expect(item.getByRole("link", { name: "Add it to a PRD" })).toBeVisible();
  const problems = page.getByTestId("briefs-problem");
  await expect(problems).not.toContainText("Export logs");
  await expect(problems.filter({ hasText: 'Sample data (f.sample-data) depends on "made-up-feature", a feature Oracle cannot find in any PRD or in Ground Truth' })).toHaveCount(1);
  await expect(page.getByText(/features\[\d\]/)).toHaveCount(0);
  await expect(page.getByText("export-logs")).toHaveCount(0);
}

test("no PRD, unknown and own heading: the Engineering check names a feature in no PRD under its own heading and an unknown dependency in words", async ({ page }) => {
  await openCheck(page);
  await checkProblems(page);
});

test("add to a PRD: the link opens Export logs in Ground Truth", async ({ page }) => {
  await openCheck(page);
  await page.getByTestId("no-prd-item").getByRole("link", { name: "Add it to a PRD" }).click();
  await expect(page).toHaveURL(/\/baseline\?entity=[0-9a-f-]+$/);
  await expect(page.getByRole("dialog", { name: "Export logs" })).toBeVisible();
});

test("phone: at 390 px both problems read in words and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  await checkProblems(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

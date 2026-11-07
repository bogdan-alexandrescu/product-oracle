import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Cross-PRD dependencies follow-ups: the Engineering check names a dependency it cannot take in
 * words a person reads, and a Ground Truth feature in no PRD can be added to a PRD from the check.
 * On the mock layer ("eng-check-no-prd": the first brief, Guided setup, also depends on Export
 * logs, a Ground Truth feature no PRD holds; the second, Sample data, on a code Oracle cannot find;
 * "eng-check-add-to-prd": Export logs alone), driven from the Inbox.
 *
 * Test cards:
 * - "no PRD": protects=a Ground Truth feature in no PRD is named at the Engineering check ("Export
 *   logs is in no PRD yet"); fails_when=the check accepts it (and the roadmap items stop refuses
 *   it later) or names it by its key.
 * - "unknown": protects=an unknown dependency names the brief's feature by name and code and what
 *   was not found; fails_when=it reads "features[1] (f.sample-data): depends on ...".
 * - "own heading": protects=a feature in no PRD yet is listed under its own heading, "Features in no
 *   PRD yet", not under "The briefs could not be read: send them back"; fails_when=it is listed
 *   with the unreadable briefs.
 * - "add to a PRD": protects=Add it to a PRD offers the company's PRDs and a new PRD; picking the
 *   Safety PRD starts its Ground Truth to PRD run with Export logs to add, and back at the check
 *   the item and its Approve reason are gone, the brief naming Export logs as being added to the
 *   Safety PRD, while the other reason stays; fails_when=the action leads nowhere that adds the
 *   feature to a PRD, or the check still waits on it.
 * - "both reasons": protects=Approve's line names every reason it waits on at once; fails_when=the
 *   no-PRD reason hides "Give each feature a verdict".
 * - "phone": the same at 390 px, with nothing scrolling sideways.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);

async function openCheck(page: Page, scenario = "eng-check-no-prd", who = "commenter@example.com") {
  await withScenario(page, scenario);
  await login(page, who);
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

test("add to a PRD and both reasons: picking the Safety PRD starts its run with Export logs, and the check no longer waits on it", async ({ page }) => {
  await openCheck(page, "eng-check-add-to-prd", "owner@example.com");
  const why = page.getByTestId("approve-why");
  await expect(why).toHaveText("Add each feature in no PRD yet to a PRD, give each feature a verdict and answer each blocking question first");
  await expect(page.getByTestId("briefs-problem")).toHaveCount(0);

  const item = page.getByTestId("no-prd-item");
  await item.getByRole("button", { name: "Add it to a PRD" }).click();
  const picks = page.getByRole("list", { name: "PRDs to add Export logs to" });
  await expect(picks.getByRole("button", { name: "New PRD" })).toBeVisible();
  await picks.getByRole("button", { name: "Safety PRD" }).click();

  const dialog = page.getByRole("dialog", { name: "Add Export logs to Safety PRD" });
  await expect(dialog.getByTestId("run-adds")).toHaveText("Adds Export logs");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: /^(Start run|Approve .+ and start)$/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
  await expect(page.getByTestId("briefs-no-prd")).toHaveCount(0);
  await expect(why).toHaveText("Give each feature a verdict and answer each blocking question first");
  await page.getByTestId("brief-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("brief-inspector")).toContainText("Export logs (being added to Safety PRD)");
});

test("phone: at 390 px both problems read in words and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  await checkProblems(page);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Hotfix: the Engineering check's Approve follows the problems the page shows. A run waits at
 * an Engineering check stored before a dependency on another PRD's feature was read (the owner,
 * Nov 4): its first brief's dependency is stored as unknown. The run's page and the review's
 * gate read the briefs again the same way (oracle.runs.service.recheck_briefs), on the mock
 * layer, driven as the engineering lead would.
 *
 * Test cards:
 * - "approvable" ("eng-check-stale": the dependency is the Safety PRD's account health ledger):
 *   protects=the page shows no problem and Approve opens once every feature has a verdict and the
 *   blocking question an answer, and approving moves the run on; fails_when=the gate counts the
 *   stored problems, so Approve stays disabled with "Give each feature a verdict ..." at
 *   "3 of 3 decided".
 * - "still a problem" ("eng-check-stale-unknown": a ledger no PRD or roadmap knows): protects=the
 *   page says the briefs could not be read, lists the problem and offers only Send back;
 *   fails_when=it shows a disabled Approve with a reason that does not apply.
 */

const withScenario = (page: Page, scenario: string) => page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario]);
const row = (page: Page, key: string) => page.locator(`[data-testid="brief-row"][data-feature="${key}"]`);
const inspector = (page: Page) => page.getByTestId("brief-inspector");
const bar = (page: Page) => page.getByTestId("decision-bar");

async function openCheck(page: Page, scenario: string) {
  await withScenario(page, scenario);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  const inboxRow = page.getByTestId("inbox-checkpoints").locator("tr[data-row]").filter({ hasText: "Engineering check" });
  await inboxRow.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+\/review\/[0-9a-f-]+$/);
  await expect(page.getByTestId("brief-row")).toHaveCount(3);
}

async function feasible(page: Page, key: string) {
  await row(page, key).getByRole("button").first().click();
  await inspector(page).getByRole("group", { name: "Verdict" }).getByRole("button", { name: "Feasible", exact: true }).click();
  await expect(row(page, key).getByTestId("brief-verdict")).toHaveText("Feasible");
}

test("approvable: a stored problem that no longer applies does not hold Approve", async ({ page }) => {
  await openCheck(page, "eng-check-stale");
  await expect(page.getByTestId("briefs-problem")).toHaveCount(0);
  const approve = bar(page).getByRole("button", { name: "Approve" });
  for (const key of ["f.guided-setup", "f.sample-data", "f.saved-carts"]) await feasible(page, key);
  await row(page, "f.guided-setup").getByRole("button").first().click();
  await expect(inspector(page).getByText("Depends on Account health ledger (Safety PRD)")).toBeVisible();
  await inspector(page).getByRole("textbox", { name: /^Answer: Does the payment sandbox/ }).fill("Yes, the sandbox takes test orders.");
  await inspector(page).getByRole("button", { name: "Answer" }).first().click();
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("3 of 3 decided");
  await expect(approve).toBeEnabled();
  await expect(page.getByTestId("approve-why")).toHaveCount(0);
  await approve.click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-priority").getByTestId("segment-state")).toHaveText("Running");
});

test("still a problem: a dependency nobody knows says the briefs could not be read, with Send back", async ({ page }) => {
  await openCheck(page, "eng-check-stale-unknown");
  const problem = page.getByTestId("briefs-problem");
  await expect(problem).toContainText("The briefs could not be read: send them back to the architect.");
  // The dependency named in words, as oracle.engineering.briefs names one no PRD or Ground Truth has.
  await expect(problem).toContainText('depends on "old-ledger", a feature Oracle cannot find in any PRD or in Ground Truth');
  await expect(bar(page).getByTestId("eng-tally")).toHaveText("The briefs could not be read");
  await expect(bar(page).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Send back to architect" })).toBeEnabled();
  await expect(page.getByTestId("approve-why")).toHaveText("Send the briefs back to the architect to write them again");
  await expect(page.getByText("Give each feature a verdict and answer each blocking question first")).toHaveCount(0);
});

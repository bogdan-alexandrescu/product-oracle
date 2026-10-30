import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * A new company's first request (qa-onboarding-12, qa-onboarding-47), in the "empty" scenario
 * (members only: no goals, documents or runs), driven through the UI as a person would on the
 * mock API: file the first request, open it, try to qualify it, follow the page's way to a
 * goal (Build the baseline), then write a brief through PRDs > New PRD and Draft with Oracle,
 * which builds the baseline first and starts the run.
 */

const TITLE = "Export invoices as a spreadsheet";
const WHY = "Finance copies every invoice by hand at the end of each month.";

async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
}

test("qa-onboarding-47, qa-onboarding-12: a new company goes from its first request, through the goal hint and a brief, to its first PRD run", async ({
  page,
}) => {
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
  await login(page);
  await openRequests(page);

  // The first request, from the empty state.
  const empty = page.getByTestId("requests-empty");
  await expect(empty).toContainText("Nothing yet");
  await empty.getByRole("button", { name: "New request" }).click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await expect(dialog).toContainText("No goals yet");
  await dialog.getByLabel("Title").fill(TITLE);
  await dialog.getByLabel("What it is and why").fill(WHY);
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog).toHaveCount(0);

  // It is New and selected; Qualify says how to get a goal instead of refusing with no way on.
  const row = page.getByTestId("request-row").filter({ hasText: TITLE });
  await expect(row).toContainText("New");
  await row.getByRole("button", { name: TITLE }).click();
  const panel = page.getByTestId("request-inspector");
  await expect(panel.getByRole("heading", { name: TITLE })).toBeVisible();
  await panel.getByRole("button", { name: "Qualify", exact: true }).click();
  const needs = panel.getByTestId("qualify-needs-goal");
  await expect(needs).toContainText("there are no goals yet");
  await expect(needs).toContainText("disqualify this request as No goal");
  await panel.getByLabel("Reason").fill("Every finance lead we spoke to asked for it");
  // Qualify waits for a goal: it is not offered only to be refused.
  await expect(panel.getByRole("button", { name: "Qualify request" })).toBeDisabled();
  await expect(panel).not.toContainText("Link a confirmed goal first");

  // The way to a goal: Build the baseline.
  await needs.getByRole("link", { name: "Build the baseline" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1$/);

  // On to a first PRD, as a new owner would: PRDs > New PRD, a title and the problem, Continue to the brief.
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill(TITLE);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(WHY);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);

  // Draft with Oracle: a new company has no baseline, so Oracle builds it first.
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  const none = sheet.getByTestId("draft-baseline-none");
  await expect(none).toContainText("Build the baseline ($7.00)");
  await expect(none).toContainText("No baseline exists yet");
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  await expect(sheet).not.toContainText("Use the current baseline");

  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText(/^\$[\d,]+\.\d{2} estimated/);
  // An owner approves a cost over the threshold here (#259); under it the button just starts.
  await sheet.getByRole("button", { name: /^(Start drafting|Approve \$[\d,]+\.\d{2} and start)$/ }).click();

  // The run page: the first PRD's run is under way.
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
});

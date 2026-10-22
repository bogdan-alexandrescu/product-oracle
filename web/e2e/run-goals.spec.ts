import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/**
 * Issue #260: a PRD run names the goals it serves. Draft with Oracle carries the brief's
 * goals and lets the person change them before the run starts. Driven through the UI of the
 * mock build.
 *
 * Test card "goals in Draft with Oracle": protects=the brief's goals reach the run and the
 * sheet's pick replaces them on the same draft run; fails_when=the sheet does not list the
 * goals, does not preselect the brief's, or forgets the pick when reopened; no_claim=the
 * prompts the run's agents get (test_runs_target_goals.py).
 */

const PROBLEM = "Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.";

test("goals in Draft with Oracle: the brief's goals are picked, and a change sticks to the draft run", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/documents/new?kind=prd");
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses for teams");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("group", { name: "Which goals does it serve?" }).getByRole("checkbox", { name: /Raise activation/ }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);

  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const goals = sheet.getByRole("group", { name: "Goals this PRD serves" });
  await expect(goals.getByRole("checkbox")).toHaveCount(2);
  await expect(goals.getByRole("checkbox", { name: /Raise activation/ })).toBeChecked();
  await expect(goals.getByRole("checkbox", { name: /Grow paid conversion/ })).not.toBeChecked();

  await goals.getByRole("checkbox", { name: /Grow paid conversion/ }).check();
  await goals.getByRole("checkbox", { name: /Raise activation/ }).uncheck();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $19.50");
  await sheet.getByRole("button", { name: "Close Draft with Oracle" }).click();
  await expect(sheet).toHaveCount(0);

  // Reopened, the sheet takes up the draft run's goals, not the brief's.
  await page.reload();
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $19.50");
  await expect(goals.getByRole("checkbox", { name: /Raise activation/ })).not.toBeChecked();
  await expect(goals.getByRole("checkbox", { name: /Grow paid conversion/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-goals")).toHaveText("Serves Grow paid conversion");
});

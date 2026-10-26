import { expect, test } from "./test";

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
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $29.50");
  await sheet.getByRole("button", { name: "Close Draft with Oracle" }).click();
  await expect(sheet).toHaveCount(0);

  // Reopened, the sheet takes up the draft run's goals, not the brief's.
  await page.reload();
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $29.50");
  await expect(goals.getByRole("checkbox", { name: /Raise activation/ })).not.toBeChecked();
  await expect(goals.getByRole("checkbox", { name: /Grow paid conversion/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-goals")).toHaveText("Serves Grow paid conversion");
});

/**
 * #260 review fixes. Test cards:
 * - "brief goal rejected since": protects=a brief whose goal was rejected after it was
 *   written still estimates in Draft with Oracle, the sheet saying it leaves that goal out;
 *   fails_when=the first estimate is refused ("not a confirmed goal") or the sheet says
 *   nothing; no_claim=which goals the API keeps (test_runs_target_goals.py).
 * - "New run goals": protects=the New run dialog picks the goals a Baseline to PRD run
 *   serves, beside its PRD document field, and the run page names them; fails_when=the
 *   dialog has no goal picker, or the run serves no goal; no_claim=the prompts.
 */
test("brief goal rejected since: Draft with Oracle leaves it out, says so, and estimates", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "brief-goal-rejected"));
  await login(page, "approver@example.com");
  await page.goto("/intakes/c2600000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  const goals = sheet.getByRole("group", { name: "Goals this PRD serves" });
  await expect(goals.getByRole("checkbox", { name: /Raise activation/ })).toBeChecked();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText(/^Estimated \$[\d.]+$/);
  await expect(sheet.getByTestId("draft-goals-left-out")).toHaveText(
    "1 goal of this brief is no longer a confirmed goal: this PRD leaves it out.",
  );
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-goals")).toHaveText("Serves Raise activation");
});

test("New run goals: the dialog picks the goals a Baseline to PRD run serves", async ({ page }) => {
  // The "new-run-prd" scenario keeps Baseline to PRD in the New run dialog (#257).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "new-run-prd"));
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "New run" });
  const goals = dialog.getByRole("group", { name: "Goals this PRD serves" });
  await expect(goals.getByRole("checkbox")).toHaveCount(2);
  await expect(goals.getByRole("checkbox", { name: /Raise activation/ })).not.toBeChecked();
  await goals.getByRole("checkbox", { name: /Grow paid conversion/ }).check();
  await dialog.getByRole("combobox", { name: "PRD document" }).fill("gift-cards-for-teams");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: /^(Start run|Approve \$[\d.]+ and start)$/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("run-goals")).toHaveText("Serves Grow paid conversion");
});

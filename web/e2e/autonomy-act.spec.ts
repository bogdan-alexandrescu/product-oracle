import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/*
 * H11 at work, as a person sees it: an owner sets Decide reversible calls or Check outcomes in
 * Settings › Autonomy, and the decision log, the outcomes and the Inbox then show what Oracle did
 * (or did not do) at that level. The mock stands in for the API's rules
 * (api/tests/test_autonomy_wired.py proves them). Each test's card: protects=...; fails_when=...;
 * no_claim=...
 */

const APPROVER = "approver@example.com";
const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });
const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });

async function setLevel(page: Page, key: string, title: string, label: string) {
  await rail(page).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  await step(page, key, label).click();
  const sheet = page.getByRole("dialog", { name: `Change ${title}` });
  await sheet.getByLabel("Why").fill("Trying it for a month");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, key, label)).toHaveAttribute("aria-pressed", "true");
}

async function signOutAndIn(page: Page, email: string) {
  await signOut(page);
  await login(page, email);
}

// protects=at Act, once Ask Oracle for options recommends one, Oracle decides the reversible call,
// the approver gets an "Oracle did" row with Undo, and Undo hands the question back as a new
// proposal the approver decides on another option; fails_when=the mock leaves it proposed, shows a
// person as the decider, has no Inbox row, or Undo leaves the call decided or reversed;
// no_claim=the model's options (a fixed mock answer).
test("autonomy: at Act Oracle decides a reversible call and Undo hands it back", async ({ page }) => {
  await login(page);
  await setLevel(page, "decisions", "Decide reversible calls", "Act");
  await signOutAndIn(page, APPROVER);
  await page.goto("/company/decisions");
  await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Any state/ }).click();
  await page.getByTestId("decision-row").filter({ hasText: "Ship usage caps before anomaly detection" }).click();
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await inspector.getByRole("button", { name: "Ask Oracle for options" }).click();
  await expect(inspector.getByTestId("decision-chosen")).toContainText("Take the smallest reversible step");
  await expect(inspector.getByTestId("decision-chosen")).toContainText("Decided by Oracle within limits set by admin@example.com.");

  await rail(page).getByRole("link", { name: "Inbox" }).click();
  const did = page.getByRole("button", { name: /^Undo Decided D-\d+: Take the smallest reversible step$/ });
  await expect(did).toBeVisible();
  await did.click();
  // The question is the approver's again: a new proposal waits on them.
  await expect(page.getByText(/^Decision needs you · Ship usage caps before anomaly detection$/)).toBeVisible();
  await expect(did).toHaveCount(0);

  await page.goto("/company/decisions");
  await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Any state/ }).click();
  const calls = page.getByTestId("decision-row").filter({ hasText: "Ship usage caps before anomaly detection" });
  await expect(calls).toHaveCount(2);
  await calls.filter({ hasText: /Proposed|Needs/ }).first().click();
  await expect(inspector.getByRole("button", { name: "Decide" })).toBeVisible();
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Oracle recommends" })).toHaveCount(0);
  await inspector.getByRole("button", { name: "Decide" }).click();
  const form = inspector.getByRole("form", { name: "Decide" });
  await form.getByRole("radio", { name: "Ship together" }).check();
  await form.getByLabel("Why").fill("Wait for detection after all");
  await form.getByLabel("Expected outcome").fill("One launch, no noisy alerts");
  await form.getByRole("button", { name: "Record decision" }).click();
  await expect(inspector).toContainText("Wait for detection after all");
});

async function openOutcome(page: Page, title: string) {
  await page.goto("/plan");
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-outcomes").click();
  await expect(page.getByTestId("outcomes-table")).toBeVisible();
  await page.getByTestId("outcome-row").filter({ hasText: title }).click();
  return page.getByTestId("outcome-inspector").filter({ visible: true });
}

// protects=at Observe Oracle shows the predicted and actual results of a due outcome but proposes no
// verdict: no verdict chip and no Confirm, a person records one; fails_when=Partly held is still
// proposed; no_claim=how the actual is read (pytest).
test("autonomy: at Observe an outcome shows its actual with no verdict proposed", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await setLevel(page, "outcomes", "Check outcomes", "Observe");
  const inspector = await openOutcome(page, "Saved payment methods");
  await expect(inspector).toContainText("Predicted 38% → 42% · Now 41%");
  const reading = inspector.getByTestId("outcome-proposal");
  await expect(reading).toContainText("Goal value 41%");
  await expect(reading).not.toContainText("Partly held");
  await expect(inspector.getByTestId("outcome-confirm")).toHaveCount(0);
  await inspector.getByRole("button", { name: "Record verdict" }).click();
  await expect(inspector.getByTestId("assessment-form")).toBeVisible();
});

// protects=at Act Oracle records the verdict of a due outcome read from data and its owner gets an
// "Oracle did" row that opens it; fails_when=the outcome still waits on a person or nobody is told;
// no_claim=the ticker's timing (the mock records on the next read).
test("autonomy: at Act Oracle records an outcome's verdict and tells its owner", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
  await login(page);
  await setLevel(page, "outcomes", "Check outcomes", "Act");
  const inspector = await openOutcome(page, "Saved payment methods");
  await expect(inspector.getByTestId("outcome-state").first()).toHaveText("Partly held");
  await expect(inspector.getByTestId("outcome-history")).toContainText("Oracle");
  await rail(page).getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("link", { name: "Recorded partly held for Saved payment methods: the goal read 41%" })).toBeVisible();
});

// protects=at Act, a run's order that stays within one goal and the most places an owner allows is
// saved by Oracle with no stop: the run goes on to its PRD draft, the priority stop reads Skipped
// with Oracle's note, and the run's starter gets an "Oracle did" row with no Undo that opens the
// run; fails_when=the mock still stops the run at the priority order or nobody is told;
// no_claim=an order outside the limits (pytest test_autonomy_wired.py).
test("autonomy: at Act Oracle saves a run's order within the limits and tells its starter", async ({ page }) => {
  await login(page);
  await setLevel(page, "priorities", "Order priorities", "Act");
  await rail(page).getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" }).getByRole("button", { name: "Approve and continue" }).click();
  await page.getByRole("button", { name: "Refresh progress" }).click();

  // No stop: the order is saved and the PRD draft runs.
  await expect(page.getByTestId("segment-prd_draft").getByTestId("segment-state")).toHaveText("Running");
  await expect(page.getByTestId("checkpoint-priority_order")).toContainText("Skipped");
  const decisions = page.getByRole("complementary", { name: "Run" }).filter({ visible: true }).getByTestId("run-decision");
  await expect(decisions.filter({ hasText: "Priority order" })).toHaveText(
    "Priority order was skipped. Note: Oracle saved this order: Order priorities is set to Act within limits.",
  );
  await expect(page.getByRole("button", { name: "Refresh progress" })).toBeVisible();

  await rail(page).getByRole("link", { name: "Inbox" }).click();
  const did = page.getByRole("link", { name: /^Saved the priority order of .+, within one goal and your limit$/ });
  await expect(did).toBeVisible();
  await expect(page.getByRole("button", { name: /^Undo Saved the priority order/ })).toHaveCount(0);
  await did.click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(page.getByTestId("checkpoint-priority_order")).toContainText("Skipped");
});

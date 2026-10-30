import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY, MOCK_SLOW_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// v2 screen 5, Quality evaluation (picks.md 5: A's criteria table + inspector, C's "hide
// until you pick" in the rating form, B's report list as History). Team workspaces v2 in
// the mock; the "quality" scenario adds a stored rules snapshot, a model review (7 of 10
// criteria) and two people's ratings, all invented. MOCK_ROLE_KEY changes the signed-in
// member's role, not who they are: their own reports read "Admin".

type Role = "viewer" | "commenter" | "approver" | "owner";
const URL = "/documents/team-workspaces/v/2/quality";

async function open(page: Page, { role = "owner", scenario }: { role?: Role; scenario?: string } = {}) {
  await page.addInitScript(
    ([rk, r, sk, s]) => {
      localStorage.setItem(rk, r);
      if (s) localStorage.setItem(sk, s);
    },
    [MOCK_ROLE_KEY, role, MOCK_SCENARIO_KEY, scenario ?? ""] as const,
  );
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
}

const row = (page: Page, key: string) => page.locator(`[data-testid="criterion-row"][data-key="${key}"]`);
const inspector = (page: Page) => page.getByTestId("quality-inspector");
const history = (page: Page) => page.getByRole("region", { name: "History" });

test("owner: thirteen criteria with rules, model, people and agreement side by side", async ({ page }) => {
  await open(page, { scenario: "quality" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Quality\s*v2$/);
  await expect(page.getByTestId("policy-chip")).toHaveText("Advisory policy");
  await expect(page.getByTestId("blocked-chip")).toHaveText("Not blocked");
  await expect(page.getByTestId("model-chip")).toHaveText("Model reviewed 7 of 10");
  await expect(page.getByTestId("model-disclaimer")).toContainText("not independent ground truth");

  await expect(page.locator('[data-group="Advisory"]')).toContainText("10");
  await expect(page.locator('[data-group="Hard checks"]')).toContainText("3");

  const scope = row(page, "scope_testability");
  await expect(scope.getByTestId("rules-cell")).toHaveText("Critical");
  await expect(scope.getByTestId("model-cell")).toHaveText("Critical");
  await expect(scope.getByTestId("people-cell")).toContainText("1 critical");
  await expect(scope.getByTestId("people-cell")).toContainText("1 warning");
  await expect(scope.getByTestId("agreement-cell")).toHaveText(/^Model agrees\s*People 1\/2$/);
  await expect(row(page, "blocker_feasibility").getByTestId("agreement-cell")).toHaveText("Model disagrees");
  await expect(row(page, "alternatives_tradeoffs").getByTestId("model-cell")).toHaveText("Skipped");
  await expect(row(page, "security_policy").getByTestId("model-cell")).toHaveText("Rules only");

  await scope.click();
  const insp = inspector(page);
  await expect(insp).toContainText("Advisory criterion 6");
  await expect(insp).not.toContainText("scope_testability");
  await expect(insp.getByRole("heading", { name: "Scope, non-goals and testable requirements" })).toBeVisible();
  await expect(insp.getByTestId("stat-model-agrees")).toContainText("Yes");
  await expect(insp.getByTestId("stat-people-agree")).toContainText("1/2");
  const said = insp.getByTestId("evaluator");
  await expect(said).toHaveCount(4);
  await expect(said.nth(0)).toContainText("Rules");
  await expect(said.nth(1)).toContainText("Model");
  await expect(said.nth(1)).toContainText("Acceptance criteria describe intent");
  await expect(insp.getByTestId("evaluator").filter({ hasText: "Approver" })).toContainText("AC-4 cannot be tested.");
  await expect(insp.getByTestId("evaluator").filter({ hasText: "Commenter" })).toContainText("Warning");
  await expect(insp.getByTestId("rating-form")).toBeVisible();
});

test("filters: model disagrees, not rated by people, model skipped, hard checks", async ({ page }) => {
  await open(page, { scenario: "quality" });
  const filters = page.getByRole("group", { name: "Show criteria" });
  await filters.getByRole("button", { name: /Model disagrees/ }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(1);
  await expect(page.getByTestId("criterion-row")).toContainText("Blocker and feasibility resolution");
  await filters.getByRole("button", { name: /Model skipped/ }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(3);
  await filters.getByRole("button", { name: /Not rated by people/ }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(8);
  await filters.getByRole("button", { name: /Hard checks/ }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(3);
  await filters.getByRole("button", { name: /^All/ }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
});

test("partial: a check that could not run says so in the row and the inspector", async ({ page }) => {
  await open(page, { scenario: "quality" });
  const r = row(page, "downstream_consistency");
  await expect(r.getByTestId("rules-cell")).toHaveText("Check failed");
  await r.click();
  await expect(inspector(page)).toContainText("The check could not run: artifact dependency lookup timed out");
});

test("commenter rates a criterion: one human report, the row and History update", async ({ page }) => {
  await open(page, { role: "commenter", scenario: "quality" });
  await expect(page.getByRole("button", { name: "Save this check" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Oracle to review" })).toHaveCount(0);

  await row(page, "alternatives_tradeoffs").click();
  const form = inspector(page).getByTestId("rating-form");
  const submit = form.getByRole("button", { name: "Submit rating" });
  await expect(submit).toBeDisabled();
  await form.getByRole("button", { name: "Warning" }).click();
  await expect(submit).toBeDisabled();
  await form.getByLabel("Reason").fill("Only one approach is written down.");
  await form.getByLabel("Add a section").selectOption("problem");
  await expect(form.getByTestId("picked-section")).toHaveText(["1. Problem"]);
  await submit.click();

  await expect(page.getByTestId("rating-stored")).toContainText("Rating saved at");
  await expect(row(page, "alternatives_tradeoffs").getByTestId("people-cell")).toHaveText("1 warning");
  await expect(history(page).getByTestId("history-row").first()).toContainText("Human rating · Admin");
});

test("hide rules, model and other people until the rater picks a status", async ({ page }) => {
  await open(page, { role: "commenter", scenario: "quality" });
  await row(page, "scope_testability").click();
  const insp = inspector(page);
  await insp.getByLabel("Hide rules, model and other people until I pick").check();
  await expect(insp.getByTestId("evaluator")).toHaveCount(0);
  await expect(insp.getByTestId("hidden-until-pick")).toHaveText("Rules, model and other people's ratings are hidden until you pick a status.");
  await expect(row(page, "scope_testability").getByTestId("rules-cell")).toHaveText("Hidden");
  await expect(row(page, "scope_testability").getByTestId("model-cell")).toHaveText("Hidden");
  // Other criteria hide too: the option is for the whole form.
  await expect(row(page, "goal_alignment").getByTestId("rules-cell")).toHaveText("Hidden");

  await insp.getByTestId("rating-form").getByRole("button", { name: "Warning" }).click();
  await expect(insp.getByTestId("evaluator")).toHaveCount(4);
  await expect(row(page, "scope_testability").getByTestId("rules-cell")).toHaveText("Critical");
  await expect(row(page, "goal_alignment").getByTestId("rules-cell")).toHaveText("Hidden");

  // The choice is remembered on this browser.
  await page.reload();
  await expect(row(page, "goal_alignment").getByTestId("rules-cell")).toHaveText("Hidden");
});

test("hide until I pick: a criterion the rater has rated stays shown, after a reload too", async ({ page }) => {
  await open(page, { role: "commenter", scenario: "quality" });
  await row(page, "scope_testability").click();
  const insp = inspector(page);
  await insp.getByLabel("Hide rules, model and other people until I pick").check();
  const form = insp.getByTestId("rating-form");
  await form.getByRole("button", { name: "Warning" }).click();
  await form.getByLabel("Reason").fill("Two acceptance criteria cannot be tested.");
  await form.getByRole("button", { name: "Submit rating" }).click();

  // Mockup A: the stored message says how the people now agree with the rules.
  await expect(page.getByTestId("rating-stored")).toContainText(/Rating saved at .*; people agreement is now 1\/3\.$/);
  await expect(row(page, "scope_testability").getByTestId("rules-cell")).toHaveText("Critical");
  await expect(row(page, "scope_testability").getByTestId("people-cell")).toHaveText(/2 warning\s*1 critical/);
  await expect(insp.getByTestId("hidden-until-pick")).toHaveCount(0);
  await expect(insp.getByTestId("evaluator")).toHaveCount(5);
  await expect(row(page, "goal_alignment").getByTestId("rules-cell")).toHaveText("Hidden");

  await page.reload();
  await expect(row(page, "scope_testability").getByTestId("rules-cell")).toHaveText("Critical");
  await expect(row(page, "scope_testability").getByTestId("model-cell")).toHaveText("Critical");
  await expect(row(page, "goal_alignment").getByTestId("rules-cell")).toHaveText("Hidden");
});

test("hide until I pick: counts and filters do not give away what is hidden", async ({ page }) => {
  await open(page, { role: "commenter", scenario: "quality" });
  const panel = page.getByTestId("criteria-panel");
  const disagrees = page.getByRole("button", { name: /Model disagrees/ });
  await expect(panel).toContainText(/\d+ warning/);
  await expect(disagrees).not.toHaveText(/Model disagrees\s*0$/);

  await row(page, "scope_testability").click();
  await inspector(page).getByLabel("Hide rules, model and other people until I pick").check();
  // Only the hard checks, never hidden, are still counted: 3 of them.
  const counted = (await panel.getByTestId("criteria-tally").innerText()).match(/\d+/g)?.map(Number) ?? [];
  expect(counted.reduce((a, b) => a + b, 0)).toBe(3);
  await expect(disagrees).toHaveText(/Model disagrees\s*0$/);
  await disagrees.click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(0);
  await expect(panel).toContainText("No criteria match this filter");
});

test("viewer: reads everything, rates nothing, queues nothing", async ({ page }) => {
  await open(page, { role: "viewer", scenario: "quality" });
  await expect(page.getByTestId("view-only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save this check" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask Oracle to review" })).toHaveCount(0);
  await row(page, "scope_testability").click();
  await expect(inspector(page).getByTestId("evaluator")).toHaveCount(4);
  await expect(inspector(page).getByTestId("rating-form")).toHaveCount(0);
  await expect(inspector(page)).toContainText("Commenters and above can rate this criterion.");
});

test("hard checks are rules only: no rating form", async ({ page }) => {
  await open(page, { scenario: "quality" });
  await row(page, "third_party_support").click();
  await expect(inspector(page)).toContainText("Hard check");
  await expect(inspector(page)).toContainText("Rules only: people do not rate hard checks.");
  await expect(inspector(page).getByTestId("rating-form")).toHaveCount(0);
});

test("approver: no model review yet, queue one, the job runs and the model column fills", async ({ page }) => {
  await open(page, { role: "approver" });
  await expect(page.getByTestId("no-model-review")).toHaveText(/No model review for v2 yet\./);
  await expect(row(page, "problem_clarity").getByTestId("model-cell")).toHaveText("No model review");
  await row(page, "problem_clarity").click();
  await expect(inspector(page).getByTestId("stat-people-agree")).toContainText("Rate it below");
  await expect(inspector(page)).toContainText("No human ratings yet");

  await page.getByTestId("page-queue-review").click();
  await expect(page.getByTestId("job-done")).toContainText(/Oracle reviewed this at .*: 2 criteria judged/);
  await expect(row(page, "problem_clarity").getByTestId("model-cell")).toHaveText("Pass");
  await expect(page.getByTestId("model-chip")).toHaveText("Model reviewed 2 of 10");
  await expect(history(page).getByTestId("history-row").first()).toContainText("Oracle review");
  await expect(history(page).getByTestId("history-row").first()).toContainText("Succeeded");
});

test("a failed model job says why and retries, once, in History", async ({ page }) => {
  await open(page, { role: "approver", scenario: "quality-job-failed" });
  const failed = history(page).getByTestId("history-row").filter({ hasText: "Failed" });
  await expect(failed).toContainText("Every Claude account is paused.");
  await expect(failed).toContainText("Next reset");
  // #623 review: the job is drawn once, not as a notice and a History row.
  await expect(page.getByText(/Every Claude account is paused/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(1);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("job-done")).toContainText("Oracle reviewed this at");
  // Tokens and cost are for owners only (e2e/qa-docs-quality.spec.ts): an approver sees none.
  await expect(page.getByTestId("job-done")).not.toContainText(/\bin · \d+ out/);
  await expect(history(page).getByTestId("history-row").filter({ hasText: "Failed" })).toHaveCount(0);
});

test("a running model job shows once, in History, and is cancelled there", async ({ page }) => {
  await open(page, { role: "owner", scenario: "quality-job-running" });
  const jobRow = history(page).getByTestId("history-row").filter({ hasText: "Running" });
  await expect(jobRow).toHaveCount(1);
  await expect(page.getByText("Running", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(1);
  await expect(page.getByTestId("page-queue-review")).toBeDisabled();
  await jobRow.getByRole("button", { name: "Cancel" }).click();
  await expect(history(page).getByTestId("history-row").filter({ hasText: "Cancelled" })).toHaveCount(1);
  await expect(page.getByTestId("page-queue-review")).toBeEnabled();
});

test("commenter sees no Retry or Cancel on a model job", async ({ page }) => {
  await open(page, { role: "commenter", scenario: "quality-job-failed" });
  await expect(history(page).getByTestId("history-row").filter({ hasText: "Failed" })).toContainText("Every Claude account is paused.");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("409: the quality review switched off shows the API's words", async ({ page }) => {
  await open(page, { role: "owner", scenario: "quality-off" });
  await page.getByTestId("page-queue-review").click();
  await expect(page.getByTestId("action-error")).toContainText('"Quality review" is turned off for this document');
});

test("History: empty, then a stored rules snapshot", async ({ page }) => {
  await open(page, { role: "commenter" });
  await expect(history(page)).toContainText("No evaluation reports for v2 yet");
  await page.getByRole("button", { name: "Save this check" }).click();
  await expect(history(page).getByTestId("history-row")).toHaveCount(1);
  await expect(history(page).getByTestId("history-row")).toContainText("Saved check · Admin");
  await expect(page.getByTestId("latest-report")).toContainText("Last saved check");
});

test("History filters by evaluator", async ({ page }) => {
  await open(page, { scenario: "quality" });
  await expect(history(page).getByTestId("history-row")).toHaveCount(4);
  await history(page).getByRole("button", { name: /^Human/ }).click();
  await expect(history(page).getByTestId("history-row")).toHaveCount(2);
  await history(page).getByRole("button", { name: /^Oracle review/ }).click();
  await expect(history(page).getByTestId("history-row")).toHaveCount(1);
  // qa-docs-14: "Oracle review", never the model id or its cost.
  await expect(history(page).getByTestId("history-row")).toContainText("Oracle review");
  await expect(history(page).getByTestId("history-row")).not.toContainText(/claude-|\$/);
});

test("blocked: a critical hard check blocks the version", async ({ page }) => {
  await page.addInitScript(([k]) => localStorage.setItem(k, "owner"), [MOCK_ROLE_KEY] as const);
  await login(page);
  await page.goto("/documents/online-deposits/v/3/quality");
  await expect(page.getByTestId("blocked-chip")).toHaveText("Blocked");
  await expect(row(page, "third_party_support").getByTestId("rules-cell")).toHaveText("Critical");
});

test("error: the dashboard cannot be read, then Retry", async ({ page }) => {
  await page.addInitScript(([k]) => localStorage.setItem(k, "/v1/documents/team-workspaces/versions/2/readiness"), [MOCK_FAIL_KEY] as const);
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("quality-error")).toContainText("Mock failure");
  await page.evaluate((k) => localStorage.removeItem(k), MOCK_FAIL_KEY);
  await page.getByTestId("quality-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
});

test("loading: the criteria table draws placeholder rows first", async ({ page }) => {
  await page.addInitScript(([k]) => localStorage.setItem(k, "/v1/documents/team-workspaces/versions/2/readiness"), [MOCK_SLOW_KEY] as const);
  await login(page);
  await page.goto(URL);
  await expect(page.getByRole("grid", { name: "Criteria" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);
});

test("reached from the version page and from Publish", async ({ page }) => {
  // qa-docs-64: a commenter's toolbar is the owner's: Quality, and no extra "Check readiness".
  await page.addInitScript(([k]) => localStorage.setItem(k, "commenter"), [MOCK_ROLE_KEY] as const);
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  const quality = page.getByRole("link", { name: "Quality" });
  await expect(quality).toBeVisible();
  await expect(page.getByRole("link", { name: "Check readiness" })).toHaveCount(0);
  await quality.click();
  await expect(page).toHaveURL(/\/documents\/team-workspaces\/v\/2\/quality$/);
  await expect(page.getByTestId("criterion-row")).toHaveCount(13);

  await page.goto("/documents/team-workspaces/publish");
  await page.getByRole("link", { name: "Open quality" }).click();
  await expect(page).toHaveURL(/\/documents\/team-workspaces\/v\/2\/quality$/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no sideways scroll; a row opens the bottom sheet with the rating form", async ({ page }) => {
    await open(page, { role: "commenter", scenario: "quality" });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
    await expect(inspector(page)).toHaveCount(0);
    await row(page, "scope_testability").click();
    const sheet = page.getByTestId("sheet-criterion");
    await expect(sheet.getByRole("dialog", { name: "Scope, non-goals and testable requirements" })).toBeVisible();
    await expect(sheet.getByTestId("rating-form")).toBeVisible();
    await expect(sheet.getByTestId("evaluator")).toHaveCount(4);
  });
});

test("dark theme draws the same screen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, { scenario: "quality" });
  await expect(page.getByTestId("model-disclaimer")).toBeVisible();
  await row(page, "scope_testability").click();
  await expect(inspector(page)).toBeVisible();
});

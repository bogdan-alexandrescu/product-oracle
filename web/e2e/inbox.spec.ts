import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

test("inbox lists checkpoints, cost approvals, overruns and feedback by state", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  const checkpoints = page.getByTestId("inbox-checkpoints");
  await expect(checkpoints).toContainText("Confirm the baseline");
  await expect(checkpoints).toContainText("Baseline proposal");
  await expect(page.getByTestId("inbox-approvals")).toContainText("usage-alerts-v2");
  await expect(page.getByTestId("inbox-overruns")).toContainText("Spent $14.20 of $9.00 estimated");
  // One list by state (C1e): New is the default tab, everything new on a first visit.
  await expect(page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^New/ })).toHaveAttribute("aria-selected", "true");
  const feedback = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback");
  // Feedback is one row per item, with its document and what to do.
  const comment = feedback.locator("tr[data-row]").filter({ hasText: "Should the most recently used address be selected by default?" });
  await expect(comment).toContainText("Checkout redesign PRD");
  await expect(comment.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await expect(comment.getByRole("link", { name: /^Open Should the most recently used address/ })).toBeVisible();

  // Approve the cost from the inbox: the run starts and leaves the list.
  await page.getByTestId("inbox-approvals").getByRole("button", { name: "Approve $53.00" }).click();
  await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);

  // Resume the overrun.
  await page.getByTestId("inbox-overruns").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);

  // Row actions are outline, like every other row action; filled is for the page's primary.
  await expect(checkpoints.getByRole("link", { name: "Decide" }).first()).toHaveAttribute("data-variant", "secondary");
  // D14: a feedback row's primary action is outline too.
  await expect(feedback.getByRole("button", { name: "Accept", exact: true }).first()).toHaveAttribute("data-variant", "secondary");

  // Decide goes to the run, at the decision.
  await checkpoints.getByRole("link", { name: "Decide" }).first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+#decide$/);
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Waiting");
  await expect(page.locator("#decide")).toBeFocused();
});

test("inbox: cancel a run paused on overrun", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  await page.getByTestId("inbox-overruns").getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
  await page.goto("/runs");
  await expect(page.getByTestId("run-row").filter({ hasText: "team-workspaces" })).toContainText("Cancelled");
});

test("inbox: retry importing a run's output Oracle stopped trying to import", async ({ page }) => {
  await login(page);
  // A run whose resumed advance failed five times: its step failed, owners see it.
  await page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const run = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
    run.status = "running";
    run.checkpoints = [];
    run.segments[0].status = "failed";
    run.segments[0].error = "Couldn't import its output: DataError on 5 tries in a row.";
    run.import_failed =
      "Couldn't import team-onboarding's output: DataError on 5 tries in a row, and Oracle stopped trying.";
    run.can_retry_import = true;
    localStorage.setItem(key, JSON.stringify(db));
  });
  await page.goto("/inbox");
  const imports = page.getByTestId("inbox-imports");
  await expect(imports).toContainText("Couldn't import team-onboarding's output: DataError");
  await imports.getByRole("link").click();
  await expect(page.getByTestId("run-import-failed")).toContainText("DataError");
  // A second visit: the row is Open.
  await page.goto("/inbox");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  await page.getByTestId("inbox-imports").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("inbox-imports")).toHaveCount(0);
});

/** A company with two provider revokes a removed member's disable could not make. */
const withRevokeFailures = (page: Page) =>
  page.addInitScript((key) => localStorage.setItem(key, "revoke-failures"), MOCK_SCENARIO_KEY);

test("inbox: owners retry or dismiss a provider revoke a removed member's disable could not make", async ({
  page,
}) => {
  await withRevokeFailures(page);
  await login(page);
  await page.goto("/inbox");
  const failures = page.getByTestId("inbox-revoke-failures");
  const github = failures.getByRole("row").filter({ hasText: "GitHub" });
  const slack = failures.getByRole("row").filter({ hasText: "Slack" });
  await expect(github).toContainText("Couldn't revoke former.pm@example.com's GitHub access at GitHub");
  await expect(github).toContainText("stopped retrying");
  await expect(slack).toContainText("Oracle's Slack sign-in app is not configured");
  await expect(slack).toContainText("retrying until");

  // Retry runs now: GitHub revokes and leaves the list; Slack still cannot, and stays.
  await github.getByRole("button", { name: "Retry" }).click();
  await expect(github).toHaveCount(0);
  await slack.getByRole("button", { name: "Retry" }).click();
  await expect(slack).toContainText("tried 4 times");

  // Dismiss drops it.
  await slack.getByRole("button", { name: "Dismiss" }).click();
  await expect(failures).toHaveCount(0);
});

test("inbox: a decision not delivered yet shows under its own heading, uncounted, until the tick delivers it", async ({
  page,
}) => {
  // SwarmCloud takes no decision until the next tick: the decide call answers 503, recorded.
  await page.addInitScript((key) => localStorage.setItem(key, "undelivered"), MOCK_SCENARIO_KEY);
  await login(page);
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(badge).toHaveText("10");
  await page.goto("/runs");
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  await expect(page.getByTestId("segment-baseline").getByTestId("checkpoint-delivering")).toBeVisible();
  const run = page.url();

  await page.goto("/inbox");
  // The checkpoint is decided (one fewer to do); the delivery is not counted.
  await expect(badge).toHaveText("9");
  await expect(page.getByText("9 waiting").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("inbox-checkpoints")).toHaveCount(0);
  // Shown only, under Open, with a heading saying what it is.
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  const group = page.getByTestId("inbox-tab-open").getByTestId("inbox-deliveries");
  await expect(group.getByRole("heading", { name: "Decision not delivered yet" })).toBeVisible();
  const row = group.locator("tr[data-row]");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Confirm the baseline: approved by admin@example.com");
  await expect(row).toContainText("Last: SwarmCloud HTTP 503 unavailable");
  await expect(row).toContainText("team-onboarding");
  // Nothing to decide here: only Open, to the run.
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "Open" })).toHaveAttribute("href", new URL(run).pathname);

  // The tick delivers it; the row and its heading go.
  await page.goto(run);
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("segment-baseline").getByTestId("checkpoint-delivering")).toHaveCount(0);
  await page.goto("/inbox");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  await expect(page.getByTestId("inbox-tab-open")).toBeVisible();
  await expect(page.getByTestId("inbox-deliveries")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Decision not delivered yet" })).toHaveCount(0);
});

test("inbox: only owners see revokes a disable could not make", async ({ page }) => {
  await withRevokeFailures(page);
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "approver"] as const);
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-feedback")).toBeVisible();
  await expect(page.getByTestId("inbox-revoke-failures")).toHaveCount(0);
});

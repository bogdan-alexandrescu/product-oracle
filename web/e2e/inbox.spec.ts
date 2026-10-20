import { expect, test } from "@playwright/test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

test("inbox lists checkpoints, cost approvals, overruns and open feedback", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();

  const checkpoints = page.getByTestId("inbox-checkpoints");
  await expect(checkpoints).toContainText("Confirm the baseline");
  await expect(checkpoints).toContainText("Baseline proposal");
  await expect(page.getByTestId("inbox-approvals")).toContainText("usage-alerts-v2");
  await expect(page.getByTestId("inbox-overruns")).toContainText("Spent $14.20 of $9.00 estimated");
  const feedback = page.getByTestId("inbox-feedback");
  await expect(feedback).toContainText("Checkout redesign PRD");
  await expect(feedback).toContainText("open item");

  // Approve the cost from the inbox: the run starts and leaves the list.
  await page.getByTestId("inbox-approvals").getByRole("button", { name: "Approve $53.00" }).click();
  await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);

  // Resume the overrun.
  await page.getByTestId("inbox-overruns").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);

  // Review goes to the run.
  await checkpoints.getByRole("link", { name: "Review" }).first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Waiting");
});

test("inbox: cancel a run paused on overrun", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  await page.getByTestId("inbox-overruns").getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);
  await page.goto("/runs");
  await expect(page.getByTestId("run-row").filter({ hasText: "team-workspaces" })).toContainText("Cancelled");
});

test("inbox: owners retry or dismiss a provider revoke a removed member's disable could not make", async ({
  page,
}) => {
  await login(page);
  await page.goto("/inbox");
  const failures = page.getByTestId("inbox-revoke-failures");
  const github = failures.getByTestId("revoke-failure").filter({ hasText: "GitHub" });
  const slack = failures.getByTestId("revoke-failure").filter({ hasText: "Slack" });
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

test("inbox: only owners see revokes a disable could not make", async ({ page }) => {
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "approver"] as const);
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-feedback")).toBeVisible();
  await expect(page.getByTestId("inbox-revoke-failures")).toHaveCount(0);
});

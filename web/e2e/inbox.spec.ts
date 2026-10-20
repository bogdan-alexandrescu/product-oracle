import { expect, test } from "@playwright/test";

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
  await expect(feedback).toContainText("1 comment to resolve");

  // Approve the cost from the inbox: the run starts and leaves the list.
  await page.getByTestId("inbox-approvals").getByRole("button", { name: "Approve $53.00" }).click();
  await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);

  // Resume the overrun.
  await page.getByTestId("inbox-overruns").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("inbox-overruns")).toHaveCount(0);

  // Row actions are outline, like every other row action; filled is for the page's primary.
  await expect(checkpoints.getByRole("link", { name: "Decide" }).first()).toHaveAttribute("data-variant", "secondary");
  await expect(feedback.getByRole("link", { name: /^Review/ }).first()).toHaveAttribute("data-variant", "secondary");

  // Decide goes to the run, at the decision.
  await checkpoints.getByRole("link", { name: "Decide" }).first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+#decide$/);
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

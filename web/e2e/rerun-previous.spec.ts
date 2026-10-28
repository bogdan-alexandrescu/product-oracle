import { expect, test } from "./test";

import { login } from "./helpers";

// D5 Re-run keeps its output: a segment sent back runs again from its previous files, and
// the run page keeps a link to the previous attempt's files.

test("request changes on roadmap items: attempt 2 runs and the previous attempt's file stays readable", async ({ page }) => {
  await login(page);
  // Roadmaps are a tab of Plan now (as run-agents-progress.spec.ts reaches them).
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  // Attempt 1 writes roadmap_items.yaml; the run waits at its checkpoint.
  await page.getByRole("button", { name: "Check agents now" }).click();
  const items = page.getByTestId("segment-roadmap_items");
  // D1: the run page shows the waiting stop as its summary line (Review items), not a panel.
  await expect(items.getByRole("link", { name: "Waiting : Roadmap items" })).toBeVisible();
  await expect(items.getByTestId("items-review-line")).toBeVisible();
  await expect(items.getByRole("group", { name: /Previous attempt/ })).toHaveCount(0);

  // Request changes with a note: attempt 2 runs, and attempt 1's file is one click away.
  // D1: Roadmap items are decided on their review screen (Review items), where the request
  // for changes is Send back to agents with its note.
  const runUrl = page.url();
  await items.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  const bar = page.getByTestId("decision-bar");
  await bar.getByLabel("Note to the agents").fill("Link each item to a PRD section that exists");
  await bar.getByRole("button", { name: "Send back to agents" }).click();
  await page.getByTestId("sheet-send-back").getByRole("button", { name: "Send back", exact: true }).click();
  await expect(page.getByTestId("review-status")).toHaveText(/^Sent back/);
  await page.goto(runUrl);
  await expect(items).toContainText("attempt 2");
  await expect(items).toContainText("Running");
  const previous = items.getByRole("group", { name: "Previous attempt (attempt 1)" });
  await expect(previous).toContainText("Previous attempt");
  await previous.getByRole("button", { name: "Roadmap items", exact: true }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 1)");

  // Attempt 2 finishes: the current file is attempt 2's, the previous link still opens attempt 1's.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(items.getByTestId("items-review-line")).toBeVisible();
  const current = items.getByTestId("artifacts-current");
  await current.getByRole("button", { name: "Roadmap items", exact: true }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 2)");
  await previous.getByRole("button", { name: "Roadmap items", exact: true }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 1)");
  await expect(items.getByTestId("artifact-content")).not.toContainText("attempt 2");
});

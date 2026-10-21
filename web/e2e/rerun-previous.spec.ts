import { expect, test } from "@playwright/test";

import { login } from "./helpers";

// D5 Re-run keeps its output: a segment sent back runs again from its previous files, and
// the run page keeps a link to the previous attempt's files.

test("request changes on roadmap items: attempt 2 runs and the previous attempt's file stays readable", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page).toHaveURL(/\/roadmap$/);
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  // Attempt 1 writes roadmap_items.yaml; the run waits at its checkpoint.
  await page.getByRole("button", { name: "Check agents now" }).click();
  const items = page.getByTestId("segment-roadmap_items");
  const cp = items.getByTestId("checkpoint-roadmap_items");
  await expect(cp).toContainText("Roadmap items");
  await expect(items.getByRole("group", { name: /Previous attempt/ })).toHaveCount(0);

  // Request changes with a note: attempt 2 runs, and attempt 1's file is one click away.
  await cp.getByLabel("Note for the agents").fill("Link each item to a PRD section that exists");
  await cp.getByRole("button", { name: "Request changes" }).click();
  await expect(items).toContainText("attempt 2");
  await expect(items).toContainText("Running");
  const previous = items.getByRole("group", { name: "Previous attempt (attempt 1)" });
  await expect(previous).toContainText("Previous attempt");
  await previous.getByRole("button", { name: "roadmap_items.yaml" }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 1)");

  // Attempt 2 finishes: the current file is attempt 2's, the previous link still opens attempt 1's.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(items.getByTestId("checkpoint-roadmap_items")).toContainText("Roadmap items");
  const current = items.getByTestId("artifacts-current");
  await current.getByRole("button", { name: "roadmap_items.yaml" }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 2)");
  await previous.getByRole("button", { name: "roadmap_items.yaml" }).click();
  await expect(items.getByTestId("artifact-content")).toContainText("(local agent runtime, attempt 1)");
  await expect(items.getByTestId("artifact-content")).not.toContainText("attempt 2");
});

import { expect, test } from "./test";

import { login, openTab } from "./helpers";

/**
 * #556 item 2: Saved carts v2's reports failed on Oct 18 with a refusal stored before #403's
 * wording (the earliest reset as raw UTC). It reads the way #403 writes one now: the time in
 * the Company time zone in words, its sentences apart, and when it failed, so it does not
 * read as if every account is spent now; writing again stays offered (qa-docs-13: as the alert's Retry).
 */
test("a stored Claude-pool refusal on a PRD's Reports row reads like the time it happened", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await openTab(page, "History");
  const reports = page.getByTestId("history-reports").filter({ visible: true }).getByTestId("reports-panel");

  await expect(reports.getByTestId("job-failed")).toHaveText("Failed Oct 18, 4:12 PM PDT");
  // qa-docs-4: the Reports row says it in plain words, with a Retry; no Claude-account wording.
  const refusal = reports.getByRole("alert");
  await expect(refusal).toContainText("The reports could not be written. Try again.");
  await expect(refusal).not.toContainText("Claude account");
  await expect(refusal.getByRole("button", { name: "Retry" })).toBeVisible();

  // Oracle's work says it plainly too; the account detail is under the job's Details.
  const work = page.getByTestId("jobs-panel").filter({ visible: true }).getByTestId("llm-job").filter({ hasText: "Reports" });
  await expect(work.getByTestId("job-failed-plain")).toBeVisible();
  await expect(work.getByTestId("job-error")).toBeHidden();
  await work.getByText("Details", { exact: true }).click();
  await expect(work.getByTestId("job-error")).toContainText("could take this call: every Claude account was spent; the earliest window was due to clear Sun Oct 25, 3:00 PM PDT.");
  await expect(work.getByTestId("job-error")).not.toContainText("2026-10-25T");

  // qa-docs-13: one way to write again after a failure, the alert's Retry.
  await expect(reports.getByRole("button", { name: "Write reports" })).toHaveCount(0);
  await refusal.getByRole("button", { name: "Retry" }).click();
  await expect(refusal).toHaveCount(0);
  await expect(reports.getByTestId("job-failed")).toHaveCount(0);
});

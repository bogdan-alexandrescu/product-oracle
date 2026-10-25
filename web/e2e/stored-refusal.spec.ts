import { expect, test } from "./test";

import { login, openTab } from "./helpers";

/**
 * #556 item 2: Saved carts v2's reports failed on Oct 18 with a refusal stored before #403's
 * wording (the earliest reset as raw UTC). It reads the way #403 writes one now: the time in
 * the Company time zone in words, its sentences apart, and when it failed, so it does not
 * read as if every account is spent now; Write reports stays offered.
 */
test("a stored Claude-pool refusal on a PRD's Reports row reads like the time it happened", async ({ page }) => {
  await login(page);
  await page.goto("/documents/saved-carts/v/2");
  await openTab(page, "History");
  const reports = page.getByTestId("history-reports").filter({ visible: true }).getByTestId("reports-panel");

  await expect(reports.getByTestId("job-failed")).toHaveText("Failed Oct 18, 4:12 PM PDT");
  const refusal = reports.getByRole("alert");
  await expect(refusal).toHaveText(
    "No Claude account can take this call: every Claude account is spent; the earliest window clears Sun Oct 25, 3:00 PM PDT. " +
      "Every Claude account was out of quota when this ran.",
  );
  await expect(refusal).not.toContainText("2026-10-25T");

  // Oracle's work shows the same job the same way.
  const work = page.getByTestId("jobs-panel").filter({ visible: true }).getByTestId("llm-job").filter({ hasText: "Reports" });
  await expect(work.getByTestId("job-error")).toContainText("clears Sun Oct 25, 3:00 PM PDT.");
  await expect(work.getByTestId("job-error")).not.toContainText("2026-10-25T");

  await reports.getByRole("button", { name: "Write reports" }).click();
  await expect(refusal).toHaveCount(0);
  await expect(reports.getByTestId("job-failed")).toHaveCount(0);
});

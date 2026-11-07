import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * Fidelity, "Separate Approve step": every line of a run's PRD review names ONE version, the one
 * under review. The title line reads "In review · Version 2 · <its day>" while the bar asks for
 * the review of version 2; after Approve review and Approve the PRD it reads "Approved · Version 2"
 * and "You approved the PRD, version 2.", and still does after the page is opened again.
 * Driven through the UI on the mock's "run-review" scenario (a run waiting at its PRD review of
 * Usage alerts' version 2, version 1 published), from One-pagers.
 *
 * fails_when = the title line shows the last published version (Version 1) during the review or
 * after approving it.
 */

test("a run's PRD review names the version under review on every line", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"] as const);
  await login(page);
  await page.goto("/simple/one-pagers");
  await page.getByRole("link", { name: "Usage alerts PRD" }).first().click();

  const meta = page.getByTestId("one-pager-meta");
  const step = page.getByRole("region", { name: "The run's PRD review" });
  await expect(step).toContainText("waits for your review of version 2.");
  await expect(meta).toContainText("In review");
  await expect(meta).toContainText(/Version 2 · [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(meta).not.toContainText("Version 1");

  await step.getByRole("button", { name: "Approve", exact: true }).click();
  const box = step.getByRole("dialog", { name: "Approve the review" });
  await box.getByRole("textbox", { name: "Note for the run (optional)" }).fill("Good to build from.");
  await box.getByRole("button", { name: "Approve review" }).click();
  await expect(step.getByRole("heading", { name: "Next stop: approve the PRD" })).toBeVisible();
  await expect(meta).toContainText("Version 2");
  await expect(meta).not.toContainText("Version 1");

  await step.getByRole("button", { name: "Approve the PRD" }).click();
  await expect(step).toContainText("You approved the PRD, version 2.");
  await expect(meta).toContainText("Approved");
  await expect(meta).toContainText("Version 2");
  await expect(meta).not.toContainText("Version 1");

  // Opened again, the approved version is the one the title line names.
  await page.reload();
  await expect(meta).toContainText("Approved");
  await expect(meta).toContainText(/Version 2 · [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(meta).not.toContainText("Version 1");
});

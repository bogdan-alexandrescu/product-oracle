import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test } from "./test";

/**
 * Stale-page review: a PRD's one-pager built before a newer version was approved is built again
 * from that version (./lib/api/mock/server.ts onePagerOf), and its working draft and notes stay,
 * as the API's drafts and changes are rows of their own. Driven through the UI on the mock's
 * "run-review" scenario (a run waiting at its PRD review of Usage alerts' version 2, version 1
 * published): an owner edits a line on version 1's page, approves version 2, and reloads.
 *
 * fails_when = the rebuild drops the page's working draft, so the line reads as published and
 * its note and the "Working draft" status are gone; no_claim = a submitted draft's approval.
 */

const EDIT = "An example alert digest sent once a day";

test("a working draft's note stays when the page is built again from a newer version", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"] as const);
  await login(page);
  await page.goto("/simple/one-pagers");
  await page.getByRole("link", { name: "Usage alerts PRD" }).first().click();
  const meta = page.getByTestId("one-pager-meta");
  await expect(meta).toContainText("In review");

  // The measure line, found by its Edit button, then by its line id (its words change).
  const edit = page.getByRole("button", { name: /^Edit “Fewer support tickets/ });
  const id = await page.locator("[data-line]").filter({ has: edit }).getAttribute("data-line");
  const line = page.locator(`[data-line="${id}"]`);
  await line.hover();
  await edit.click();
  await page.getByLabel("New wording for").fill(EDIT);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(line).toHaveAttribute("data-state", "edited");
  await expect(line).toContainText(EDIT);
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");

  // Version 2 is approved: the page is now older than the PRD's newest approved version.
  const step = page.getByRole("region", { name: "The run's PRD review" });
  await step.getByRole("button", { name: "Approve", exact: true }).click();
  const box = step.getByRole("dialog", { name: "Approve the review" });
  await box.getByRole("button", { name: "Approve review" }).click();
  await step.getByRole("button", { name: "Approve the PRD" }).click();
  await expect(step).toContainText("You approved the PRD, version 2.");

  await page.reload();
  await expect(meta).toContainText("Approved");
  await expect(meta).toContainText("Version 2");
  await expect(line).toHaveAttribute("data-state", "edited");
  await expect(line).toContainText(EDIT);
  await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");
});

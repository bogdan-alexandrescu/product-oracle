import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";
import { expect, test } from "./test";

/**
 * Stale-page review: a PRD's one-pager built before a newer version was approved is built again
 * from that version (./lib/api/mock/server.ts onePagerOf), and its working draft and notes stay,
 * as the API's drafts and changes are rows of their own. Driven through the UI on the mock's
 * "run-review" scenario (a run waiting at its PRD review of Usage alerts' version 2, version 1
 * published): an owner edits a line on version 1's page, approves version 2, and reloads.
 *
 * fails_when = the rebuild drops the page's working draft, so the line reads as published and
 * its note and the "Working draft" status are gone; or a draft sent for approval is not its own
 * version after the run's (drafts._submit_sections), so the run's version 2 is approved and the
 * draft dropped (drafts.on_version_approved settles only the draft submitted as that version); or
 * the approval of a version newer than the one the draft was sent as settles it, so the rebuilt
 * page drops the draft, its reviewers and its note (the mock's rule back to "any submitted draft").
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

test("a draft sent for approval stays in review: the run's older version can't be approved, a newer one leaves it waiting", async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "run-review"] as const);
  await login(page);
  await page.goto("/simple/one-pagers");
  await page.getByRole("link", { name: "Usage alerts PRD" }).first().click();
  const meta = page.getByTestId("one-pager-meta");
  await expect(meta).toContainText("In review");

  const edit = page.getByRole("button", { name: /^Edit “Fewer support tickets/ });
  const id = await page.locator("[data-line]").filter({ has: edit }).getAttribute("data-line");
  const line = page.locator(`[data-line="${id}"]`);
  await line.hover();
  await edit.click();
  await page.getByLabel("New wording for").fill(EDIT);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(line).toContainText(EDIT);

  // Sent for approval: the draft becomes a version of its own, after the run's version 2.
  const bar = page.getByRole("status", { name: "Working draft" });
  await bar.getByRole("button", { name: "Send for approval…" }).click();
  await page.getByTestId("send-for-approval").getByRole("button", { name: "Send for approval" }).click();
  const waits = bar.getByTestId("draft-waits-on");
  await expect(waits).toContainText("Sent for approval · waiting on");
  const reviewers = (await waits.textContent()) ?? "";

  // Approving the run's version 2 (not the version the draft was sent as) is refused, as the
  // API's publish gate refuses any PRD version but the latest: the draft's version 3.
  const step = page.getByRole("region", { name: "The run's PRD review" });
  await step.getByRole("button", { name: "Approve", exact: true }).click();
  const box = step.getByRole("dialog", { name: "Approve the review" });
  await box.getByRole("button", { name: "Approve review" }).click();
  await step.getByRole("button", { name: "Approve the PRD" }).click();
  await expect(step).toContainText("v3 exists: only the latest version can be published");
  await expect(step).not.toContainText("You approved the PRD");

  // Still in review: version 1 stays published, the draft waits on the same reviewers.
  await page.reload();
  await expect(meta).toContainText("draft in progress");
  await expect(meta).toContainText("Version 1");
  await expect(waits).toHaveText(reviewers);
  await expect(line).toHaveAttribute("data-state", "edited");
  await expect(line).toContainText(EDIT);
  await expect(bar).toContainText("1 change");

  // A version newer than the draft's own (4, from a rewrite of version 3) is published: the page is
  // built again from it, and the draft still waits in review with its note, as only the approval of
  // the version it was sent as (3) settles it.
  await page.goto("/documents/usage-alerts/v/3");
  const behaviour = await openSection(page, "behaviour");
  await behaviour.getByRole("button", { name: /^Actions for .*Behaviour$/ }).click();
  await behaviour.getByRole("menuitem", { name: /^Ask Oracle to rewrite/ }).click();
  const refine = behaviour.getByTestId("refine-panel");
  await refine.getByLabel("Instruction").fill("Say who gets the alerts first.");
  await refine.getByRole("button", { name: "Refine", exact: true }).click();
  await refine.getByRole("button", { name: "Accept as next version" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts\/v\/4/);
  await page.goto("/documents/usage-alerts/publish");
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v4?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publish-button")).toHaveCount(0);

  await page.goto("/simple/one-pagers");
  await page.getByRole("link", { name: "Usage alerts PRD" }).first().click();
  await expect(meta).toContainText("Version 4");
  await expect(waits).toHaveText(reviewers);
  await expect(line).toHaveAttribute("data-state", "edited");
  await expect(line).toContainText(EDIT);
  await expect(bar).toContainText("1 change");
});

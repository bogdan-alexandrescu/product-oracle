import { expect, test } from "./test";

import { login, openSeeded, seedConsoleHeld } from "./helpers";
import { CONSOLE_HELD_RUN_ID } from "../lib/api/mock/runs";

// D11 Checkpoint decisions over MCP: the run page's inspector lists each decision of the
// run in the words the run's agents read through get_checkpoint_review.

test("approvals with their notes are listed in the run's Decisions, as the agents read them", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();

  const inspector = page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
  const section = inspector.getByTestId("run-decisions");
  await expect(section).toContainText("Decisions");
  await expect(section).toContainText("No decisions yet");

  // Approve the baseline with a note: listed at once.
  const baseline = page.getByTestId("checkpoint-baseline_confirm");
  await baseline.getByLabel("Note for the agents").fill("Name an owner for every goal");
  await baseline.getByRole("button", { name: "Approve and continue" }).click();
  const items = section.getByTestId("run-decision");
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toHaveText("The baseline was approved by Avery Stone. Note: Name an owner for every goal.");

  // The feature set, approved with the note the later segments must respect.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  const featureSet = page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" });
  await featureSet.getByLabel("Note for the agents").fill("Keep bulk import out of v1");
  await featureSet.getByRole("button", { name: "Approve and continue" }).click();
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveText("Feature set and dependencies was approved by Avery Stone. Note: Keep bulk import out of v1.");
  await expect(section).not.toContainText("No decisions yet");
  // The page names who decided (the agents' list names them too, beside the role); never an email.
  await expect(section).not.toContainText("@");
});

// decider-names-api review: protects = a console approval an approver confirms is listed as its
// author's, by the name the API gives, not the confirmer's; fails_when = the page names whoever
// confirmed it (the checkpoint's decided_by).
test("a confirmed console approval names who answered in the console, not who confirmed it", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  const decide = page.getByRole("group", { name: "Decide: Roadmap items" });
  const reason = decide.getByTestId("gate-reason").filter({ hasText: "Usage export" });
  await reason.getByRole("button", { name: "Waive…" }).click();
  await reason.getByRole("textbox").fill("Section lands in the next PRD version");
  await reason.getByRole("button", { name: "Waive", exact: true }).click();
  await decide.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Approved");

  const section = page.getByRole("complementary", { name: "Run" }).filter({ visible: true }).getByTestId("run-decisions");
  await expect(section.getByTestId("run-decision")).toHaveText(["Roadmap items was approved by Priya Raman in SwarmCloud's console."]);
});

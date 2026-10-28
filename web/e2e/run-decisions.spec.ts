import { expect, test } from "./test";

import { login } from "./helpers";

// D11 Checkpoint decisions over MCP: the run page's inspector lists each decision of the
// run in the words the run's agents read through get_checkpoint_review.

test("approvals with their notes are listed in the run's Decisions, as the agents read them", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.getByTestId("run-row").filter({ hasText: "team onboarding" }).getByRole("link").click();
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
  await expect(items.nth(0)).toHaveText("Baseline · approved by an owner · note: Name an owner for every goal");

  // The feature set, approved with the note the later segments must respect.
  await page.getByRole("button", { name: "Check agents now" }).click();
  const featureSet = page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" });
  await featureSet.getByLabel("Note for the agents").fill("Keep bulk import out of v1");
  await featureSet.getByRole("button", { name: "Approve and continue" }).click();
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveText("Feature set · approved by an owner · note: Keep bulk import out of v1");
  await expect(section).not.toContainText("No decisions yet");
  // No member's name: the role only, as the agents see it.
  await expect(section).not.toContainText("@");
});

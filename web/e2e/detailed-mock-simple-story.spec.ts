import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * detailed-mock (QA Nov 14 follow-ups): Detailed Priorities tells Simple's story, the same
 * features by the same codes as Simple's plan (Setup checklist F-01, Referral link F-12, ...).
 * Invented data.
 */
const SIMPLE_FEATURES: [string, string][] = [
  ["F-01", "Setup checklist"],
  ["F-02", "Sample data import"],
  ["F-05", "Team invites"],
  ["F-06", "Setup error report"],
  ["F-07", "Bulk import"],
  ["F-08", "Usage dashboard"],
  ["F-12", "Referral link"],
  ["F-13", "Public signup"],
];

test("detailed priorities: every feature is Simple's, by Simple's code and name", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await expect(page.getByRole("heading", { level: 1, name: "Priorities" })).toBeVisible();
  const rows = page.locator('tr[data-testid^="priority-row-"]');
  await expect(rows).toHaveCount(SIMPLE_FEATURES.length);
  for (const [code, name] of SIMPLE_FEATURES) {
    await expect(page.getByTestId(`priority-row-${code}`).getByTestId("feature-name")).toContainText(name);
  }
  await expect(page.getByText("Saved addresses at checkout")).toHaveCount(0);
});

/**
 * detailed-story: Detailed's Ground Truth tells the same story, its features by Simple's codes and names and its goals
 * by Simple's plan goals (Activation, Growth); none of the older story's names is left. Invented data.
 */
const GROUND_TRUTH_FEATURES: [string, string][] = [
  ["F-01", "Setup checklist"],
  ["F-02", "Sample data import"],
  ["F-05", "Team invites"],
  ["F-06", "Setup error report"],
  ["F-12", "Referral link"],
];

test("detailed ground truth: every coded feature is Simple's and the goals are Simple's plan goals", async ({ page }) => {
  await login(page);
  await page.goto("/ground-truth");
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
  for (const [code, name] of GROUND_TRUTH_FEATURES) {
    await expect(page.getByTestId(`feature-${code}`).getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByTestId("goal-g.activation")).toContainText("Activation");
  await expect(page.getByTestId("goal-g.paid-conversion")).toContainText("Growth");
  for (const old of ["Raise activation", "Grow paid conversion", "Guided setup", "Saved carts", "Dark mode"]) {
    await expect(page.getByText(old)).toHaveCount(0);
  }
});

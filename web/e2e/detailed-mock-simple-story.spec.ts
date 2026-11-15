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

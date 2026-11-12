import { GOAL_BUCKETS_SHORT_CLASH_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-features-own-key: on Priorities > Goal buckets ("goal-buckets-short-clash": invented roadmap items
 * Quiet mode schedule, short code QMS from its initials, and Weekly alert email, whose feature key is qms,
 * both on the invented goal Grow retention), Archive goal and Delete goal list each feature once, by its own
 * code: a short code made from initials never folds one feature into another. Desktop 1440x900.
 *
 * Card goal-features-own-key: protects = both features are listed, and counted, in the goal's Archive
 * and Delete dialogs; fails_when = Quiet mode schedule is folded into Weekly alert email (its short
 * code matches that feature's key) and left out of the list and the count.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const goal = (page: Page, title: string) => page.locator(`[data-testid="plan-goal"][data-goal="${title}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function dialogFor(page: Page, item: "Delete goal" | "Archive goal", name: string) {
  await tap(goal(page, "Grow retention").getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: item }));
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function listsBoth(dialog: Locator) {
  const listed = dialog.getByTestId("goal-feature");
  await expect(listed.filter({ hasText: "Quiet mode schedule" })).toHaveCount(1);
  await expect(listed.filter({ hasText: "Weekly alert email" })).toHaveCount(1);
  await expect(dialog).toContainText(`It holds ${await listed.count()} features`);
}

test("Archive goal and Delete goal list two features whose short codes clash as two", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_SHORT_CLASH_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(goal(page, "Grow retention")).toContainText("Monthly alert recap");

  const archive = await dialogFor(page, "Archive goal", "Archive Grow retention");
  await listsBoth(archive);
  await tap(archive.getByRole("button", { name: "Cancel" }));
  await expect(archive).toHaveCount(0);

  const del = await dialogFor(page, "Delete goal", "Delete Grow retention");
  await listsBoth(del);
});

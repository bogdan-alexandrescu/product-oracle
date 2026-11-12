import { GOAL_BUCKETS_LINKED_DRAFT_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-features-linked-draft: on Priorities > Goal buckets ("goal-buckets-linked-draft": invented roadmap items
 * Quiet mode schedule and Weekly alert email on the invented goal Grow retention, a draft linked to Quiet mode
 * schedule's feature, and a draft only named Weekly alert email, both on the goal too), Archive goal and Delete goal
 * list the linked draft once with its feature, and the same-name draft as a feature of its own. Desktop 1440x900.
 *
 * Card goal-features-linked-draft: protects = a linked draft, shown on its feature's row, counts once with that
 * feature in the goal's Archive and Delete dialogs; fails_when = Quiet mode schedule is listed twice (its feature
 * and its linked draft) and counted twice, or the same-name Weekly alert email draft is folded into its row.
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

async function listsLinkedOnce(dialog: Locator) {
  const listed = dialog.getByTestId("goal-feature");
  await expect(listed.filter({ hasText: "Quiet mode schedule" })).toHaveCount(1);
  await expect(listed.filter({ hasText: "Weekly alert email" })).toHaveCount(2);
  await expect(dialog).toContainText(`It holds ${await listed.count()} features`);
}

test("Archive goal and Delete goal list a linked draft once with its feature", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_LINKED_DRAFT_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(goal(page, "Grow retention")).toContainText("Monthly alert recap");

  const archive = await dialogFor(page, "Archive goal", "Archive Grow retention");
  await listsLinkedOnce(archive);
  await tap(archive.getByRole("button", { name: "Cancel" }));
  await expect(archive).toHaveCount(0);

  const del = await dialogFor(page, "Delete goal", "Delete Grow retention");
  await listsLinkedOnce(del);
});

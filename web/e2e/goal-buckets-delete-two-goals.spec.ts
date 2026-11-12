import { GOAL_BUCKETS_DATED_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-delete-two-goals: on Priorities > Goal buckets with a dated plan ("goal-buckets-dated": invented
 * goals Grow retention and Faster activation; the invented draft Monthly alert recap serves Grow
 * retention, the draft Alert summary for leads serves Faster activation first and Grow retention too).
 * Desktop 1440x900.
 *
 * Card goal-archive-two-goals: protects = Archive goal lists a draft that serves the goal second,
 * under "serves another goal too" (it keeps Faster activation), and with "Leave them with no goal"
 * the draft that served only that goal reads No goal; Undo puts it back on the goal; fails_when = the two-goal
 * draft is left out of the list, or the archived goal stays on the draft.
 * Card goal-archive-one-read: protects = a goal's Archive reads Priorities once; fails_when = it
 * reads it twice.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const goal = (page: Page, title: string) => page.locator(`[data-testid="plan-goal"][data-goal="${title}"]`);
const calls = (page: Page) => page.evaluate(() => [...((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? [])]);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openPage(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_DATED_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(goal(page, "Grow retention")).toContainText("Monthly alert recap");
}

async function archiveDialog(page: Page) {
  await tap(goal(page, "Grow retention").getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: "Archive goal" }));
  const dialog = page.getByRole("dialog", { name: "Archive Grow retention" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function archiveWithNoGoal(page: Page) {
  const dialog = await archiveDialog(page);
  await tap(dialog.getByRole("radio", { name: "Leave them with no goal (they show under No goal)" }));
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);
}

const draftGoal = (page: Page, title: string) => page.getByTestId("prio-draft").filter({ hasText: title });

test("Archive goal lists a draft that serves the goal second, and leaving them with no goal takes the goal off the drafts", async ({ page }) => {
  await openPage(page);
  const dialog = await archiveDialog(page);
  await expect(dialog.getByTestId("goal-feature").filter({ hasText: "Alert summary for leads" })).toHaveCount(1);
  await expect(dialog).toContainText("Alert summary for leads → Faster activation");
  await tap(dialog.getByRole("button", { name: "Cancel" }));

  // One priorities read for the write; Undo puts the draft back on the goal.
  await page.evaluate(() => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls!.length = 0));
  await archiveWithNoGoal(page);
  const reads = async () => (await calls(page)).filter((c) => c.startsWith("GET /v1/simple/priorities")).length;
  await expect.poll(reads).toBe(1);
  await page.waitForTimeout(500);
  expect(await reads()).toBe(1);
  await tap(page.getByRole("button", { name: "Undo" }));
  await expect(goal(page, "Grow retention")).toContainText("Monthly alert recap");

  // Archived again with no goal: the drafts read their goals as they are now.
  await archiveWithNoGoal(page);
  await tap(page.locator("#prio-tab-ranked"));
  await expect(draftGoal(page, "Monthly alert recap")).toContainText("No goal");
  await expect(draftGoal(page, "Alert summary for leads")).toContainText("Faster activation");
  await expect(page.getByTestId("prio-draft").filter({ hasText: "Grow retention" })).toHaveCount(0);
});

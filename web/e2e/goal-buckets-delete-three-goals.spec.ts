import { GOAL_BUCKETS_THREE_GOALS_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-delete-r3: on Priorities with "goal-buckets-three-goals" (invented: the draft Team alert digest
 * serves the archived Cut support tickets in half first, then Grow retention and Faster activation; the
 * draft Snooze for a day serves Grow retention, then the archived goal). Desktop 1440x900.
 *
 * Card goal-restore-three-goals: protects = Delete Grow retention with a goal picked, then Restore it from
 * Settings › Trash, and the digest reads Grow retention again (its goals back in their order: the
 * archived one, Grow retention, Faster activation); fails_when = Restore leaves Faster activation first.
 * Card goal-archived-reads-no-goal: protects = Archive Grow retention with "Leave them with no goal", and
 * Snooze for a day (left with only the archived goal) reads No goal, as the dialog counted it;
 * fails_when = it reads the archived goal.
 * Card goal-archive-key-result: protects = Archive lists Alert tone picker, whose other goal is a key result of
 * Faster activation, as kept on Faster activation (the API keeps it on the key result); fails_when = it is shown as moving.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const goal = (page: Page, title: string) => page.locator(`[data-testid="plan-goal"][data-goal="${title}"]`);
const draft = (page: Page, title: string) => page.getByTestId("prio-draft").filter({ hasText: title });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openPage(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_THREE_GOALS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(goal(page, "Grow retention")).toBeVisible();
}

async function goalDialog(page: Page, verb: "Archive" | "Delete") {
  await tap(goal(page, "Grow retention").getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: `${verb} goal` }));
  const dialog = page.getByRole("dialog", { name: `${verb} Grow retention` });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function ranked(page: Page) {
  await page.goto("/simple/priorities");
  await tap(page.locator("#prio-tab-ranked"));
}

test("Restore of a deleted goal gives an item its three goals back in their order", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Delete");
  const pick = dialog.getByLabel("Goal", { exact: true });
  const label = (await pick.locator("option").allTextContents()).find((o) => o.endsWith("Growth"))!;
  await pick.selectOption({ label });
  await tap(dialog.getByRole("button", { name: "Delete goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  await ranked(page);
  await expect(draft(page, "Team alert digest")).toContainText("Faster activation");

  await page.goto("/settings/trash");
  await tap(page.getByRole("button", { name: "Restore Grow retention" }));
  await expect(page.getByTestId("trash-entry").filter({ hasText: "Grow retention" })).toHaveCount(0);

  await ranked(page);
  await expect(draft(page, "Team alert digest")).toContainText("Grow retention");
  await expect(draft(page, "Team alert digest")).not.toContainText("Faster activation");
});

test("An item left with only an archived goal reads No goal", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await tap(dialog.getByRole("radio", { name: "Leave them with no goal (they show under No goal)" }));
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  await ranked(page);
  await expect(draft(page, "Snooze for a day")).toContainText("No goal");
  await expect(draft(page, "Snooze for a day")).not.toContainText("Cut support tickets in half");
});

test("Archive goal lists an item whose other goal is a key result as kept on that goal", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await expect(dialog).toContainText("Alert tone picker → Faster activation");
});

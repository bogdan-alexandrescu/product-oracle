import { GOAL_BUCKETS_THREE_GOALS_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-delete-r3: on Priorities with "goal-buckets-three-goals" (invented: the draft Team alert digest
 * serves the archived Cut support tickets in half first, then Grow retention and Faster activation; the
 * draft Snooze for a day serves Grow retention, then the archived goal; the draft Alert tone picker serves
 * Grow retention, then a key result of Faster activation). Desktop 1440x900.
 *
 * Card goal-restore-three-goals: protects = Delete Grow retention with a goal picked, then Restore it from
 * Settings › Trash, and the digest reads Grow retention again (its goals back in their order: the
 * archived one, Grow retention, Faster activation); fails_when = Restore leaves Faster activation first.
 * Card goal-archived-reads-no-goal: protects = Archive Grow retention with "Leave them with no goal", and
 * Snooze for a day (left with only the archived goal) reads No goal, as the dialog counted it;
 * fails_when = it reads the archived goal.
 * Card goal-archive-key-result: protects = Archive lists Alert tone picker, whose other goal is a key result of
 * Faster activation, as staying on that key result, named (the API keeps it on the key result); fails_when = it is
 * shown as moving, or the key result is not named (goal-delete-r4).
 * Card goal-archive-key-result-title (goal-delete-r4): protects = after Archive with "Leave them with no goal", Alert
 * tone picker's panel reads the key result it is left on by name, as the API's goal title; fails_when = its goal has
 * no title ("Serves the goal undefined").
 * Card goal-archive-own-key-result (goal-delete-r4): protects = Archive Grow retention with Growth picked, and Alert
 * history export (on Grow retention and its own key result) reads Growth, as the dialog says (the API's
 * move_items_off counts no key result of the archived goal as live); fails_when = it stays on the key result.
 * Card goal-archive-nested-key-result (goal-delete-r5): protects = Archive Grow retention with Growth picked, and Alert
 * quiet hours (on Grow retention and a key result of its key result) reads Growth, as the dialog says (move_items_off
 * walks a key result up to its top goal); fails_when = it stays on the nested key result.
 * Card goal-archive-all-kept (goal-delete-r5): protects = with Team alert digest and Alert summary for leads moved to
 * Trash, the only item Archive keeps on another goal is Alert tone picker, on a key result, and the dialog says it
 * keeps another goal, not that it goes there; fails_when = it reads "serves another goal too and goes there".
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** The key result of Faster activation Alert tone picker serves (server.ts, invented). */
const KR = "KR 1 Teams get a first alert in a day";
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

test("Archive goal names the key result an item stays on", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await expect(dialog).toContainText(`Alert tone picker stays on ${KR}`);
  await expect(dialog).not.toContainText("Alert tone picker → Faster activation");
});

test("An item left on a key result reads that key result as its goal", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await tap(dialog.getByRole("radio", { name: "Leave them with no goal (they show under No goal)" }));
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  await ranked(page);
  await tap(draft(page, "Alert tone picker").getByText("Alert tone picker", { exact: true }));
  const panel = page.getByRole("dialog").filter({ hasText: "Serves the goal" });
  await expect(panel).toContainText(`Serves the goal ${KR}`);
  await expect(panel).not.toContainText("undefined");
});

test("An item on the archived goal and its own key result moves to the goal picked", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await expect(dialog).not.toContainText("Alert history export →");
  const pick = dialog.getByLabel("Goal", { exact: true });
  const label = (await pick.locator("option").allTextContents()).find((o) => o.endsWith("Growth"))!;
  await pick.selectOption({ label });
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  await ranked(page);
  await expect(draft(page, "Alert history export")).toContainText("Growth");
  await expect(draft(page, "Alert history export")).not.toContainText("Teams come back in week two");
});

test("An item on the archived goal and a key result of its key result moves to the goal picked", async ({ page }) => {
  await openPage(page);
  const dialog = await goalDialog(page, "Archive");
  await expect(dialog.getByTestId("goal-feature").filter({ hasText: "Alert quiet hours" })).toBeVisible();
  await expect(dialog).not.toContainText("Alert quiet hours stays on");
  const pick = dialog.getByLabel("Goal", { exact: true });
  const label = (await pick.locator("option").allTextContents()).find((o) => o.endsWith("Growth"))!;
  await pick.selectOption({ label });
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  await ranked(page);
  await expect(draft(page, "Alert quiet hours")).toContainText("Growth");
  await expect(draft(page, "Alert quiet hours")).not.toContainText("Teams set quiet hours in week two");
});

test("Archive says an item left on a key result keeps another goal", async ({ page }) => {
  await openPage(page);
  await ranked(page);
  // The two drafts Archive moves to another goal of their own go to Trash first.
  for (const name of ["Team alert digest", "Alert summary for leads"]) {
    await tap(draft(page, name).getByText(name, { exact: true }));
    const panel = page.getByTestId("floating-card");
    await tap(panel.getByRole("button", { name: "More actions" }));
    await tap(panel.getByRole("menuitem", { name: "Move to Trash…" }));
    await tap(page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }));
    await expect(draft(page, name)).toHaveCount(0);
  }

  await page.goto("/simple/priorities?tab=buckets");
  const dialog = await goalDialog(page, "Archive");
  await expect(dialog).toContainText(`1 keeps another goal: Alert tone picker stays on ${KR}`);
  await expect(dialog).not.toContainText("goes there");
});

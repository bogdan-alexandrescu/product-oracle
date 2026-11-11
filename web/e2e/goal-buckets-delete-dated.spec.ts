import { GOAL_BUCKETS_DATED_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-delete-dated: on Priorities > Goal buckets with a dated plan ("goal-buckets-dated": invented
 * goals Grow retention, Faster activation, ...; invented roadmap items Alert rules engine, Mobile
 * alert push and the draft Monthly alert recap, none in the plan), a goal's Delete goal and Archive
 * goal list every live feature serving it, say how many and ask where they go. Desktop 1440x900.
 *
 * Card goal-delete-dated-lists: protects = Delete goal names the goal's drafts and roadmap items
 * outside the plan, with their count, and asks where they go; fails_when = it says "It holds no
 * features in the plan" and offers no goal.
 * Card goal-delete-dated-moves: protects = the picked goal is what each moved feature's panel reads
 * after the delete (a roadmap item and a draft); fails_when = they are left with no goal.
 * Card goal-archive-dated-lists: protects = Archive goal lists the same features and moves them to
 * the picked goal, a draft linked to it directly too, and Undo puts them back; fails_when = it
 * counts only the plan's, or the draft keeps the archived goal.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId("floating-card");
const goal = (page: Page, title: string) => page.locator(`[data-testid="plan-goal"][data-goal="${title}"]`);
const OUTSIDE = ["Alert rules engine", "Mobile alert push", "Monthly alert recap"];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_DATED_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  const g = goal(page, "Grow retention");
  await expect(g).toContainText("Nothing in the plan yet");
  await expect(g).toContainText("Monthly alert recap");
  return g;
}

async function dialogFor(page: Page, item: "Delete goal" | "Archive goal", name: string) {
  await tap(goal(page, "Grow retention").getByRole("button", { name: "More for Grow retention" }));
  await tap(page.getByRole("menuitem", { name: item }));
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function listsThem(dialog: Locator) {
  await expect(dialog).not.toContainText("holds no features");
  const listed = dialog.getByTestId("goal-feature");
  for (const name of OUTSIDE) await expect(listed.filter({ hasText: name })).toHaveCount(1);
  const n = await listed.count();
  await expect(dialog).toContainText(`It holds ${n} features`);
  await expect(dialog.getByLabel("Goal", { exact: true })).toBeVisible();
}

test("a dated plan's Delete goal lists the goal's features outside the plan and moves them to the picked goal", async ({ page }) => {
  await open(page);
  const dialog = await dialogFor(page, "Delete goal", "Delete Grow retention");
  await listsThem(dialog);
  // Nothing goes until the person picks where.
  await expect(dialog.getByRole("button", { name: "Delete goal" })).toBeDisabled();
  const to = dialog.getByLabel("Goal", { exact: true });
  const goals = await to.locator("option").allTextContents();
  await to.selectOption({ label: goals.find((o) => o.includes("Faster activation"))! });
  await tap(dialog.getByRole("button", { name: "Delete goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);

  // The draft now sits under Faster activation, and its panel reads that goal.
  const draft = goal(page, "Faster activation").getByTestId("plan-feature").filter({ hasText: "Monthly alert recap" });
  await tap(draft.getByTestId("plan-feature-open"));
  await expect(panel(page).getByTestId("card-goal")).toContainText("Faster activation");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  // So does a roadmap item outside the plan.
  await tap(page.locator("#prio-tab-ranked"));
  await tap(page.getByTestId("prio-title").filter({ hasText: "Mobile alert push" }));
  const read = panel(page).getByTestId("card-goal");
  await expect(read).toContainText("Faster activation");
  await expect(read).not.toContainText("Grow retention");
});

test("a dated plan's Archive goal lists the same features, moves them to the picked goal, and Undo puts them back", async ({ page }) => {
  await open(page);
  const dialog = await dialogFor(page, "Archive goal", "Archive Grow retention");
  await listsThem(dialog);
  const to = dialog.getByLabel("Goal", { exact: true });
  const goals = await to.locator("option").allTextContents();
  await to.selectOption({ label: goals.find((o) => o.includes("Faster activation"))! });
  await tap(dialog.getByRole("button", { name: "Archive goal" }));
  await expect(goal(page, "Grow retention")).toHaveCount(0);
  const draft = (title: string) => goal(page, title).getByTestId("plan-feature").filter({ hasText: "Monthly alert recap" });
  await tap(draft("Faster activation").getByTestId("plan-feature-open"));
  await expect(panel(page).getByTestId("card-goal")).toContainText("Faster activation");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);

  await tap(page.getByRole("button", { name: "Undo" }));
  await expect(draft("Grow retention")).toHaveCount(1);
  await expect(draft("Faster activation")).toHaveCount(0);
});

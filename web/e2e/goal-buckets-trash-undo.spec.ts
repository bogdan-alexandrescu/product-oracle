import { GOAL_BUCKETS_DATED_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * goal-delete-r5, moved from the Goal ladder (the Goal map grid that replaced it has no goal Trash): on
 * Priorities > Goal buckets with a dated plan ("goal-buckets-dated", invented data), owner, desktop 1440x900.
 * Grow retention holds the draft Monthly alert recap.
 *
 * Card buckets-goal-trash-undo: protects = Delete goal on Grow retention, its features moved to Faster
 * activation, moves Monthly alert recap there; Undo in the note brings the goal back with Monthly alert recap
 * under it again and off Faster activation (Trash's restore gives the features their goals back);
 * fails_when = the goal comes back but its feature stays on Faster activation; no_claim = Restore from
 * Settings › Trash.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const GOAL = "Grow retention";
const OTHER = "Faster activation";
const FEATURE = "Monthly alert recap";

const goal = (page: Page, title: string) => page.locator(`[data-testid="plan-goal"][data-goal="${title}"]`);
const feature = (page: Page, title = GOAL) => goal(page, title).getByTestId("plan-feature").filter({ hasText: FEATURE });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

test("Undo after Delete goal brings its feature back under it", async ({ page }) => {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_DATED_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(feature(page)).toHaveCount(1);

  await tap(goal(page, GOAL).getByRole("button", { name: `More for ${GOAL}` }));
  await tap(page.getByRole("menuitem", { name: "Delete goal" }));
  const dialog = page.getByRole("dialog", { name: `Delete ${GOAL}` });
  const to = dialog.getByLabel("Goal", { exact: true });
  await to.selectOption({ label: (await to.locator("option").allTextContents()).find((o) => o.includes(OTHER))! });
  await tap(dialog.getByRole("button", { name: "Delete goal" }));
  const note = page.getByTestId("bucket-note");
  await expect(note).toContainText(`Deleted ${GOAL}`);
  await expect(goal(page, GOAL)).toHaveCount(0);
  await expect(feature(page, OTHER)).toHaveCount(1);

  await tap(note.getByRole("button", { name: "Undo" }));
  await expect(note).toContainText(`Undone: ${GOAL} and its links are back.`);
  await expect(goal(page, GOAL)).toHaveCount(1);
  await expect(feature(page)).toHaveCount(1);
  await expect(feature(page, OTHER)).toHaveCount(0);
});

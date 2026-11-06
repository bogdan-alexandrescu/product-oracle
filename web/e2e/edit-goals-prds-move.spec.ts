import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * edit-goals-prds, fix round 3 (PR 1279): Move up and Move down in a goal bucket's ⋯ menu, on the
 * mock's "goal-buckets-undated" scenario (no dated plan). They store the company's goal order
 * through the goal order route (PATCH /v1/baseline/entities/{id}, attrs.position, as Home's Change
 * order), so Priorities and the Roadmap's goal rows follow it; Undo puts it back. Invented data:
 * goals Faster activation, Grow retention, Reliability, Growth, Activation and Revenue.
 *
 * Card eg1-move: protects = an owner's ⋯ reads Move up and Move down (no Move up on the first
 * goal, no Move down on the last); Move up on the second goal puts it first on Priorities and on
 * the Roadmap's goal rows, with Undo in the note, which puts it back; a viewer has no menu;
 * fails_when = no Move up, the order stays, or Undo leaves it moved.
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

async function open(page: Page, viewport: { width: number; height: number }, who?: string) {
  await page.setViewportSize(viewport);
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page, who);
  await buckets(page);
}

async function buckets(page: Page) {
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("goal-bucket").first()).toBeVisible();
}

/** The goal buckets' names, first first (No goal left out). */
const order = async (page: Page) => (await page.getByTestId("goal-bucket").locator("h3").allInnerTexts()).map((t) => t.trim()).filter((t) => t !== "No goal");
const bucket = (page: Page, goal: string) => page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
const note = (page: Page) => page.getByTestId("bucket-note");

async function menu(page: Page, goal: string) {
  await bucket(page, goal).getByRole("button", { name: `More for ${goal}` }).click();
  return page.getByRole("menuitem");
}

/** The Roadmap's goal rows (the Gantt's goal groups), first first. */
async function roadmapFirst(page: Page, goal: string) {
  await page.goto("/simple/roadmap");
  await page.getByRole("button", { name: "Gantt", exact: true }).click();
  await expect(page.getByTestId("chart-group").first()).toContainText(goal);
}

for (const size of SIZES) {
  test.describe(`goal bucket Move up and Move down (${size.name})`, () => {
    test("an owner moves the second goal up: it is first on Priorities and the Roadmap, and Undo puts it back", async ({ page }) => {
      await open(page, size.viewport);
      const before = await order(page);
      expect(before.length).toBeGreaterThan(2);
      const [first, second] = before;
      const last = before[before.length - 1];

      await expect(await menu(page, first)).toHaveText(["Edit goal", "Move down", "Archive goal", "Delete goal"]);
      await page.keyboard.press("Escape");
      await expect(await menu(page, last)).toHaveText(["Edit goal", "Move up", "Archive goal", "Delete goal"]);
      await page.keyboard.press("Escape");
      await expect(await menu(page, second)).toHaveText(["Edit goal", "Move up", "Move down", "Archive goal", "Delete goal"]);
      await page.getByRole("menuitem", { name: "Move up" }).click();

      const moved = [second, first, ...before.slice(2)];
      await expect(note(page)).toContainText("Goal order saved. Every page shows the new order.");
      await expect.poll(() => order(page)).toEqual(moved);
      await note(page).getByRole("button", { name: "Undo" }).click();
      await expect(note(page)).toHaveCount(0);
      await expect.poll(() => order(page)).toEqual(before);
      await buckets(page);
      await expect.poll(() => order(page)).toEqual(before);
      await roadmapFirst(page, first);

      // Moved again, it stays first after a reload and leads the Roadmap's goal rows.
      await buckets(page);
      await (await menu(page, second)).filter({ hasText: "Move up" }).click();
      await expect.poll(() => order(page)).toEqual(moved);
      await buckets(page);
      await expect.poll(() => order(page)).toEqual(moved);
      await expect(await menu(page, second)).toHaveText(["Edit goal", "Move down", "Archive goal", "Delete goal"]);
      await page.keyboard.press("Escape");
      await roadmapFirst(page, second);
    });

    test("a viewer has no goal menu", async ({ page }) => {
      await open(page, size.viewport, "viewer@example.com");
      await expect(page.getByTestId("goal-bucket").first().locator("h3")).toBeVisible();
      await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
    });
  });
}

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal buckets, fix round 3 (PR 1224). Card tasks-accept-move: protects = a commenter's move of a
 * planned task to another goal (proposed, the task stays put) waits in the roadmap's Needs a
 * decision panel as "move it to another goal"; once the owner accepts it there, the task shows in the new goal in the dated Goal
 * buckets, for the owner and for the commenter who proposed it, with the goals' feature counts
 * following; fails_when = the accepted move leaves the task under its old goal. The mock's
 * "simple-plan" (dated): goals Reliability, Growth, Activation and Revenue. Invented data.
 *
 * Card tasks-roadmap-goal: protects = with no dated plan ("goal-buckets-undated"), a bucket for one
 * of the roadmap's own goals (Grow retention, not one of the plan's) has "+ Add a task" and a grip
 * on each task, as the plan's goals do: a task added there shows as a Draft, one of its tasks moves
 * to Growth by keys, and Undo puts it back; fails_when = that bucket has no add row or no grips.
 */

async function open(page: Page, who: string) {
  await login(page, who);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toBeVisible();
}

const count = (page: Page, goal: string) => bucket(page, goal).getByText(/^\d+ features? in the plan$/);
const bucket = (page: Page, goal: string) => page.locator('[data-testid="plan-goal"]').filter({ has: page.getByRole("heading", { name: goal, exact: true }) });

async function scenario(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, name, THEME_KEY] as const,
  );
}

test("a commenter's proposed move, once accepted, moves the task in the dated goal buckets", async ({ page }) => {
  await scenario(page, "simple-plan");
  await open(page, "commenter@example.com");
  const growthCount = await count(page, "Growth").textContent();
  const grip = bucket(page, "Reliability").locator('[data-code="F-03"]').getByTestId("feature-grip");
  await grip.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("bucket-live")).toHaveText("Over goal 2, Growth. Enter drops it there.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bucket-note")).toContainText("Proposed moving Setup failure alerts to Growth: it waits for a decision.");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toHaveCount(0);
  await page.goto("/home");
  await signOut(page);

  // The owner decides it in the roadmap's Needs a decision panel (Home's "All proposals").
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap?review=proposals");
  const proposal = page.getByTestId("tray-proposal").filter({ hasText: "Setup failure alerts: move it to another goal" });
  await expect(proposal).toBeVisible();
  await proposal.getByRole("button", { name: "Accept" }).click();
  await expect(proposal).toHaveCount(0);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
  await page.goto("/home");
  await signOut(page);

  // The commenter who proposed it sees the move land.
  await login(page, "commenter@example.com");
  await page.goto("/simple/priorities?tab=buckets");
  await expect(bucket(page, "Growth").locator('[data-code="F-03"]')).toBeVisible();
  await expect(bucket(page, "Reliability").locator('[data-code="F-03"]')).toHaveCount(0);
  expect(growthCount).toMatch(/features? in the plan/);
  await expect(count(page, "Growth")).toHaveText(`${Number(growthCount!.split(" ")[0]) + 1} features in the plan`);
});

test("with no dated plan, a bucket for one of the roadmap's own goals takes new tasks and moves its tasks", async ({ page }) => {
  await scenario(page, "goal-buckets-undated");
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  const card = (goal: string) => page.locator('[data-testid="goal-bucket"]').filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
  const note = page.getByTestId("bucket-note");
  const retention = card("Grow retention");
  await expect(retention.locator("[data-code]").first()).toBeVisible();

  const add = retention.getByTestId("add-task");
  await add.getByRole("button", { name: "+ Add a task" }).click();
  const form = add.getByTestId("task-form");
  await expect(form).toContainText("Goal: Grow retention");
  await form.getByLabel("Name").fill("Saved wishlists");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(note).toContainText("Added Saved wishlists to Grow retention.");
  await expect(retention.getByTestId("plan-feature").filter({ hasText: "Saved wishlists" })).toContainText("Draft");

  const row = retention.locator('[data-code="ARE"]');
  const grip = row.getByTestId("feature-grip");
  const name = ((await grip.getAttribute("aria-label")) ?? "").replace(/^Move (.*) to another goal$/, "$1");
  expect(name).not.toBe("");
  await grip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bucket-live")).toContainText(`Picked up ${name}.`);
  // The arrows go through the goals in their order; Growth is a few steps away.
  const live = page.getByTestId("bucket-live");
  for (let n = 0; n < 8 && !(await live.textContent())?.includes(", Growth."); n++) {
    const was = (await live.textContent()) ?? "";
    await page.keyboard.press("ArrowDown");
    await expect(live).not.toHaveText(was);
  }
  await expect(card("Growth")).toHaveAttribute("data-drop", "");
  await page.keyboard.press("Enter");
  await expect(note).toContainText(`Moved ${name} to Growth.`);
  await expect(card("Growth").locator('[data-code="ARE"]')).toBeVisible();
  await expect(retention.locator('[data-code="ARE"]')).toHaveCount(0);
  await note.getByRole("button", { name: "Undo" }).click();
  await expect(retention.locator('[data-code="ARE"]')).toBeVisible();
});

import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * goal-order: goals keep one order on every page, set by a Position field (1 = first) in the
 * goal's Edit form in Detailed > Baseline. The "simple-home" mock scenario's goals are made
 * together and weigh Grow retention 3, Faster activation 2, Keep alerts quiet 1; the person
 * sets positions that follow neither the weights, the titles nor the keys, then Simple Home,
 * Simple Roadmap, Simple Priorities, the New PRD goal chips, Detailed Plan and Detailed
 * Priorities all show the goals in that one order. Invented data.
 */

const POSITIONS: [key: string, name: string, position: number][] = [
  ["grow-retention", "Grow retention", 1],
  ["quiet-alerts", "Keep alerts quiet", 2],
  ["faster-activation", "Faster activation", 3],
  ["g.paid-conversion", "Grow paid conversion", 4],
  ["g.activation", "Raise activation", 5],
];
const NAMES = POSITIONS.map(([, name]) => name);

/** The goal names as they come in `texts`, each once, in the order first met. */
function order(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    // "Grow paid conversion" holds no other name; check the longer names first.
    const name = [...NAMES].sort((a, b) => b.length - a.length).find((n) => t.includes(n));
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** `names` in the order the positions give. */
const expected = (...names: string[]) => NAMES.filter((n) => names.includes(n));

/** Waits until `list` names the goals in `want`'s order (the lists load in steps). */
async function inOrder(list: Locator, want: string[]) {
  await expect(list.first()).toBeVisible();
  await expect.poll(async () => order(await list.allInnerTexts())).toEqual(want);
}

async function setPositions(page: Page) {
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  for (const [key, name, position] of POSITIONS) {
    const row = page.getByTestId(`goal-${key}`);
    await row.getByRole("button", { name, exact: true }).click();
    const drawer = page.getByRole("dialog").last();
    await drawer.getByRole("button", { name: "Edit" }).click();
    const form = drawer.getByRole("form", { name: "Edit" });
    await form.getByLabel(/^Position/).fill(String(position));
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }
}

for (const [label, viewport] of [
  ["desktop", { width: 1366, height: 820 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`goal order (${label})`, () => {
    test.use({ viewport });

    test("the Position field sets one goal order on every page", async ({ page }) => {
      test.setTimeout(120_000);
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "simple-home"), [MOCK_SCENARIO_KEY]);
      await login(page);
      await setPositions(page);

      await page.goto("/simple");
      await inOrder(page.getByTestId("home-goal"), expected("Grow retention", "Keep alerts quiet", "Faster activation"));

      await page.getByRole("button", { name: "New PRD" }).first().click();
      const chips = page.getByRole("group", { name: "The goals it helps" }).getByRole("button");
      await inOrder(chips, expected("Grow retention", "Keep alerts quiet", "Faster activation"));

      await page.goto("/simple/roadmap");
      await inOrder(page.getByTestId("goal-counters").getByRole("listitem"), expected("Grow retention", "Keep alerts quiet", "Faster activation"));

      await page.goto("/simple/priorities");
      await page.getByRole("tab", { name: "Goal buckets" }).click();
      await inOrder(page.getByTestId("goal-bucket"), expected("Grow retention", "Faster activation"));

      await page.goto("/plan");
      const cards = page.locator('[data-testid^="home-goal-G"]');
      // Plan's goal cards show the first four goals, then "2 more".
      await inOrder(cards, NAMES.slice(0, 4));

      await page.goto("/priorities");
      const byGoal = page.getByRole("table", { name: "By goal" }).getByRole("row");
      await inOrder(byGoal, expected("Grow paid conversion", "Raise activation"));
    });

    test("the Position field refuses a number below 1", async ({ page }) => {
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "simple-home"), [MOCK_SCENARIO_KEY]);
      await login(page);
      await page.goto("/baseline");
      await page.getByTestId("goal-grow-retention").getByRole("button", { name: "Grow retention", exact: true }).click();
      const drawer = page.getByRole("dialog").last();
      await drawer.getByRole("button", { name: "Edit" }).click();
      const form = drawer.getByRole("form", { name: "Edit" });
      await form.getByLabel(/^Position/).fill("0");
      await form.getByRole("button", { name: "Save" }).click();
      await expect(form.getByText("The position is a whole number, 1 or more (1 = first)")).toBeVisible();
    });
  });
}

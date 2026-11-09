import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * kr-in-goal-card, on the mock's "goal-key-results" scenario (invented: Faster activation has two
 * confirmed key results, KR 1 with a roadmap item, Guided setup checklist, and KR 2 with none yet
 * but a feature someone suggested for it, First alert wizard).
 *
 * Card kr-strip: protects = the Simple roadmap's goal strip shows one card for the goal, with a
 * "Key results · 2" line whose (i) names both; no key result has a card of its own; the goal's
 * card counts the key result's item; fails_when = a key result shows as a goal card ("No items
 * yet") or the line is missing.
 * Card kr-filter: protects = the Goal filter lists the goal and no key result; picking the goal
 * keeps its key result's item; fails_when = a key result is a filter entry or its item is lost.
 * Card kr-suggest: protects = a feature suggested for a key result is reached from its goal's
 * "suggested feature" button; fails_when = it is unreachable or counted on a card of its own.
 */

const KR1 = "Half of new teams set up in one day";
const KR2 = "New teams send a first alert in week one";

async function open(page: Page) {
  await page.context().addInitScript(([key]) => localStorage.setItem(key, "goal-key-results"), [MOCK_SCENARIO_KEY]);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("goal-counters")).toBeVisible();
}

test.describe("Simple roadmap: key results sit inside their goal's card", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one card per goal, its key results on one line", async ({ page }) => {
    await open(page);
    const strip = page.getByTestId("goal-counters");
    const card = strip.getByTestId("goal-counter").filter({ hasText: "Faster activation" });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("goal-counter-krs")).toHaveText(/Key results · 2/);
    await card.getByTestId("goal-counter-krs-tip").click();
    const tip = page.getByRole("tooltip").filter({ hasText: KR1 });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(KR2);
    // No key result is a goal card of its own, with items or without.
    await expect(strip.locator("> li").filter({ hasText: KR1 }).filter({ hasNotText: "Faster activation" })).toHaveCount(0);
    await expect(strip.locator("> li").filter({ hasText: KR2 }).filter({ hasNotText: "Faster activation" })).toHaveCount(0);
    // The key result's item counts on its goal's card and draws in its goal's lane.
    await expect(page.getByText("Guided setup checklist").first()).toBeVisible();
    await expect(page.getByTestId("timeline-lane").filter({ hasText: KR1 })).toHaveCount(0);
  });

  test("the Goal filter lists the goal, not its key results, and keeps their work", async ({ page }) => {
    await open(page);
    const goal = page.getByRole("combobox", { name: "Goal", exact: true });
    const options = await goal.locator("option").allInnerTexts();
    expect(options.some((o) => o.includes("Faster activation"))).toBe(true);
    expect(options.filter((o) => o.includes(KR1) || o.includes(KR2))).toEqual([]);
    const value = await goal.locator("option", { hasText: "Faster activation" }).getAttribute("value");
    await goal.selectOption(value!);
    await expect(page.getByTestId("goal-counters").getByTestId("goal-counter")).toHaveCount(1);
    await expect(page.getByText("Guided setup checklist").first()).toBeVisible();
  });

  test("a key result's suggested feature is reached from its goal's card", async ({ page }) => {
    await open(page);
    const card = page.getByTestId("goal-counters").getByTestId("goal-counter").filter({ hasText: "Faster activation" });
    const button = card.getByTestId("goal-counter-suggestions");
    await expect(button).toContainText(/suggested feature/);
    await button.click();
    await expect(page.getByText("First alert wizard").first()).toBeVisible();
  });
});

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
 * Card kr-lane: protects = grouped by goal, the key result's item is drawn in its parent goal's
 * lane and no key result has a lane; fails_when = the item sits in a lane of its own. tb-mk: the
 * Timeline's bands are now the tracks and the Gantt's Group by starts at Track, so the goal
 * lanes are read on the Gantt's Group by Goal, picked as a person would; the Timeline's track
 * bands still give no key result a band of its own.
 * Card kr-fold: protects = a proposed key result (Teams share a first report) and KR 1's own
 * subgoal (Setup takes ten minutes), each with an item, fold into Faster activation: no card,
 * lane or Goal filter entry of their own, and the subgoal is listed with the key results;
 * fails_when = either is a goal of its own or the subgoal is missing from the list.
 * Card kr-name-kept: protects = a key result's suggested feature, opened from its goal's card,
 * still names the key result it serves (Reject's note); fails_when = it names the parent goal.
 */

const KR1 = "Half of new teams set up in one day";
const KR2 = "New teams send a first alert in week one";
const PROPOSED = "Teams share a first report";
const SUB = "Setup takes ten minutes";

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
    // KR 1, KR 2 and KR 1's own subgoal; the proposed key result is not listed.
    await expect(card.getByTestId("goal-counter-krs")).toHaveText(/Key results · 3/);
    await card.getByTestId("goal-counter-krs-tip").click();
    const tip = page.getByRole("tooltip").filter({ hasText: KR1 });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(KR2);
    await expect(tip).toContainText(SUB);
    await expect(tip).not.toContainText(PROPOSED);
    // No key result is a goal card of its own, with items or without, at any depth or status.
    for (const name of [KR1, KR2, PROPOSED, SUB]) await expect(strip.locator("> li").filter({ hasText: name }).filter({ hasNotText: "Faster activation" })).toHaveCount(0);
  });

  test("grouped by goal, every key result's item is drawn in its goal's lane", async ({ page }) => {
    await open(page);
    // The Timeline's bands are the tracks: none is a key result's.
    await page.getByTestId("format-timeline").click();
    const bands = page.getByTestId("timeline-lane");
    await expect(bands.first()).toBeVisible();
    for (const name of [KR1, KR2, PROPOSED, SUB]) await expect(bands.filter({ hasText: name })).toHaveCount(0);

    // The Gantt, grouped by goal: one Faster activation lane holds the key results' items.
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    await page.getByTestId("group-goal").click();
    await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");
    const lanes = page.getByTestId("chart-group");
    await expect(lanes.filter({ hasText: "Faster activation" })).toHaveCount(1);
    // Each item's lane: the nearest lane header above its row.
    const laneOf = (title: string) =>
      page
        .getByTestId("chart-label")
        .filter({ has: page.getByTestId("label-title").getByText(title, { exact: true }) })
        .evaluate((el) => {
          let e = el.parentElement!.previousElementSibling;
          while (e && e.getAttribute("data-testid") !== "chart-group") e = e.previousElementSibling;
          return (e?.textContent ?? "").trim();
        });
    for (const item of ["Guided setup checklist", "Starter report template", "Setup progress bar"]) await expect.poll(() => laneOf(item)).toMatch(/Faster activation/);
    for (const name of [KR1, KR2, PROPOSED, SUB]) await expect(lanes.filter({ hasText: name })).toHaveCount(0);
  });

  test("the Goal filter lists the goal, not its key results, and keeps their work", async ({ page }) => {
    await open(page);
    const goal = page.getByRole("combobox", { name: "Goal", exact: true });
    const options = await goal.locator("option").allInnerTexts();
    expect(options.some((o) => o.includes("Faster activation"))).toBe(true);
    expect(options.filter((o) => [KR1, KR2, PROPOSED, SUB].some((k) => o.includes(k)))).toEqual([]);
    const value = await goal.locator("option", { hasText: "Faster activation" }).getAttribute("value");
    await goal.selectOption(value!);
    await expect(page.getByTestId("goal-counters").getByTestId("goal-counter")).toHaveCount(1);
    await expect(page.getByText("Guided setup checklist").first()).toBeVisible();
    await expect(page.getByText("Starter report template").first()).toBeVisible();
    await expect(page.getByText("Setup progress bar").first()).toBeVisible();
  });

  test("a key result's suggested feature is reached from its goal's card", async ({ page }) => {
    await open(page);
    const card = page.getByTestId("goal-counters").getByTestId("goal-counter").filter({ hasText: "Faster activation" });
    const button = card.getByTestId("goal-counter-suggestions");
    await expect(button).toContainText(/suggested feature/);
    await button.click();
    await expect(page.getByText("First alert wizard").first()).toBeVisible();
    // Listed under its goal, it still names the key result it serves.
    const panel = page.getByTestId("goal-panel");
    await expect(panel.getByText("First alert wizard")).toBeVisible();
    await panel.getByRole("button", { name: "Reject", exact: true }).click();
    const reject = page.getByRole("dialog", { name: "Reject First alert wizard" });
    await expect(reject).toContainText(`Oracle will not suggest it again for KR 2 ${KR2}`);
  });
});

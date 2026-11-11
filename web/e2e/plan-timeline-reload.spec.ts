import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * PR 1289 review (B-26 follow-ups): protects = with the Plan's Timeline shown, approving a plan
 * change redraws the Timeline from the new version (an added item is on the chart, a moved item
 * keeps its bar: an undated one is drawn in Later's window whatever its horizon, board-quarters)
 * without a reload; the Plan's own track milestones are on
 * the chart as "M1 First release"; a draft's row is drawn at the draft's own delivery date when it
 * has one, and otherwise its bar is marked as showing the approved dates, with the reason behind
 * an (i). fails_when = the Timeline keeps the old version's dates or lists the added item under
 * "Not on the timeline", the track milestone is missing, or a draft's bar shows the approved dates
 * with nothing saying so. Invented data: the mock's Usage alerts roadmap ("plan-timeline" and
 * "plan-timeline-edit" date its items in Simple; the second has its version 1 approved).
 */

const inScenario = (page: Page, s: string) => page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);
const changes = (page: Page) => page.getByTestId("plan-changes").filter({ visible: true });
const editItem = (page: Page, title: string) => changes(page).getByTestId("edit-item").filter({ hasText: title });

async function openTimeline(page: Page) {
  await login(page);
  await page.goto("/plan");
  await expect(page.getByTestId("plan-table").or(page.getByTestId("plan-timeline"))).toBeVisible();
  await page.getByRole("group", { name: "Roadmap view" }).getByRole("button", { name: "Timeline", exact: true }).click();
  const timeline = page.getByTestId("plan-timeline");
  await expect(timeline.getByTestId("label-title").first()).toBeVisible();
  return timeline;
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("approving a plan change redraws the Timeline from the new version", async ({ page }) => {
  await inScenario(page, "plan-timeline-edit");
  const timeline = await openTimeline(page);
  const bar = (key: string) => timeline.locator(`[data-testid="bar"][data-item="${key}"]`);
  await expect(bar("spend-forecast")).toHaveCount(1);
  const before = await bar("spend-forecast").getAttribute("data-start");
  await expect(timeline.getByTestId("label-title").filter({ hasText: "Spend alerts by email" })).toHaveCount(0);

  // Change the plan: move Spend forecast for the month to Later, add an item in Later.
  await page.getByTestId("plan-edit").click();
  await editItem(page, "Spend forecast for the month").getByLabel("Horizon of Spend forecast for the month").selectOption("later");
  await changes(page).getByLabel("New item title").fill("Spend alerts by email");
  await changes(page).getByLabel("Horizon of the new item").selectOption("later");
  await changes(page).getByRole("button", { name: "Add item" }).click();
  await changes(page).getByRole("button", { name: "Propose changes" }).click();
  await changes(page).getByTestId("plan-proposal").getByRole("button", { name: "Approve version 2" }).click();
  await expect(page.getByTestId("plan-live")).toHaveText("Version 2 is the live plan.");

  // The Timeline reads the new version: the added item is on the chart; the moved one, undated,
  // stays drawn in Later's window (its column is its dates' quarter).
  await expect(page.getByTestId("plan-timeline")).toBeVisible();
  await expect(timeline.getByTestId("label-title").filter({ hasText: "Spend alerts by email" })).toHaveCount(1);
  await expect(timeline.getByTestId("plan-timeline-undated-item").filter({ hasText: "Spend alerts by email" })).toHaveCount(0);
  await expect(bar("spend-alerts-by-email")).toHaveAttribute("data-start", /^\d{4}-\d{2}-\d{2}$/);
  await expect(bar("spend-forecast")).toHaveCount(1);
  await expect(bar("spend-forecast")).toHaveAttribute("data-start", before!);
});

test("the Timeline draws the Plan's track milestones and a draft's own dates, or says it shows the approved ones", async ({ page }) => {
  await inScenario(page, "plan-timeline");
  const timeline = await openTimeline(page);
  // The track's milestone listed above the roadmap, by its number and name.
  await expect(page.getByTestId("track-milestone").filter({ hasText: "First release" }).getByTestId("milestone-title")).toHaveText(/^M1 · /);
  await expect(timeline.getByTestId("track-milestone").filter({ hasText: "M1 First release" })).toHaveCount(1);

  // These rows are the roadmap draft's: one with a delivery date of its own is drawn to that date.
  await expect(timeline.locator('[data-testid="bar"][data-item="threshold-alerts"]')).toHaveAttribute("data-end", "2026-11-20");
  await expect(timeline.locator('[data-testid="plan-timeline-approved-dates"][data-item="threshold-alerts"]')).toHaveCount(0);
  // One with none is drawn at the approved dates, and says so behind its (i).
  const mark = timeline.locator('[data-testid="plan-timeline-approved-dates"][data-item="usage-dashboard"]');
  await expect(mark).toHaveCount(1);
  await mark.getByRole("button", { name: "About the dates of Usage dashboard" }).click();
  await expect(mark).toContainText("The draft has no dates for this item yet, so its bar shows the approved dates.");
});

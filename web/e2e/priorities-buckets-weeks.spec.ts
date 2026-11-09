import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal buckets says weeks like the Value / effort chart and the Ranked tab (the owner, Nov 8): a goal's bar,
 * its segments, the milestones' caption, a feature's total and the chip a dragged feature carries read
 * "N weeks", a 1-week item "1 week"; never "wk". On the mock's "simple-plan-goalless" scenario (invented:
 * Guided setup's plan, plus Docs refresh, 1 week, with no goal). Desktop 1440x900.
 */

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, "simple-plan-goalless", THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
}

const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

test("Goal buckets says weeks: the bars, the caption, a feature, the drag chip and a 1-week item", async ({ page }) => {
  await open(page);
  const head = page.getByTestId("buckets-head");
  await expect(head).not.toContainText(/\bwk\b/);
  // The caption: each milestone's planned weeks of its capacity.
  await expect(head.getByTestId("milestone-chip").first()).toContainText(/ · \d+ of \d+ weeks$/);
  // A goal's bar: its total and its segments, shown or in the segment's title.
  const reliability = head.locator('[data-testid="goal-bar"][data-goal="Reliability"]');
  await expect(reliability.getByTestId("goal-bar-total")).toHaveText("11 weeks");
  for (const l of await reliability.getByTestId("goal-bar-segment").locator("[data-label]").allTextContents()) expect(l).toMatch(/ · \d+ weeks$/);
  await expect(reliability.getByTestId("goal-bar-label").first()).toBeVisible();

  // A feature in its bucket, and the chip it carries when dragged.
  const alerts = bucket(page, "Reliability").locator('[data-code="F-03"]');
  await expect(alerts.getByTestId("plan-feature-total")).toHaveText("2 weeks");
  const grip = alerts.getByTestId("feature-grip");
  await grip.scrollIntoViewIfNeeded();
  const from = (await grip.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + 120, { steps: 8 });
  const ghost = page.getByTestId("drag-ghost");
  await expect(ghost).toContainText("Setup failure alerts");
  await expect(ghost).toContainText("2 weeks");
  await expect(ghost).not.toContainText(/\bwk\b/);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // Docs refresh is 1 week of work: one week, not "1 weeks" or "1 wk".
  const docs = page.locator('[data-code="F-21"]').first();
  await expect(docs).toContainText(/\b1 week\b/);
  await expect(docs).not.toContainText(/1 weeks|\bwk\b/);
  await expect(page.locator("main")).not.toContainText(/\d\s?wk\b/);
});

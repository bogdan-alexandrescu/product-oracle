import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * hotfix-effort-start: an item dated only by its end starts its feature's effort before that
 * end (Priorities' effort in weeks x 7 days; 28 days without one), not at its horizon window's
 * start, so a 1-week feature draws a 1-week bar on the Timeline, the Gantt and the Waterfall.
 * Driven through the UI on the mock's default scenario (invented data): "F-88 Alert history export"
 * (an S feature, 1 week) ends Feb 20, 2027 by its tracker; "F-87 Mobile alert push" (3 weeks) ends
 * Dec 20, 2026 by engineering; "F-86 Alert rules engine" is typed Oct 1 - Nov 10 (41 days).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "default"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

const timelineBar = (page: Page, title: string): Locator => page.getByRole("button", { name: new RegExp(`^${title}, `) }).first();
const chartBar = (page: Page, title: string): Locator => page.getByRole("button", { name: new RegExp(`^${title}: `) }).first();

test.use(DESKTOP);

test("an end-only S item's Timeline bar spans about one week, not from its window's start", async ({ page }) => {
  await open(page);
  const exportBar = timelineBar(page, "F-88 Alert history export");
  const rules = timelineBar(page, "F-86 Alert rules engine");
  await exportBar.scrollIntoViewIfNeeded();
  await expect(exportBar).toBeVisible();
  await expect(exportBar).toHaveAttribute("data-start", "2027-02-14");
  await expect(exportBar).toHaveAttribute("data-end", "2027-02-20");
  await expect(exportBar).toHaveAccessibleName(/Feb 14/);
  // About one week: under a quarter of the 41-day typed bar (it drew 51 days, from Jan 1, before).
  const w = (await exportBar.boundingBox())!.width;
  const r = (await rules.boundingBox())!.width;
  expect(w / r, "the 1-week bar is about 8/41 of the 41-day bar").toBeLessThan(0.3);
  expect(w / r).toBeGreaterThan(0.1);
  // A Now item with an end only starts its 3 weeks before it, not on Oct 1.
  await expect(timelineBar(page, "F-87 Mobile alert push")).toHaveAttribute("data-start", "2026-11-30");
});

for (const view of ["Gantt", "Waterfall"]) {
  test(`the ${view} draws the end-only S item's bar over about one week`, async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: view, exact: true }).click();
    const bar = chartBar(page, "F-88 Alert history export");
    await expect(bar).toHaveAttribute("data-start", "2027-02-14");
    await expect(bar).toHaveAttribute("data-end", "2027-02-20");
    await expect(chartBar(page, "F-87 Mobile alert push")).toHaveAttribute("data-start", "2026-11-30");
  });
}

/*
 * effort-reader: an estimated span is the effort's days, its end included, as a suggestion's;
 * a feature with no effort spans 28 days (the API's service.efforts reads none, not 1 week),
 * and what an item depends on still pushes its estimated start later. In the
 * "simple-dated-move" scenario (invented data), Alert archive (no effort) ends Mar 19, 2027 by
 * engineering; Alert sound picker (no effort) ends Apr 16, 2027 and depends on Alert replay
 * engine, which ends Apr 2.
 * protects = Alert archive's bar starts Feb 20 (28 days), Alert sound picker's Apr 3, the day
 * after Alert replay engine ends; fails_when = the mock reads 1 week for a feature it does not
 * list (Mar 12 / Apr 9), or a span is a day longer; no_claim = the API's dates
 * (api/tests/test_simple_dates.py).
 */
test("an end-only item with no effort spans 28 days, and a dependency still pushes a start later", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-dated-move"] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  const archive = chartBar(page, "Alert archive");
  await archive.scrollIntoViewIfNeeded();
  await expect(archive).toHaveAttribute("data-start", "2027-02-20");
  await expect(archive).toHaveAttribute("data-end", "2027-03-19");
  const sounds = chartBar(page, "Alert sound picker");
  await expect(sounds).toHaveAttribute("data-start", "2027-04-03");
  await expect(sounds).toHaveAttribute("data-end", "2027-04-16");
  await expect(chartBar(page, "Alert replay engine")).toHaveAttribute("data-end", "2027-04-02");
});

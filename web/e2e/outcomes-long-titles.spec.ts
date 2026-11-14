import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes side panel with long titles (seen on production): the edit form keeps Save
 * reachable, Why reads as a label and wrapped text, the goal picker and the Metric line stay
 * inside the panel, units read singular for 1, and a prediction in its own unit names its own
 * measure. Mock API, "outcomes-long" scenario (synthetic: four outcomes with long titles on a
 * key result with a long name, and a goal with no metric).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes-long"));
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
}

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });
const row = (page: Page, title: string) => page.getByTestId("outcome-row").filter({ hasText: title });
const EXPORT = "Let a team admin export every invoice";
const WARN = "Warn each team admin about failed card payments";
const TAX = "Show the plan price with tax";
const MOVE = "Move the billing service";

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("not laid out");
  return b;
}

/** The element ends at or before the panel's right edge. */
async function inside(l: Locator, panel: Locator) {
  const [b, p] = [await box(l), await box(panel)];
  expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
}

/** A person scrolls with the pointer on the panel until Save prediction shows. */
async function saveReachable(page: Page, panel: Locator) {
  const save = panel.getByRole("button", { name: "Save prediction" });
  await panel.getByTestId("prediction-form").hover();
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 300);
  await expect(save).toBeInViewport({ ratio: 1 });
}

test("at 1440x806 a long title's prediction form keeps Save prediction reachable", async ({ page }) => {
  // protects=the edit form under a 4-line title, beside a long table, scrolls with the pointer
  // on it until Save prediction shows; fails_when=Save sits below the bottom edge and the panel
  // does not scroll; no_claim=what Save writes (outcomes-confidence).
  await page.setViewportSize({ width: 1440, height: 806 });
  await start(page);
  await row(page, EXPORT).click();
  await expect(inspector(page).getByTestId("prediction-form")).toBeVisible();
  await saveReachable(page, inspector(page));
});

test("on a 390 phone a long title's prediction form keeps Save prediction reachable", async ({ page }) => {
  // protects=the same on a phone's sheet; fails_when=Save cannot be scrolled into view;
  // no_claim=the sheet's drag.
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await row(page, EXPORT).click();
  await expect(page.getByTestId("outcome-sheet")).toBeVisible();
  await saveReachable(page, page.getByTestId("outcome-sheet"));
});

test("Why reads as a label and left-aligned text that wraps", async ({ page }) => {
  // protects=the Why label shows whole, long Why text wraps inside the panel and short Why text
  // starts at the left; fails_when=the label shrinks to "W…", the text is cut at the right edge
  // or sits right-aligned; no_claim=how Why is written (the form).
  await start(page);
  await row(page, WARN).click();
  const panel = inspector(page);
  const why = panel.getByTestId("outcome-why");
  await expect(why).toContainText("once the warning ships");
  await inside(why, panel);
  expect((await box(why)).height).toBeGreaterThan(30);
  const label = panel.getByText("Why", { exact: true });
  await expect(label).toBeVisible();
  expect(await label.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.clientWidth > 20)).toBe(true);

  await row(page, TAX).click();
  const short = inspector(page).getByTestId("outcome-why");
  await expect(short).toHaveText("Fewer carts left");
  const [s, p] = [await box(short), await box(inspector(page))];
  expect(s.x - p.x).toBeLessThan(40);
});

test("the goal picker and the Metric line stay inside the panel, the full names on hover", async ({ page }) => {
  // protects=a long key result name and its metric wrap or truncate within the panel, each with
  // its full name in a title; fails_when=either runs past the panel's right edge;
  // no_claim=the picker's choices (outcomes-goal).
  await start(page);
  await row(page, TAX).click();
  const panel = inspector(page);
  const goal = panel.getByLabel("Goal");
  await expect(goal).toBeVisible();
  await inside(goal, panel);
  await expect(goal).toHaveAttribute("title", /in every region we sell in$/);
  const metric = panel.getByTestId("outcome-metric");
  await inside(metric, panel);
  await expect(metric).toHaveAttribute("title", /net of refunds/);
});

test("a figure of 1 reads with its unit in the singular", async ({ page }) => {
  // protects=Partly held at 1 event; fails_when="1 events"; no_claim=other languages.
  await start(page);
  await row(page, WARN).click();
  const panel = inspector(page);
  await expect(panel).toContainText("Partly held at1 event");
  await expect(panel).not.toContainText("1 events");
});

test("a prediction in its own unit names its own measure, the goal's metric behind an (i)", async ({ page }) => {
  // protects=an enabler predicted in % done shows "Done (% of the work)" on its Metric line and
  // the goal's metric only in its tip; fails_when=the line names the goal's revenue metric;
  // no_claim=the owner's pick on this design (questions.json).
  await start(page);
  await row(page, MOVE).click();
  const metric = inspector(page).getByTestId("outcome-metric");
  await expect(metric).toHaveText("Done (% of the work)");
  await expect(page.getByText(/Company revenue per day/).filter({ visible: true })).toHaveCount(0);
  await inspector(page).getByRole("button", { name: "About Goal metric" }).click();
  await expect(page.getByText(/Company revenue per day/).filter({ visible: true })).toBeVisible();
});

test("moving an outcome to a goal with no metric drops the old goal's metric", async ({ page }) => {
  // protects=the Metric line no longer names the old goal's metric after the move;
  // fails_when=it still reads the old metric; no_claim=the API (test_outcome_goal_change.py).
  await start(page);
  await row(page, TAX).click();
  await inspector(page).getByLabel("Goal").selectOption({ label: "Simpler billing for every team" });
  await expect(row(page, TAX)).toContainText("Simpler billing for every team");
  await expect(inspector(page).getByTestId("outcome-metric")).toHaveText("Not set yet");
});

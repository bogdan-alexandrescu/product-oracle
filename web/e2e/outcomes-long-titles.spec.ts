import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes side panel with long titles (seen on production): the edit form keeps Save
 * reachable, Why reads as a label and wrapped text, the goal picker and the Metric line stay
 * inside the panel, units read singular for 1, and a prediction in its own unit names its own
 * measure. Mock API, "outcomes-long" scenario (synthetic: outcomes with long titles on a key
 * result with a long name, one due for its check, and goals with no metric).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

async function start(page: Page, role?: "viewer") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes-long"));
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
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
const RETRY = "Retry failed card payments overnight";
const PHONE = { width: 390, height: 844 };
const KR = /in every region we sell in$/;

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
  // A regression guard: the phone sheet already scrolled when this was written.
  // protects=the same on a phone's sheet; fails_when=Save cannot be scrolled into view;
  // no_claim=the sheet's drag.
  await page.setViewportSize(PHONE);
  await start(page);
  await row(page, EXPORT).click();
  await expect(page.getByTestId("outcome-sheet")).toBeVisible();
  await saveReachable(page, page.getByTestId("outcome-sheet"));
});

for (const phone of [false, true]) {
  const on = phone ? " on a 390 phone" : "";

  test(`Why reads as a label and left-aligned text that wraps${on}`, async ({ page }) => {
    // protects=the Why label shows whole, long Why text wraps inside the panel and short Why text
    // starts at the left; fails_when=the label shrinks to "W…", the text is cut at the right edge
    // or sits right-aligned; no_claim=how Why is written (the form).
    if (phone) await page.setViewportSize(PHONE);
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

    // On a phone the sheet covers the table: close it first.
    if (phone) await page.keyboard.press("Escape");
    await row(page, TAX).click();
    const short = inspector(page).getByTestId("outcome-why");
    await expect(short).toHaveText("Fewer carts left");
    const [s, p] = [await box(short), await box(inspector(page))];
    expect(s.x - p.x).toBeLessThan(40);
  });

  test(`the goal picker and the Metric line stay inside the panel, the full names on hover${on}`, async ({ page }) => {
    // protects=a long key result name and its metric wrap or truncate within the panel, each with
    // its full name in a title; fails_when=either runs past the panel's right edge;
    // no_claim=the picker's choices (outcomes-goal).
    if (phone) await page.setViewportSize(PHONE);
    await start(page);
    await row(page, TAX).click();
    const panel = inspector(page);
    const goal = panel.getByLabel("Goal");
    await expect(goal).toBeVisible();
    await inside(goal, panel);
    await expect(goal).toHaveAttribute("title", KR);
    const metric = panel.getByTestId("outcome-metric");
    await inside(metric, panel);
    await expect(metric).toHaveAttribute("title", /net of refunds/);
  });
}

test("on a 390 phone a long goal name and Metric wrap whole inside the sheet", async ({ page }) => {
  // protects=on a phone the goal's name (read-only for a viewer) and the Metric line wrap onto
  // more lines inside the sheet, never cut with "…"; fails_when=either is one line cut short;
  // no_claim=the picker an editor gets (a select, one line).
  await page.setViewportSize(PHONE);
  await start(page, "viewer");
  await row(page, TAX).click();
  const panel = inspector(page);
  const goal = panel.getByText(KR);
  const metric = panel.getByTestId("outcome-metric");
  for (const l of [goal, metric]) {
    await expect(l).toBeVisible();
    await inside(l, panel);
    expect(await l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect((await box(l)).height).toBeGreaterThan(30);
  }
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

test("a goal with no metric shows no Goal metric (i)", async ({ page }) => {
  // protects=an outcome in its own unit moved to a goal with a unit but no metric keeps its own
  // measure and offers no (i) for the goal's metric; fails_when="About Goal metric" opens on
  // "Not set yet"; no_claim=the API (test_outcome_goal_change.py).
  await start(page);
  await row(page, MOVE).click();
  await inspector(page).getByTestId("outcome-goal").selectOption({ label: "Quicker setup for every team" });
  await expect(row(page, MOVE)).toContainText("Quicker setup for every team");
  await expect(inspector(page).getByTestId("outcome-metric")).toHaveText("Done (% of the work)");
  await expect(inspector(page).getByRole("button", { name: "About Goal metric" })).toHaveCount(0);
});

test("the Inbox reads a figure of 1 in the singular, as the Outcomes page", async ({ page }) => {
  // protects=an outcome check due read at 1 event says "now 1 event" in the Inbox, from the
  // shared goal figure the API writes too; fails_when="now 1 events"; no_claim=other languages.
  await start(page);
  await row(page, RETRY).click();
  await expect(inspector(page)).toContainText("Now 1 event");
  await page.goto("/inbox");
  const need = page.getByTestId("outcome-need").filter({ hasText: RETRY });
  await expect(need).toHaveAttribute("title", /, now 1 event$/);
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

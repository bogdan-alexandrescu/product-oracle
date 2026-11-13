import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * An item whose Goal map milestone sits under a goal has that goal everywhere: the Roadmap
 * (grouped by goal, and under its Goal filter), Priorities' Goal buckets, and its own panel.
 * Mock default scenario (invented data): "One-tap sign-up link" serves "25 sign-ups per rep",
 * a milestone of the goal "Sign-ups per rep per day"; it has no goal of its own on the roadmap.
 * "Alert rules engine" has its own goal (Grow retention) and must stay out of the sign-ups views.
 */

const FEATURE = "One-tap sign-up link";
const OTHER = "Alert rules engine";
const OTHER_GOAL = "Grow retention";

const tap = async (l: Locator) => {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
};

/** The goal the Goal map's own feature panel reads for the feature, as a person sees it. */
async function goalInPanel(page: Page): Promise<string> {
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  const chip = page.getByTestId("gm-chip").filter({ hasText: FEATURE }).first();
  await tap(chip.getByRole("button", { name: new RegExp(FEATURE) }).first());
  const panel = page.getByTestId("gm-feature-panel").getByTestId("floating-card");
  await expect(panel).toBeVisible();
  const goal = (await panel.getByTestId("card-goal").innerText()).trim();
  expect(goal).not.toBe("");
  await page.getByRole("button", { name: "Close the feature" }).click();
  await expect(page.getByTestId("gm-feature-panel")).toHaveCount(0);
  return goal;
}

/** The band (a track's name, else "No track") a Timeline row sits under: the nearest band header above it. */
const bandOf = (row: Locator) =>
  row.evaluate((el) => {
    let e = el.previousElementSibling;
    while (e && e.getAttribute("data-testid") !== "timeline-lane") e = e.previousElementSibling;
    const track = e?.querySelector('[data-testid="track-head"] button');
    return (track?.textContent ?? (e?.textContent ?? "").split(" · ")[0]).trim();
  });

test.describe("1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the goal its Goal map milestone sits under shows in the Roadmap, its Goal filter and Priorities' Goal buckets, as its panel reads it", async ({ page }) => {
    await login(page);
    const goal = await goalInPanel(page);
    expect(goal).toBe("Sign-ups per rep per day");

    // Roadmap (tb-mk: the Timeline's bands are tracks, so the Gantt grouped by goal checks the goal).
    await page.getByTestId("simple-nav-roadmap").first().click();
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    const row = page.locator('[data-testid="timeline-row"][data-item="gm-f1"]');
    await expect(row).toBeVisible();
    // tb-mk: its Timeline band is its track's, the one its panel reads (below).
    const band = await bandOf(row);
    expect(band).not.toBe("");
    // The Gantt's Group by Goal puts it under the same goal.
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    await page.getByTestId("group-goal").click();
    // The label shows the item's code with its name (Ground Truth rule): "F-101 One-tap sign-up link".
    const label = page.getByTestId("chart-label").filter({ has: page.getByTestId("label-title").getByText(`F-101 ${FEATURE}`, { exact: true }) });
    await expect(label).toBeVisible();
    // The regroup from track bands lands a frame after the press: read it once it has.
    await expect
      .poll(() =>
        label.evaluate((el) => {
          let e = el.parentElement!.previousElementSibling;
          while (e && e.getAttribute("data-testid") !== "chart-group") e = e.previousElementSibling;
          return (e?.querySelector("span")?.textContent ?? "").trim();
        }),
      )
      .toBe(goal);

    // The Roadmap's Goal filter: the goal lists the feature and leaves out one under another goal.
    await page.getByTestId("format-timeline").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
    await expect(page.locator('[data-testid="timeline-row"][data-item="alert-rules"]')).toBeVisible();
    await page.getByLabel("Goal", { exact: true }).selectOption({ label: goal });
    await expect(row).toBeVisible();
    await expect(page.locator('[data-testid="timeline-row"][data-item="alert-rules"]')).toHaveCount(0);
    await page.getByLabel("Goal", { exact: true }).selectOption({ label: OTHER_GOAL });
    await expect(page.locator('[data-testid="timeline-row"][data-item="alert-rules"]')).toBeVisible();
    await expect(row).toHaveCount(0);

    // Its Roadmap panel reads the same goal; a person moves it to Now on the board so Priorities plans it this quarter.
    await page.getByLabel("Goal", { exact: true }).selectOption({ label: goal });
    await page.getByTestId("format-board").click();
    await page.locator('[data-testid="board-card"][data-item="gm-f1"]').click();
    const card = page.getByTestId("floating-card");
    await expect(card.getByTestId("card-goal")).toHaveText(goal);
    await expect(card.getByTestId("card-track")).toContainText(band);
    await tap(card.getByTestId("card-horizon").getByRole("button", { name: "Now" }));
    await expect(page.locator('[data-testid="board-column"][data-horizon-column="now"] [data-testid="board-card"][data-item="gm-f1"]')).toBeVisible();

    // Priorities' Goal buckets: the feature is in the goal's bucket, not in another's.
    await page.getByTestId("simple-nav-priorities").first().click();
    await page.getByRole("tab", { name: "Goal buckets" }).click();
    const bucket = page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: goal, exact: true }) });
    await expect(bucket).toBeVisible();
    await expect(bucket.getByTestId("plan-feature").filter({ hasText: FEATURE })).toHaveCount(1);
    await expect(page.getByTestId("goal-bucket").filter({ hasText: FEATURE })).toHaveCount(1);
    await expect(bucket.getByTestId("plan-feature").filter({ hasText: OTHER })).toHaveCount(0);

    // Its panel from the bucket reads the same goal.
    await bucket.getByTestId("plan-feature").filter({ hasText: FEATURE }).getByTestId("plan-feature-open").click();
    await expect(page.getByTestId("item-panel").getByTestId("card-goal")).toHaveText(goal);
  });
});

import { GUARDRAIL_GOAL } from "../lib/api/mock/goal-map";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple Goal map, drawn as the goals by tracks grid (the owner's pick of Nov 11): three goals as
 * columns in priority order with no arrows between them, the guardrail, each goal's milestones in
 * the strip under it and each feature drawn once as a chip; adding a roadmap feature from a
 * milestone's menu and opening a feature's panel. Desktop (1440x900) and phone (390x844).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scenario?: string) {
  if (scenario) await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, ADMIN.email);
  await page.goto("/simple/home");
  await page.getByTestId("simple-nav-goals").first().click();
  await expect(page).toHaveURL(/\/simple\/goals$/);
  await expect(page.getByTestId("gm-page")).toBeVisible();
}

const chip = (page: Page, name: string) => page.getByTestId("gm-chip").filter({ hasText: name });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("reads the goals and the guardrail, with features drawn once", async ({ page }) => {
    // protects=the rail's Goal map opens the map: 3 goal columns with target, status and (behind
    // the (i)) math, the guardrail strip, a feature serving two milestones drawn as one chip;
    // fails_when=any is missing or a shared feature is drawn twice; no_claim=the API's math.
    await open(page);
    await expect(page.getByRole("heading", { name: "Goal map" })).toBeVisible();
    const goals = page.getByTestId("gm-goal");
    await expect(goals).toHaveCount(3);
    await expect(goals.nth(0)).toContainText("Sign-ups per rep per day");
    await expect(goals.nth(0)).toContainText("40");
    await expect(goals.nth(0)).toContainText("On track");
    await expect(goals.nth(1)).toContainText("At risk");
    await goals.nth(2).getByRole("button", { name: "About Revenue per day" }).click();
    await expect(page.getByRole("tooltip")).toContainText("Reps × conversions per rep × value");
    await expect(page.getByTestId("gm-guardrail")).toContainText("Guardrail: Customer complaints = 0 every day");
    await expect(page.getByTestId("gm-guardrail")).toContainText("Held 7 of 7 days");
    await expect(chip(page, "Guided first week")).toHaveCount(1);
  });

  test("attaches a roadmap feature not yet on the map from a milestone's menu", async ({ page }) => {
    // protects=a milestone's More › Add a feature opens the Add a feature drawer on that milestone;
    // the picker lists the roadmap's items, not only those on the map; the added feature shows as a
    // chip on that milestone; fails_when=a roadmap item cannot be found or added from the map;
    // no_claim=lift measurement.
    await open(page);
    const gate = strip(page, "50 sign-ups per rep");
    await gate.hover();
    await gate.getByRole("button", { name: /More for .*50 sign-ups per rep/ }).click();
    await page.getByRole("menuitem", { name: "Add a feature" }).click();
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Milestone").locator("option:checked")).toHaveText(/50 sign-ups per rep$/);
    await ed.getByLabel("Feature").fill("plan tiers");
    const pick = ed.getByTestId("gm-attach-list").getByRole("button", { name: /New plan tiers/ });
    await pick.click();
    await ed.getByLabel("Expected lift here").fill("+$20 each");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-editor")).toHaveCount(0);
    await expect(chip(page, "New plan tiers")).toHaveCount(1);
    await expect(chip(page, "New plan tiers")).toContainText("50 sign-ups per rep");
  });

  test("a feature opens Simple's item panel", async ({ page }) => {
    // protects=a feature chip opens Simple's one feature panel for it; fails_when=nothing opens;
    // no_claim=the panel's own edits (the roadmap specs).
    await open(page);
    await chip(page, "One-tap sign-up link").getByRole("button", { name: /^F-\d+\s*One-tap sign-up link/ }).click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
    await expect(page.getByTestId("floating-card").getByTestId("card-name")).toContainText("One-tap sign-up link");
  });

  test("the hard case: 5 areas, 12 milestones, a missed gate", async ({ page }) => {
    // protects=many milestones still read: all 12 in the strips, the missed one with its month-first
    // due date, revenue not measured yet; fails_when=any is missing; no_claim=the frames' pixels.
    await open(page, "goal-map-hard");
    await expect(page.getByTestId("gm-goal")).toHaveCount(3);
    await expect(page.getByTestId("gm-strip-milestone")).toHaveCount(12);
    await expect(page.getByTestId("gm-goal").nth(2)).toContainText("Not measured");
    await expect(strip(page, "8 paid conversions per rep")).toContainText("Oct 31");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("opens a feature on a phone", async ({ page }) => {
    // protects=the feature panel opens from a chip on a phone; fails_when=it cannot be reached;
    // no_claim=the panel's own edits.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await expect(page.getByTestId("gm-grid")).toBeVisible();
    await chip(page, "One-tap sign-up link").getByRole("button", { name: /^F-\d+\s*One-tap sign-up link/ }).click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
  });
});

/*
 * goal-map-no-arrows (BGD, Nov 5): the goal columns sit side by side in priority order with nothing
 * between them that reads as an order or a dependency, and a goal marked as a guardrail is never a
 * column: it shows only in the guardrail strip. Mock "goal-map-guardrail-goal" (the goals'
 * priorities and a guardrail goal, as the API reads them). 1440, light and dark (a phone scrolls
 * the grid sideways: goal-map-tracks-grid.spec.ts).
 */
for (const theme of ["light", "dark"] as const) {
  test.describe(`desktop ${theme}: goal cards`, () => {
    test.use(DESKTOP);

    test("no arrow between the goal cards; the guardrail goal only in its strip", async ({ page }) => {
      // protects=the goal cards in priority order with no arrow or "builds on" between them, the
      // guardrail goal in its strip and never a goal column; fails_when=an arrow or "Builds on"
      // shows, the cards keep the builds-on order, or the guardrail goal is a card;
      // no_claim=the API's order (test_simple_goal_map_api).
      await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
      await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-map-guardrail-goal"] as const);
      await login(page, ADMIN.email);
      await page.goto("/simple/goals");
      await expect(page.getByTestId("gm-page")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const cards = page.getByTestId("gm-goal");
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0)).toContainText("Revenue per day");
      await expect(cards.nth(1)).toContainText("Sign-ups per rep per day");
      await expect(cards.nth(2)).toContainText("Paid conversions per rep per day");
      for (let i = 0; i < 3; i++) await expect(cards.nth(i)).not.toContainText("Builds on");
      await expect(page.getByLabel("builds on")).toHaveCount(0);
      for (let i = 0; i < 3; i++) await expect(cards.nth(i)).not.toContainText(GUARDRAIL_GOAL);
      const rail = page.getByTestId("gm-guardrail");
      await expect(rail).toContainText(`Guardrail: ${GUARDRAIL_GOAL} = 0 every day`);
      await expect(rail).toContainText("Held 7 of 7 days");
      // Side by side on a desktop, one row, in priority order.
      const boxes = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
      expect(boxes.map((b) => Math.round(b.y))).toEqual(Array(3).fill(Math.round(boxes[0].y)));
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width - 1);
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width - 1);
    });
  });
}

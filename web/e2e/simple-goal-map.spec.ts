import { GUARDRAIL_GOAL } from "../lib/api/mock/goal-map";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Simple Goal map (goal-ladder), the owner's pick "the Goal map drawn as the ladder on a
 * pan-and-zoom canvas": three goals as columns in priority order with no arrows between them,
 * the guardrail, milestones as key-result cards with the work behind each drawn once; editing a
 * goal (its history kept), proposing a milestone, setting and confirming a gate, starting a New
 * PRD from a milestone and opening a feature's item panel. Desktop (1440x900) and phone (390x844).
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

/** Opens a milestone's (or goal's) "More" menu and clicks a menu item by its label. */
async function moreMenu(target: Locator, menuTestId: "ld-goal-menu" | "ld-ms-menu", item: string) {
  await target.getByTestId("ld-more").click();
  await target.page().getByTestId(menuTestId).getByRole("menuitem", { name: item }).click();
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("reads the goals and the guardrail, with features drawn once", async ({ page }) => {
    // protects=the rail's Goal map opens the map: 3 goal cards with reading, target, status and
    // math, the guardrail strip, features drawn once (the second place a note under its own
    // milestone); fails_when=any is missing or a shared feature is drawn twice; no_claim=the API's
    // math.
    await open(page);
    await expect(page.getByRole("heading", { name: "Goal map" })).toBeVisible();
    const goals = page.getByTestId("ld-goal");
    await expect(goals).toHaveCount(3);
    await expect(goals.nth(0)).toContainText("Sign-ups per rep per day");
    await expect(goals.nth(0)).toContainText("of 40");
    await expect(goals.nth(0)).toContainText("On track");
    await expect(goals.nth(1)).toContainText("At risk");
    await expect(goals.nth(2)).toContainText("Reps × conversions per rep × value");
    await expect(page.getByTestId("gm-guardrail")).toContainText("Guardrail: Customer complaints = 0 every day");
    await expect(page.getByTestId("gm-guardrail")).toContainText("0 today · held 7 of 7 days");
    const card = page.getByTestId("ld-feature").filter({ hasText: "Guided first week" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Also serves");
    await expect(page.getByText(/Guided first week · card under/)).toHaveCount(1);
  });

  test("edits a goal; its history keeps the old target", async ({ page }) => {
    // protects=Change the target on a goal saves a new target and the history lists the old one, by
    // whom; fails_when=the target is unchanged or the history lost; no_claim=milestone thresholds.
    await open(page);
    await page.getByTestId("ld-edit").click();
    const goalCard = page.getByTestId("ld-goal").nth(1);
    await moreMenu(goalCard, "ld-goal-menu", "Change the target");
    const ed = page.getByTestId("gm-editor");
    await expect(ed).toContainText("Edit goal: Paid conversions per rep per day");
    await ed.getByLabel("New target (at least, every day)").fill("12");
    await expect(ed).toContainText("10 → 12: its 3 milestones keep their own thresholds.");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Goal saved; its history keeps 10.");
    await expect(goalCard).toContainText("of 12");
    await moreMenu(goalCard, "ld-goal-menu", "Change the target");
    await expect(page.getByTestId("gm-editor")).toContainText("Target 10 → 12");
    await expect(page.getByTestId("gm-editor")).toContainText("Nov 3, 2026 · Avery Stone");
  });

  test("proposes a milestone: the new gate reads Proposed", async ({ page }) => {
    // protects=the form (name, goal, threshold, areas, after) adds a gate marked Proposed and says
    // who approves it; fails_when=no gate or not marked; no_claim=approval.
    await open(page);
    await page.getByTestId("ld-edit").click();
    await page.getByTestId("ld-column").nth(0).getByTestId("ld-add-milestone").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.locator("label", { hasText: "Scale per rep" }).click();
    await ed.locator("label", { hasText: "Onboarding & revenue" }).click();
    await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Proposed: 40 sign-ups per rep. Sent to Dana Whitlock to approve.");
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "40 sign-ups per rep" });
    await expect(gate).toContainText("Proposed");
    await expect(gate).toContainText("31 of 40");
  });

  test("Comes after: starts at Nothing, a pick orders the gate", async ({ page }) => {
    // protects=the propose form's Comes after picker starts at "Nothing: it can start now"
    // (gm1-a-open) and keeps it when the goal changes; a pick is saved; editing an existing gate's
    // Comes after changes what it reads after; fails_when=the picker is missing, read-only, starts
    // on a milestone or the change is not saved; no_claim=the API.
    await open(page);
    await page.getByTestId("ld-edit").click();
    await page.getByTestId("ld-column").nth(0).getByTestId("ld-add-milestone").click();
    let ed = page.getByTestId("gm-editor");
    const after = ed.getByLabel("Comes after");
    await expect(after.locator("option:checked")).toHaveText("Nothing: it can start now");
    await ed.getByLabel("Goal it moves").selectOption({ index: 2 });
    await expect(after.locator("option:checked")).toHaveText("Nothing: it can start now");
    await ed.getByLabel("Goal it moves").selectOption({ index: 0 });
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await after.selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    const fifty = page.getByTestId("ld-milestone").filter({ hasText: "50 sign-ups per rep" });
    await moreMenu(fifty, "ld-ms-menu", "Edit the gate");
    ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Comes after").locator("option:checked")).toHaveText("25 sign-ups per rep");
    await ed.getByLabel("Comes after").selectOption({ label: "40 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await moreMenu(fifty, "ld-ms-menu", "Edit the gate");
    await expect(page.getByTestId("gm-editor").getByLabel("Comes after").locator("option:checked")).toHaveText("40 sign-ups per rep");
  });

  test("a milestone with no gate yet reads no gate until its threshold is set", async ({ page }) => {
    // protects=a goal milestone added on the roadmap without a threshold shows no gate yet, never
    // Met, Proposed or "of 0"; setting the threshold gates it; fails_when=it reads met or "of 0";
    // no_claim=the roadmap's own milestone panel.
    await open(page, "goal-map-no-gate");
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "Sign-ups at every rep" });
    await expect(gate).toContainText("Reads");
    await expect(gate).toContainText("no gate yet");
    await expect(gate).not.toContainText("Met");
    await expect(gate).not.toContainText("Proposed");
    await expect(gate).not.toContainText(" of 0");
    await page.getByTestId("ld-edit").click();
    await moreMenu(gate, "ld-ms-menu", "Edit the gate");
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByTestId("gm-save")).toBeDisabled();
    await ed.getByLabel("At least").fill("60");
    await ed.getByLabel("Confirm this gate").check();
    await ed.getByTestId("gm-save").click();
    await expect(gate).toContainText("31 of 60");
    await expect(gate).not.toContainText("no gate yet");
  });

  test("attaches a roadmap feature not yet on the map from a milestone's menu", async ({ page }) => {
    // protects=Edit ladder › a milestone's More › Attach a feature… opens the attach drawer on that
    // milestone; the picker lists the roadmap's items, not only those on the map; the attached
    // feature shows under the milestone; fails_when=a roadmap item cannot be found or attached
    // from the ladder; no_claim=lift measurement.
    await open(page);
    await page.getByTestId("ld-edit").click();
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "50 sign-ups per rep" });
    await moreMenu(gate, "ld-ms-menu", "Attach a feature…");
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Milestone").locator("option:checked")).toHaveText("50 sign-ups per rep");
    await ed.getByLabel("Feature").fill("plan tiers");
    const pick = ed.getByRole("button", { name: /New plan tiers/ });
    await expect(pick).toContainText("Not on the map yet");
    await pick.click();
    await ed.getByLabel("Expected lift here").fill("+$20 each");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Attached: New plan tiers now also serves 50 sign-ups per rep.");
    await expect(page.getByTestId("ld-group").filter({ hasText: "50 sign-ups per rep" }).getByTestId("ld-feature").filter({ hasText: "New plan tiers" })).toHaveCount(1);
  });

  test("sets and confirms a proposed milestone's gate", async ({ page }) => {
    // protects=a proposed gate's threshold is set and confirmed in the map (it is no longer only
    // proposed and names who confirmed it); fails_when=there is no way to set or confirm it;
    // no_claim=the 7 days, read from the goal.
    await open(page);
    await page.getByTestId("ld-edit").click();
    await page.getByTestId("ld-column").nth(0).getByTestId("ld-add-milestone").click();
    let ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.getByTestId("gm-save").click();
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "40 sign-ups per rep" });
    await expect(gate).toContainText("Proposed");
    await moreMenu(gate, "ld-ms-menu", "Set and confirm the gate");
    ed = page.getByTestId("gm-editor");
    await expect(ed).toContainText("The gate of 40 sign-ups per rep");
    await ed.getByLabel("At least").fill("35");
    await ed.getByLabel("Confirm this gate").check();
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Gate confirmed: 40 sign-ups per rep, at least 35 for 7 days.");
    await expect(gate).not.toContainText("Proposed");
    await expect(gate).toContainText("31 of 35");
    await moreMenu(gate, "ld-ms-menu", "Edit the gate");
    await expect(page.getByTestId("gm-editor")).toContainText("Confirmed by Avery Stone, Nov 3.");
  });

  test("starts a New PRD from a milestone: Simple's New PRD form opens prefilled", async ({ page }) => {
    // protects=New PRD from it on a milestone opens the New PRD form prefilled with that milestone
    // and lets areas be picked, with its name and problem filled in; fails_when=the form is empty or
    // does not open; no_claim=the intake.
    await open(page);
    await page.getByTestId("ld-edit").click();
    const gate = page.getByTestId("ld-milestone").filter({ hasText: "6 paid conversions per rep" });
    await moreMenu(gate, "ld-ms-menu", "New PRD from it");
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Milestone").locator("option:checked")).toHaveText("6 paid conversions per rep");
    await ed.locator("label", { hasText: "Customer safety" }).click();
    await expect(ed).toContainText("the guardrail (customer complaints = 0 every day)");
    await ed.getByTestId("gm-save").click();
    const sheet = page.getByRole("dialog", { name: /New PRD/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox").first()).toHaveValue("6 paid conversions per rep");
    await expect(sheet.getByRole("textbox").nth(1)).toHaveValue(/Areas: Customer safety\./);
  });

  test("a feature opens Simple's item panel", async ({ page }) => {
    // protects=selecting a feature card then Open opens the roadmap's item panel for it;
    // fails_when=nothing opens; no_claim=the panel's own edits (the roadmap specs).
    await open(page);
    const card = page.getByTestId("ld-feature").filter({ hasText: "One-tap sign-up link" });
    await card.click();
    await card.getByTestId("ld-open").click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
    await expect(page.getByTestId("gm-feature-panel").getByRole("button", { name: /Close/ }).first()).toBeVisible();
  });

  test("the hard case: 5 areas, 12 milestones, a missed gate", async ({ page }) => {
    // protects=many areas and milestones still read: a missed gate red with its due date, revenue
    // too early to measure; fails_when=any is missing; no_claim=the frames' pixels.
    await open(page, "goal-map-hard");
    await expect(page.getByTestId("ld-goal")).toHaveCount(3);
    await expect(page.getByTestId("ld-milestone")).toHaveCount(12);
    await expect(page.getByTestId("ld-goal").nth(2)).toContainText("Too early");
    const missed = page.getByTestId("ld-milestone").filter({ hasText: "8 paid conversions per rep" });
    await expect(missed).toContainText("Missed");
    await expect(missed).toContainText("by Oct 31");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("reads the map as a phone list and proposes a milestone", async ({ page }) => {
    // protects=on a phone the goals show one at a time with their milestones and work listed below;
    // propose works from the phone; fails_when=the canvas shows or a milestone is missing;
    // no_claim=desktop layout.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await expect(page.getByTestId("ld-goal")).toHaveCount(1);
    await expect(page.getByTestId("ld-canvas")).toHaveCount(0);
    const phone = page.getByTestId("ld-phone");
    await expect(phone.getByTestId("ld-milestone")).toHaveCount(2);
    await expect(phone.getByTestId("ld-milestone").first()).toContainText("25 sign-ups per rep");
    await page.getByTestId("ld-edit").click();
    await phone.getByTestId("ld-add-milestone").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await expect(ed.getByLabel("Comes after").locator("option:checked")).toHaveText("Nothing: it can start now");
    await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Proposed: 40 sign-ups per rep.");
    await expect(phone.getByTestId("ld-milestone")).toHaveCount(3);
    await expect(phone.getByTestId("ld-milestone").filter({ hasText: "40 sign-ups per rep" })).toContainText("Proposed");
  });

  test("edits a goal and opens a feature on a phone", async ({ page }) => {
    // protects=Edit and the feature panel work on a phone; fails_when=either cannot be reached;
    // no_claim=the panel's own edits.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await page.getByTestId("ld-edit").click();
    const phone = page.getByTestId("ld-phone");
    await moreMenu(phone.getByTestId("ld-goal"), "ld-goal-menu", "Change the target");
    await page.getByTestId("gm-editor").getByLabel("New target (at least, every day)").fill("45");
    await page.getByTestId("gm-editor").getByTestId("gm-save").click();
    await expect(phone.getByTestId("ld-goal")).toContainText("of 45");
    await phone.getByTestId("ld-feature").filter({ hasText: "One-tap sign-up link" }).click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
  });

  test("starts a New PRD from a milestone on a phone", async ({ page }) => {
    // protects=New PRD from it, on a milestone's More menu, works on a phone and opens Simple's New
    // PRD form prefilled; fails_when=the menu item is out of reach or the form opens empty;
    // no_claim=the intake. Adding an area and attaching a feature from a cell sit in the removed
    // areas grid (see removed-tests.md), not on this frame.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await page.getByTestId("ld-edit").click();
    const phone = page.getByTestId("ld-phone");
    await phone.getByRole("tab", { name: "Goal 2" }).click();
    const gate = phone.getByTestId("ld-milestone").filter({ hasText: "6 paid conversions per rep" });
    await moreMenu(gate, "ld-ms-menu", "New PRD from it");
    const ed = page.getByTestId("gm-editor");
    await ed.locator("label", { hasText: "Customer safety" }).click();
    await ed.getByTestId("gm-save").click();
    const sheet = page.getByRole("dialog", { name: /New PRD/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox").first()).toHaveValue("6 paid conversions per rep");
    await expect(sheet.getByRole("textbox").nth(1)).toHaveValue(/Areas: Customer safety\./);
  });
});

/*
 * goal-map-no-arrows (BGD, Nov 5): the goal cards sit side by side in priority order with nothing
 * between them that reads as an order or a dependency, and a goal marked as a guardrail is never a
 * card: it shows only in the guardrail strip under them. Mock "goal-map-guardrail-goal" (the goals'
 * priorities and a guardrail goal, as the API reads them). 1440, light and dark (a phone shows one
 * goal at a time, never three stacked: see removed-tests.md).
 */
for (const theme of ["light", "dark"] as const) {
  test.describe(`desktop ${theme}: goal cards`, () => {
    test.use(DESKTOP);

    test("no arrow between the goal cards; the guardrail goal only in its strip", async ({ page }) => {
      // protects=the goal cards in priority order with no arrow or "builds on" between them, the
      // guardrail goal in its strip under them and never a card; fails_when=an arrow or "Builds on"
      // shows, the cards keep the builds-on order, or the guardrail goal is a card;
      // no_claim=the API's order (test_simple_goal_map_api).
      await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
      await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "goal-map-guardrail-goal"] as const);
      await login(page, ADMIN.email);
      await page.goto("/simple/goals");
      await expect(page.getByTestId("gm-page")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const cards = page.getByTestId("ld-goal");
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(0)).toContainText("Revenue per day");
      await expect(cards.nth(1)).toContainText("Sign-ups per rep per day");
      await expect(cards.nth(2)).toContainText("Paid conversions per rep per day");
      for (let i = 0; i < 3; i++) await expect(cards.nth(i)).not.toContainText("Builds on");
      await expect(page.getByLabel("builds on")).toHaveCount(0);
      for (let i = 0; i < 3; i++) await expect(cards.nth(i)).not.toContainText(GUARDRAIL_GOAL);
      const strip = page.getByTestId("gm-guardrail");
      await expect(strip).toContainText(`Guardrail: ${GUARDRAIL_GOAL} = 0 every day`);
      await expect(strip).toContainText("0 today · held 7 of 7 days");
      // Side by side on a desktop, one row, in priority order.
      const boxes = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
      expect(boxes.map((b) => Math.round(b.y))).toEqual(Array(3).fill(Math.round(boxes[0].y)));
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width - 1);
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width - 1);
    });
  });
}

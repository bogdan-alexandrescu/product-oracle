import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple Goal map (build-goal-map), the owner's pick "Ladder by area lanes", driven through the
 * UI against the mock (invented data): three goals joined by arrows, the guardrail, milestones
 * by area with their 7 days of proof, features drawn once; adding and reordering an area,
 * editing a goal (its history kept), proposing a milestone, attaching a feature, starting a New
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

// The phone list sits in the page too (hidden past 600px): desktop checks read the ladder only.
const ladder = (page: Page) => page.getByTestId("gm-ladder");
const lanes = (page: Page) => page.getByTestId("gm-lane").locator("span.font-semibold");

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("reads the goals, the guardrail and milestones by area", async ({ page }) => {
    // protects=the rail's Goal map opens the map: 3 goal cards with reading, target, status and math,
    // the guardrail strip, gates with reading, status and proof, features drawn once (the second place
    // a note); fails_when=any is missing or a shared feature is drawn twice; no_claim=the API's math.
    await open(page);
    await expect(page.getByRole("heading", { name: "Goal map" })).toBeVisible();
    const goals = page.getByTestId("gm-goal");
    await expect(goals).toHaveCount(3);
    await expect(goals.nth(0)).toContainText("Sign-ups per rep per day");
    await expect(goals.nth(0)).toContainText("of 40 a day");
    await expect(goals.nth(0)).toContainText("On track");
    await expect(goals.nth(1)).toContainText("At risk");
    await expect(goals.nth(2)).toContainText("$11.2k");
    await expect(goals.nth(2)).toContainText("Builds on paid conversions per rep per day");
    await expect(page.getByTestId("gm-guardrail")).toContainText("Guardrail: Customer complaints = 0 every day");
    await expect(page.getByTestId("gm-guardrail")).toContainText("0 today · held 7 of 7 days");
    await expect(page.getByTestId("gm-ladder")).toContainText("3 of 7 steps shown at a time");
    const gate = ladder(page).getByTestId("gm-gate").filter({ hasText: "25 sign-ups per rep" }).filter({ hasText: "Step 1 ·" });
    await expect(gate).toContainText("Step 1 · due Oct", { ignoreCase: true });
    await expect(gate).toContainText("Met");
    await expect(gate).toContainText("Held 7 days in a row on a live rep · confirmed by Dana Whitlock, Nov 2");
    await expect(lanes(page)).toHaveText(["1. Scale per rep", "2. Customer safety", "3. Conversions (incl. new channels)", "4. Onboarding & revenue"]);
    await expect(ladder(page).getByTestId("gm-feature").filter({ hasText: "Guided first week" })).toHaveCount(1);
    await expect(ladder(page).getByTestId("gm-feature-also").filter({ hasText: "Guided first week" })).toContainText("its card is under 50 sign-ups per rep");
    await expect(ladder(page).getByTestId("gm-feature").filter({ hasText: "Rep call script hints" })).toContainText("Not helping");
  });

  test("adds an area and moves it up; the order holds after a reload", async ({ page }) => {
    // protects=Add an area puts it last; Move up changes the rows; the order is saved; fails_when=the
    // new area is missing or the order is lost on reload; no_claim=other pages' use of the order.
    await open(page);
    await page.getByTestId("gm-add-area").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("Rep hiring");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Area added: Rep hiring");
    await expect(lanes(page).last()).toHaveText("5. Rep hiring");
    await page.getByRole("button", { name: "Move Rep hiring up" }).click();
    await expect(lanes(page).nth(3)).toHaveText("4. Rep hiring");
    await page.getByRole("button", { name: "Move Scale per rep down" }).click();
    await expect(lanes(page).nth(0)).toHaveText("1. Customer safety");
    await page.waitForTimeout(300);
    await page.reload();
    await expect(lanes(page)).toHaveText(["1. Customer safety", "2. Scale per rep", "3. Conversions (incl. new channels)", "4. Rep hiring", "5. Onboarding & revenue"]);
  });

  test("edits a goal; its history keeps the old target", async ({ page }) => {
    // protects=Edit on a goal saves a new target and the history lists the old one, by whom;
    // fails_when=the target is unchanged or the history lost; no_claim=milestone thresholds.
    await open(page);
    await page.getByTestId("gm-goal").nth(1).getByTestId("gm-edit-goal").click();
    const ed = page.getByTestId("gm-editor");
    await expect(ed).toContainText("Edit goal: Paid conversions per rep per day");
    await ed.getByLabel("New target (at least, every day)").fill("12");
    await expect(ed).toContainText("10 → 12: its 3 milestones keep their own thresholds.");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Goal saved; its history keeps 10.");
    await expect(page.getByTestId("gm-goal").nth(1)).toContainText("of 12 a day");
    await page.getByTestId("gm-goal").nth(1).getByTestId("gm-edit-goal").click();
    await expect(page.getByTestId("gm-editor")).toContainText("Target 10 → 12");
    await expect(page.getByTestId("gm-editor")).toContainText("Nov 3, 2026 · Avery Stone");
  });

  test("proposes a milestone: a dashed Proposed column in its step", async ({ page }) => {
    // protects=the form (name, goal, threshold, areas, after) adds a Proposed gate at its step with
    // today's 7 days and says who approves it; fails_when=no gate or not marked; no_claim=approval.
    await open(page);
    await page.getByTestId("gm-propose").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.locator("label", { hasText: "Scale per rep" }).click();
    await ed.locator("label", { hasText: "Onboarding & revenue" }).click();
    await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Proposed: 40 sign-ups per rep. Sent to Dana Whitlock to approve.");
    const gate = page.locator('[data-testid="gm-gate"][data-proposed="1"]');
    await expect(gate).toContainText("40 sign-ups per rep");
    await expect(gate).toContainText("Proposed");
    await expect(gate).toContainText("Step 2", { ignoreCase: true });
    await expect(gate).toContainText("31 of 40 · After 25 sign-ups per rep");
    await expect(page.getByTestId("gm-ladder")).toContainText("3 of 8 steps shown at a time");
  });

  test("attaches a feature from a cell; it is drawn once with a note in its new place", async ({ page }) => {
    // protects=Attach a feature in a cell links a feature to that milestone; the card stays one and
    // names both milestones; fails_when=a second card or no link; no_claim=lift measurement.
    await open(page);
    await page.getByTestId("gm-attach").first().click();
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Milestone")).toHaveValue(/.+/);
    await ed.getByLabel("Milestone").selectOption({ label: "10 paid conversions per rep" });
    await ed.getByLabel("Feature").fill("trial");
    await ed.getByRole("button", { name: /Trial reminder texts/ }).click();
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Attached: Trial reminder texts now also serves 10 paid conversions per rep.");
    const card = ladder(page).getByTestId("gm-feature").filter({ hasText: "Trial reminder texts" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Also serves 10 paid conversions per rep");
    await expect(ladder(page).getByTestId("gm-feature-also").filter({ hasText: "Trial reminder texts" })).toHaveCount(1);
  });

  test("starts a New PRD from a milestone: Simple's New PRD form opens prefilled", async ({ page }) => {
    // protects=New PRD from a milestone, a picked milestone and areas, opens the New PRD form with its
    // name and problem filled in; fails_when=the form is empty or does not open; no_claim=the intake.
    await open(page);
    await page.getByTestId("gm-new-prd").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Milestone").selectOption({ label: "6 paid conversions per rep" });
    await ed.locator("label", { hasText: "Customer safety" }).click();
    await expect(ed).toContainText("the guardrail (customer complaints = 0 every day)");
    await ed.getByTestId("gm-save").click();
    const sheet = page.getByRole("dialog", { name: /New PRD/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox").first()).toHaveValue("6 paid conversions per rep");
    await expect(sheet.getByRole("textbox").nth(1)).toHaveValue(/Areas: Customer safety\./);
  });

  test("a feature opens Simple's item panel", async ({ page }) => {
    // protects=clicking a feature card opens the roadmap's item panel for it; fails_when=nothing opens;
    // no_claim=the panel's own edits (the roadmap specs).
    await open(page);
    await ladder(page).getByTestId("gm-feature").filter({ hasText: "One-tap sign-up link" }).click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
    await expect(page.getByTestId("gm-feature-panel").getByRole("button", { name: /Close/ }).first()).toBeVisible();
  });

  test("the hard case: 5 areas, 12 steps, a missed gate", async ({ page }) => {
    // protects=many areas and steps still read: 3 of 12 steps, the missed gate red with its due date,
    // revenue not measured yet; fails_when=any is missing; no_claim=the frames' pixels.
    await open(page, "goal-map-hard");
    await expect(page.getByTestId("gm-ladder")).toContainText("3 of 12 steps shown at a time");
    await expect(lanes(page)).toHaveCount(5);
    await expect(page.getByTestId("gm-goal").nth(2)).toContainText("Not measured yet");
    const missed = page.locator('[data-testid="gm-gate"]', { hasText: "8 paid conversions per rep" });
    await expect(missed).toContainText("Missed");
    await expect(missed).toContainText("Due Oct 31 · held 0 of 7 days");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("reads the map as a list of milestones and proposes one", async ({ page }) => {
    // protects=on a phone the goals stack, the lanes grid is hidden and the milestones list one by one
    // with their proof, areas and features; propose works from the phone; fails_when=the grid shows
    // or a milestone is missing; no_claim=desktop layout.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await expect(page.getByTestId("gm-goal")).toHaveCount(3);
    await expect(page.getByTestId("gm-ladder")).toBeHidden();
    const list = page.getByTestId("gm-ladder-phone");
    await expect(list.getByRole("heading", { name: "Milestones, in steps" })).toBeVisible();
    await expect(list.locator(".simple-card")).toHaveCount(7);
    await expect(list.locator(".simple-card").first()).toContainText("25 sign-ups per rep");
    await expect(list).toContainText("1. Scale per rep");
    await page.getByTestId("gm-propose").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Proposed: 40 sign-ups per rep.");
    await expect(list.locator(".simple-card")).toHaveCount(8);
  });

  test("edits a goal and opens a feature on a phone", async ({ page }) => {
    // protects=Edit and the feature panel work on a phone; fails_when=either cannot be reached;
    // no_claim=the panel's own edits.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await page.getByTestId("gm-goal").first().getByTestId("gm-edit-goal").click();
    await page.getByTestId("gm-editor").getByLabel("New target (at least, every day)").fill("45");
    await page.getByTestId("gm-editor").getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-goal").first()).toContainText("of 45 a day");
    await page.getByTestId("gm-ladder-phone").getByTestId("gm-feature").filter({ hasText: "One-tap sign-up link" }).click();
    await expect(page.getByTestId("gm-feature-panel")).toBeVisible();
  });
});

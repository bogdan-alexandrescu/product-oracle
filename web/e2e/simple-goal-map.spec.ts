import { GUARDRAIL_GOAL } from "../lib/api/mock/goal-map";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Simple Goal map (build-goal-map), the owner's pick "Ladder by area lanes", driven through the
 * UI against the mock (invented data): three goals side by side with no arrows, the guardrail, milestones
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
// A gate by its own name (its title), not by the name of the one it comes after.
const gateNamed = (page: Page, name: string) => ladder(page).getByTestId("gm-gate").filter({ has: page.getByTestId("gm-edit-gate").filter({ hasText: name }) });
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
    await expect(goals.nth(2)).toContainText("Reps × conversions per rep × value");
    await expect(goals.nth(2)).not.toContainText("Builds on");
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

  test("attaches a roadmap feature not yet on the map, filed under the cell's area", async ({ page }) => {
    // protects=the picker lists the roadmap's items, not only those on the map; the cell's area goes
    // with it; the lift typed is this link's; fails_when=a roadmap item cannot be found, or it lands
    // in another area; no_claim=lift measurement.
    await open(page);
    const row = ladder(page).getByTestId("gm-lane").filter({ hasText: "Onboarding & revenue" });
    await expect(row).toHaveCount(1);
    // The cell of Onboarding & revenue under 50 sign-ups per rep: its Attach button.
    const gate = ladder(page).getByTestId("gm-gate").filter({ has: page.getByText("50 sign-ups per rep", { exact: true }) });
    const gx = (await gate.boundingBox())!.x;
    const ry = (await row.boundingBox())!.y;
    const attach = ladder(page).getByTestId("gm-attach");
    let hit = -1;
    for (let i = 0; i < (await attach.count()); i++) {
      const b = (await attach.nth(i).boundingBox())!;
      if (b.x >= gx && b.x < gx + 240 && b.y >= ry) {
        hit = i;
        break;
      }
    }
    expect(hit).toBeGreaterThanOrEqual(0);
    await attach.nth(hit).click();
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Milestone").locator("option:checked")).toHaveText("50 sign-ups per rep");
    await expect(ed.getByLabel("Area").locator("option:checked")).toHaveText("Onboarding & revenue");
    await ed.getByLabel("Feature").fill("plan tiers");
    const pick = ed.getByRole("button", { name: /New plan tiers/ });
    await expect(pick).toContainText("Not on the map yet");
    await pick.click();
    await ed.getByLabel("Expected lift here").fill("+$20 each");
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Attached: New plan tiers now also serves 50 sign-ups per rep.");
    const card = ladder(page).getByTestId("gm-feature").filter({ hasText: "New plan tiers" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("+$20 each");
    // Read after the page scrolled to the card: it sits in the Onboarding & revenue row.
    const cy = (await card.boundingBox())!.y;
    const top = (await row.boundingBox())!;
    expect(cy).toBeGreaterThanOrEqual(top.y);
    expect(cy).toBeLessThan(top.y + top.height);
  });

  test("Comes after: starts at Nothing, a pick orders the steps", async ({ page }) => {
    // protects=the propose form's Comes after picker starts at "Nothing: it can start now" (gm1-a-open)
    // and keeps it when the goal changes; a pick is saved; the gate edit changes it and the steps
    // follow; fails_when=the picker is missing, read-only, starts on a milestone or the order ignores
    // it; no_claim=the API.
    await open(page);
    await page.getByTestId("gm-propose").click();
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
    const fresh = ladder(page).locator('[data-testid="gm-gate"][data-proposed="1"]');
    await expect(fresh).toContainText("Step 2");
    await expect(fresh).toContainText("After 25 sign-ups per rep");
    const fifty = gateNamed(page, "50 sign-ups per rep");
    await expect(fifty).toContainText("Step 2");
    await fifty.getByTestId("gm-edit-gate").click();
    ed = page.getByTestId("gm-editor");
    await expect(ed.getByLabel("Comes after").locator("option:checked")).toHaveText("25 sign-ups per rep");
    await ed.getByLabel("Comes after").selectOption({ label: "40 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(fifty).toContainText("Step 3");
    await expect(fifty).toContainText("After 40 sign-ups per rep");
  });

  test("a milestone with no gate yet reads No gate yet until its threshold is set", async ({ page }) => {
    // protects=a goal milestone added on the roadmap without a threshold shows No gate yet, never Met,
    // Proposed or "31 of 0"; setting the threshold gates it; fails_when=it reads met or "of 0";
    // no_claim=the roadmap's own milestone panel.
    await open(page, "goal-map-no-gate");
    const gate = ladder(page).getByTestId("gm-gate").filter({ hasText: "Sign-ups at every rep" });
    await expect(gate).toContainText("No gate yet");
    await expect(gate).toContainText("31 now · no gate yet");
    await expect(gate).not.toContainText("Met");
    await expect(gate).not.toContainText("Proposed");
    await expect(gate).not.toContainText(" of 0");
    await gate.getByTestId("gm-edit-gate").click();
    const ed = page.getByTestId("gm-editor");
    await expect(ed.getByTestId("gm-save")).toBeDisabled();
    await ed.getByLabel("At least").fill("60");
    await ed.getByLabel("Confirm this gate").check();
    await ed.getByTestId("gm-save").click();
    await expect(gate).toContainText("31 of 60");
    await expect(gate).not.toContainText("No gate yet");
  });

  test("a feature card shows what it is expected to do for the milestone of its cell", async ({ page }) => {
    // protects=a feature serving two milestones with different expected lifts shows, under each,
    // that milestone's own; fails_when=the card shows another milestone's lift; no_claim=measuring.
    await open(page);
    const card = ladder(page).getByTestId("gm-feature").filter({ hasText: "Annual plan offer" });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Expects +$90 each (medium confidence)");
    await expect(card).not.toContainText("+$60");
  });

  test("attached from another area's cell, a feature moves there and the drawer says so", async ({ page }) => {
    // protects=a feature filed under one area, attached from another area's cell, is told to move and
    // then sits in the new area; fails_when=the drawer shows the new area while it stays in the old;
    // no_claim=lift.
    await open(page);
    await page.getByTestId("gm-attach").first().click();
    let ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Milestone").selectOption({ label: "10 paid conversions per rep" });
    await ed.getByLabel("Area").selectOption({ label: "Onboarding & revenue" });
    await ed.getByLabel("Feature").fill("trial");
    await ed.getByRole("button", { name: /Trial reminder texts/ }).click();
    await expect(ed.getByTestId("gm-attach-moves")).toHaveText(
      "Trial reminder texts is filed under Conversions (incl. new channels): attached here, it moves to Onboarding & revenue.",
    );
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Attached: Trial reminder texts");
    await page.getByTestId("gm-attach").first().click();
    ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Milestone").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByLabel("Feature").fill("trial");
    await expect(ed.getByRole("button", { name: /Trial reminder texts/ })).toContainText("Onboarding & revenue · serves");
  });

  test("sets and confirms a proposed milestone's gate", async ({ page }) => {
    // protects=a proposed gate's threshold is set and confirmed in the map (it is no longer only
    // proposed and names who confirmed it); fails_when=there is no way to set or confirm it;
    // no_claim=the 7 days, read from the goal.
    await open(page);
    await page.getByTestId("gm-propose").click();
    let ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Name").fill("40 sign-ups per rep");
    await ed.getByLabel("Met when the reading is at least").fill("40");
    await ed.getByTestId("gm-save").click();
    const gate = gateNamed(page, "40 sign-ups per rep");
    await expect(gate).toContainText("Proposed");
    await gate.getByTestId("gm-edit-gate").click();
    ed = page.getByTestId("gm-editor");
    await expect(ed).toContainText("The gate of 40 sign-ups per rep");
    await ed.getByLabel("At least").fill("35");
    await ed.getByLabel("Confirm this gate").check();
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toHaveText("Gate confirmed: 40 sign-ups per rep, at least 35 for 7 days.");
    await expect(gate).not.toContainText("Proposed");
    await expect(gate).toContainText("31 of 35");
    await gate.getByTestId("gm-edit-gate").click();
    await expect(page.getByTestId("gm-editor")).toContainText("Confirmed by Avery Stone, Nov 3.");
  });

  test("the ladder's head and goal cards as the frame: the step hint on its own line, the top goal widest", async ({ page }) => {
    // protects=the review's frame match: title and subtitle on one line, the step hint below them;
    // the first goal's title wraps and the third card is the widest; fails_when=the hint shares the
    // title's line or the cards are sized otherwise; no_claim=colours.
    await open(page);
    const head = ladder(page).getByTestId("gm-ladder-head");
    const h2 = (await head.getByRole("heading", { name: "Milestones by area" }).boundingBox())!;
    const sub = (await head.getByText("Left to right in steps").boundingBox())!;
    const hint = (await head.getByTestId("gm-step-hint").boundingBox())!;
    expect(sub.x).toBeGreaterThan(h2.x + h2.width);
    expect(hint.y).toBeGreaterThanOrEqual(h2.y + h2.height - 1);
    const cards = page.getByTestId("gm-goal");
    const w = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!.width));
    expect(w[2]).toBeGreaterThan(w[1]);
    expect(w[2]).toBeGreaterThan(w[0]);
    const title = (await cards.nth(0).getByText("Sign-ups per rep per day").boundingBox())!;
    expect(title.height).toBeGreaterThan(30);
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
    await expect(ed.getByLabel("Comes after").locator("option:checked")).toHaveText("Nothing: it can start now");
    await ed.getByLabel("Comes after").selectOption({ label: "25 sign-ups per rep" });
    await ed.getByTestId("gm-save").click();
    await expect(page.getByTestId("gm-flash")).toContainText("Proposed: 40 sign-ups per rep.");
    await expect(list.locator(".simple-card")).toHaveCount(8);
    await expect(list.locator(".simple-card").filter({ hasText: "40 sign-ups per rep" })).toContainText("After 25 sign-ups per rep");
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

  test("starts a New PRD from a milestone on a phone", async ({ page }) => {
    // protects=New PRD at the top works on a phone and opens Simple's New PRD form prefilled;
    // fails_when=the button is out of reach or the form opens empty; no_claim=the intake. Adding,
    // moving an area and Attach a feature sit in the desktop grid only, as the picked phone frame.
    await login(page, ADMIN.email);
    await page.goto("/simple/goals");
    await page.getByTestId("gm-new-prd").click();
    const ed = page.getByTestId("gm-editor");
    await ed.getByLabel("Milestone").selectOption({ label: "6 paid conversions per rep" });
    await ed.locator("label", { hasText: "Customer safety" }).click();
    await ed.getByTestId("gm-save").click();
    const sheet = page.getByRole("dialog", { name: /New PRD/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("textbox").first()).toHaveValue("6 paid conversions per rep");
    await expect(sheet.getByRole("textbox").nth(1)).toHaveValue(/Areas: Customer safety\./);
    await expect(page.getByTestId("gm-add-area")).toBeHidden();
  });
});

/*
 * goal-map-no-arrows (BGD, Nov 5): the goal cards sit side by side in priority order with nothing
 * between them that reads as an order or a dependency, and a goal marked as a guardrail is never a
 * card: it shows only in the guardrail strip under them. Mock "goal-map-guardrail-goal" (the goals'
 * priorities and a guardrail goal, as the API reads them). 1440 and 390, light and dark.
 */
for (const [name, size] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${name} ${theme}: goal cards`, () => {
      test.use(size);

      test("no arrow between the goal cards; the guardrail goal only in its strip", async ({ page }) => {
        // protects=the goal cards in priority order with no arrow or "builds on" between them, the
        // guardrail goal in its strip under them and never a card; fails_when=an arrow or "Builds on"
        // shows, the cards keep the builds-on order, or the guardrail goal is a card;
        // no_claim=the API's order (test_simple_goal_map_api).
        await page.context().addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
        await open(page, "goal-map-guardrail-goal");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const goals = page.getByTestId("gm-goals");
        const cards = page.getByTestId("gm-goal");
        await expect(cards).toHaveCount(3);
        await expect(cards.nth(0)).toContainText("Revenue per day");
        await expect(cards.nth(1)).toContainText("Sign-ups per rep per day");
        await expect(cards.nth(2)).toContainText("Paid conversions per rep per day");
        await expect(goals).not.toContainText("→");
        await expect(goals).not.toContainText("Builds on");
        await expect(goals.getByLabel("builds on")).toHaveCount(0);
        await expect(goals).not.toContainText(GUARDRAIL_GOAL);
        const strip = page.getByTestId("gm-guardrail");
        await expect(strip).toContainText(`Guardrail: ${GUARDRAIL_GOAL} = 0 every day`);
        await expect(strip).toContainText("0 today · held 7 of 7 days");
        const [g, r] = [(await goals.boundingBox())!, (await strip.boundingBox())!];
        expect(r.y).toBeGreaterThanOrEqual(g.y + g.height - 1);
        // Side by side on a desktop (one row); stacked on a phone, each the page's width.
        const boxes = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
        if (name === "desktop") {
          expect(boxes.map((b) => Math.round(b.y))).toEqual(Array(3).fill(Math.round(boxes[0].y)));
          expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width - 1);
          expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width - 1);
        } else {
          expect(boxes[1].y).toBeGreaterThan(boxes[0].y + boxes[0].height - 1);
          expect(boxes[2].y).toBeGreaterThan(boxes[1].y + boxes[1].height - 1);
        }
      });
    });
  }
}

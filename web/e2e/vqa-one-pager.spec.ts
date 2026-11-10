import { MOCK_SCENARIO_KEY, ONE_PAGER_PLAN_LOOSE_SCENARIO } from "../lib/api/mock/server";
import { WALK_PROBLEM } from "../lib/api/mock/simple-one-pager";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA of the one-pager (the mock's invented PRD "guided-setup"), driven through the UI.
 *
 * vqa one-pager 1: protects = a drawn flow stays with the bet it was drawn for when the PRD's
 * next version adds a bet above it ("one-pager-bet-added": every bet's line moved down one);
 * the new bet offers "Draw the flow"; fails_when = each bet shows the flow of the bet above it
 * (the new first bet shows "Finish setup from the checklist", the checklist bet none);
 * no_claim = the API's test_simple_bet_flow_versions.py.
 *
 * vqa one-pager 2 is in simple-one-pager-run-prd.spec.ts (an outcome's measure).
 *
 * vqa one-pager 3: protects = every milestone row of the Timeline strip reads its name: a
 * milestone record named only by its code ("M2") reads the name its own items give that code,
 * in one row ("one-pager-milestone-names"); fails_when = a row reads "Milestone M2 · 1 roadmap
 * item", or the record's items show as two rows of the same words;
 * no_claim = which code a row shows (an owner's decision).
 *
 * vqa-a: protects = a disagreement the PRD states twice ("Eight features wait for next quarter."
 * said again) is one "Needs a look" card; fails_when = "Numbers disagree in “Not this quarter”"
 * shows twice. no_claim = the API (api/tests/test_simple_one_pager_vqa.py).
 *
 * vqa-c: protects = "Who has it" names the people ("Studio leads"), never a note on how
 * sure the PRD is; fails_when = it reads "Low confidence".
 *
 * vqa-d: protects = a Problem line over 300 characters (shown cut, "Show all") is edited from its
 * whole words and reads the whole edited text after Save; fails_when = the edit is refused for
 * its length or the line keeps its cut "…".
 *
 * vqa-b: protects = a PRD whose plan has its own milestones lists each of its roadmap items with
 * no plan milestone in its When card, under "No milestone" at the card's end, and the item's
 * name opens its feature panel; the When slide of Present and a phone's timeline list it the same
 * way; fails_when = the item is on no part of the page, of the When slide or of the phone's timeline.
 */

const URL = "/simple/one-pagers/guided-setup";
const PRD_URL = "/simple/prds/guided-setup";

async function scenario(page: Page, s: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);
}

test("vqa one-pager 1: a drawn flow stays on its bet when a bet is added above it", async ({ page }) => {
  await scenario(page, "one-pager-bet-added");
  await login(page);
  await page.goto(URL);
  const bets = page.getByRole("region", { name: "What we will build" });
  await expect(bets.locator('[data-line="bets-1"]')).toContainText("Workspace templates for common teams");
  const checklist = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
  await expect(checklist).toContainText("Finish setup from the checklist");
  await expect(page.getByRole("button", { name: "Draw the flow for “A setup checklist" })).toHaveCount(0);
  // The new bet has no flow of its own: it offers to draw one, never the checklist's.
  await expect(page.getByRole("group", { name: "User flow of “Workspace templates for common" })).toHaveCount(0);
  await expect(bets.locator('[data-line="bets-1"]')).not.toContainText("Finish setup from the checklist");
  await expect(page.getByRole("button", { name: "Draw the flow for “Workspace templates for common" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw the flow for “Invite suggestions from the admin's" })).toBeVisible();
});

test("vqa one-pager 3: every milestone row of the Timeline strip reads its name", async ({ page }) => {
  await scenario(page, "one-pager-milestone-names");
  await login(page);
  await page.goto(URL);
  const labels = page.getByLabel("Timeline strip").getByTestId("plan-strip-label");
  await expect(labels).toHaveText([
    "M1 · Measured and mapped · 1 roadmap item",
    "M2 · Ship to beta · 2 roadmap items",
  ]);
});

test("vqa-b: the plan's When card lists the PRD's item with no plan milestone under No milestone", async ({ page }) => {
  // Owner, Nov 10 ('Add rows to the plan card'): the plan-led page shows every roadmap item of the PRD.
  await scenario(page, ONE_PAGER_PLAN_LOOSE_SCENARIO);
  await login(page);
  await page.goto(PRD_URL);
  const card = page.getByRole("region", { name: "Timeline" });
  await expect(card.getByRole("heading", { name: "When", exact: true })).toBeVisible();
  const group = card.getByTestId("timeline-no-milestone");
  await expect(group.getByRole("heading", { name: "No milestone" })).toBeVisible();
  // The group is the card's last part, after the milestones.
  await expect(card.locator(":scope > *").last()).toHaveAttribute("data-testid", "timeline-no-milestone");
  const rows = group.getByTestId("timeline-no-milestone-item");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("button", { name: "Calendar invite sync" })).toBeVisible();
  // Its name opens the feature's panel, as every feature does.
  await rows.getByRole("button", { name: "Calendar invite sync" }).click();
  const panel = page.getByRole("complementary", { name: "Calendar invite sync" });
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText("not on a roadmap you can see");
});

test("vqa-b: Present's When slide lists the PRD's item with no plan milestone under No milestone", async ({ page }) => {
  await scenario(page, ONE_PAGER_PLAN_LOOSE_SCENARIO);
  await login(page);
  await page.goto(PRD_URL);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.getByTestId("slides")).toBeVisible();
  // The When card is the last slide.
  await page.keyboard.press("End");
  const group = page.getByTestId("slides").getByTestId("timeline-no-milestone");
  await expect(group.getByRole("heading", { name: "No milestone" })).toBeVisible();
  const rows = group.getByTestId("timeline-no-milestone-item");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("button", { name: "Calendar invite sync" })).toBeVisible();
});

test.describe("vqa-b on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the phone's timeline lists the PRD's item with no plan milestone under No milestone", async ({ page }) => {
    await scenario(page, ONE_PAGER_PLAN_LOOSE_SCENARIO);
    await login(page);
    await page.goto(PRD_URL);
    const timeline = page.getByTestId("timeline-vertical");
    await expect(timeline).toBeVisible();
    const group = timeline.getByTestId("timeline-no-milestone");
    await expect(group.getByRole("heading", { name: "No milestone" })).toBeVisible();
    // The group closes the timeline, after the milestones.
    await expect(timeline.locator(":scope > *").last()).toHaveAttribute("data-testid", "timeline-no-milestone");
    const rows = group.getByTestId("timeline-no-milestone-item");
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: "Calendar invite sync" }).click();
    await expect(page.getByRole("complementary", { name: "Calendar invite sync" })).toBeVisible();
  });
});

test.describe("production QA", () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test("vqa-a: each Needs a look card shows once", async ({ page }) => {
    await scenario(page, "one-pager-vqa");
    await login(page);
    await page.goto(PRD_URL);
    const looks = page.getByRole("region", { name: "Needs a look" }).getByTestId("needs-look-line");
    await expect(looks.filter({ hasText: "Numbers disagree in “Not this quarter”" })).toHaveCount(1);
    const texts = await looks.allTextContents();
    expect(new Set(texts).size).toBe(texts.length);
  });

  test("vqa-c: Who has it names the people, never a confidence label", async ({ page }) => {
    await scenario(page, "one-pager-vqa");
    await login(page);
    await page.goto(PRD_URL);
    const who = page.getByTestId("problem-who");
    await expect(who).toHaveText("Who has it: Studio leads");
    await expect(who).not.toContainText(/confidence/i);
  });

  test("vqa-d: a long Problem line is edited whole and keeps no cut text", async ({ page }) => {
    await scenario(page, "simple-walk");
    await login(page);
    await page.goto(PRD_URL);
    const problem = page.getByRole("region", { name: "Problem and who has it" });
    const line = problem.getByTestId("one-pager-line-text");
    await expect(line).toHaveText(/hides the invite step\.$/);
    await problem.getByRole("button", { name: "Edit “New workspace admins stall during" }).click();
    const box = problem.getByLabel("New wording for");
    await expect(box).toHaveValue(WALK_PROBLEM);
    const edited = WALK_PROBLEM.replace("hides the invite step", "hides the invite button");
    expect(edited.length).toBeGreaterThan(300);
    await box.fill(edited);
    await problem.getByRole("button", { name: "Save" }).click();
    await expect(page.locator('[data-line="problem-1"]')).toHaveAttribute("data-state", "edited");
    await expect(line).toHaveText(edited);
    await expect(line).not.toContainText("…");
    await expect(problem.getByRole("button", { name: /^Show all of/ })).toHaveCount(0);
  });
});

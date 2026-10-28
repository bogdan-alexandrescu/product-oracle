import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * B6 Goals interview (#149) through the UI, on the mock layer: a person starts a discussion on
 * a vague goal, Oracle (scripted in the mock) restates it, names what is missing and offers two
 * measurable versions for "Cut early churn"; a version is proposed, accepted, and the goal
 * becomes measurable. The seed has 2 vague goals of 3: "Grow paid conversion" (no owner) and
 * "Cut early churn" (target, horizon and owner still missing).
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_goal_interview.py.
 */

const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const CHURN = "Make “Cut early churn” measurable";
const VERSION_1 = "Version 1 · Less than 8% of accounts leaving in their first 90 days · Medium (by Jun 30) · 2 sources";

const churnRow = (page: Page) => page.getByTestId("goal-g.early-churn");
const discuss = (page: Page) => page.getByTestId("goal-discuss");
const thread = (page: Page) => discuss(page).getByTestId("discussion-thread");
const cards = (page: Page) => discuss(page).getByTestId("version-card");
const chips = (page: Page) => discuss(page).getByTestId("missing-chip");

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await expect(churnRow(page)).toBeVisible();
}

/** The goal discussions the mock holds (read only: what exists, never changed by the test). */
function interviews(page: Page): Promise<number> {
  return page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}");
    return (db.discussions?.discussions ?? []).filter((d: { subject_kind: string }) => d.subject_kind === "entity").length;
  });
}

/** Make measurable on the Not measurable chip of "Cut early churn": the drawer's Discuss view. */
async function makeChurnMeasurable(page: Page) {
  await churnRow(page).getByRole("button", { name: "Make measurable" }).click();
  await expect(thread(page).getByRole("heading", { name: CHURN })).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
}

// protects=criterion 10.1: the Not measurable chip offers Make measurable, which opens the goal's
// Discuss view with the missing-field chips, Oracle's opening turn, two version cards and the
// quick replies (Research this hidden); Ask someone… starts an @mention in the composer;
// fails_when=no Make measurable, no Missing chips, not two cards, a Research this chip, or a
// discussion before the click; no_claim=Oracle's wording (scripted in the mock).
test("the chip's Make measurable opens Discuss with Missing chips and Oracle's two version cards", async ({ page }) => {
  await openBaseline(page);
  await expect(churnRow(page).getByTestId("not-measurable")).toHaveText("Not measurable");
  expect(await interviews(page)).toBe(0);
  await makeChurnMeasurable(page);
  expect(await interviews(page)).toBe(1);

  await expect(discuss(page).getByTestId("missing-strip")).toContainText("Missing:");
  await expect(chips(page)).toHaveText(["Target", "Horizon", "Owner"]);
  for (const c of await chips(page).all()) await expect(c).toHaveAttribute("data-settled", "false");
  const opening = thread(page).getByTestId("oracle-reply").first();
  await expect(opening).toContainText("“Cut early churn” says: Fewer accounts leave in their first three months.");
  await expect(opening).toContainText("Missing: target, horizon, owner.");
  await expect(opening).toContainText("Which version fits best?");

  await expect(cards(page).first().getByTestId("version-heading")).toHaveText(VERSION_1);
  await expect(cards(page).nth(1).getByTestId("version-heading")).toHaveText(
    "Version 2 · At most 5% of accounts leaving in their first 30 days · Short (by Dec 31) · 1 source",
  );
  await expect(cards(page).first().getByTestId("version-rationale")).toContainText("The support export shows 11%");
  for (const name of ["Propose", "Edit", "Dismiss"]) await expect(cards(page).first().getByRole("button", { name, exact: true })).toBeVisible();

  const quick = discuss(page).getByTestId("quick-replies");
  await expect(quick.getByRole("button")).toHaveText(["Use version 1", "I don't know", "Ask someone…"]);
  await expect(discuss(page).getByText("Research this")).toHaveCount(0);
  await quick.getByRole("button", { name: "Ask someone…" }).click();
  await expect(thread(page).getByRole("textbox", { name: "Message" })).toHaveValue("@");
  await expect(thread(page).getByRole("listbox", { name: "People to mention" })).toBeVisible();
  // The interview opens with Ask Oracle on.
  await expect(thread(page).getByRole("checkbox", { name: "Ask Oracle" })).toBeChecked();
});

// protects=criterion 10.2: a discussion ends in a typed change a person applies: the approver
// sets the owner with Edit, says Use version 1, proposes it and accepts it; the chips turn
// green, Oracle says it is measurable now and the discussion closes, and the Goals table shows
// "< 8%" without the Not measurable chip; fails_when=the goal changes before Accept now, a chip
// stays amber, or the chip remains; no_claim=scripted Oracle in the mock.
test("approver: owner set with Edit, Use version 1, Propose, Accept now: measurable now", async ({ page }) => {
  await openBaseline(page, APPROVER);
  await makeChurnMeasurable(page);
  const card = cards(page).first();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = card.getByTestId("version-edit");
  await expect(edit.getByLabel("Value", { exact: true })).toHaveValue("8");
  await edit.getByLabel("Owner", { exact: true }).fill("appr");
  await edit.getByRole("listbox", { name: "Members" }).getByRole("option", { name: /Approver/ }).click();
  await expect(edit.getByTestId("owner-picked")).toContainText("Approver");

  await discuss(page).getByTestId("quick-replies").getByRole("button", { name: "Use version 1" }).click();
  const said = thread(page).locator('[data-testid="discussion-message"][data-author-kind="person"]');
  await expect(said).toHaveCount(1);
  await expect(said).toContainText("Approver");
  await expect(said).toContainText("Use version 1");
  await expect(thread(page).getByTestId("oracle-reply").last()).toContainText("Version 1 it is.");

  // Nothing changes before Accept now.
  await card.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(card.getByTestId("version-proposed")).toContainText("Proposed");
  await expect(churnRow(page).getByTestId("not-measurable")).toBeVisible();
  await card.getByRole("button", { name: "Accept now" }).click();

  await expect(card.getByTestId("version-proposed")).toContainText("Accepted");
  for (const c of await chips(page).all()) await expect(c).toHaveAttribute("data-settled", "true");
  await expect(thread(page).getByTestId("discussion-message").last()).toContainText("“Cut early churn” is measurable now");
  await expect(thread(page)).toContainText("This discussion is closed.");
  await expect(churnRow(page).locator('[data-attr="target"]')).toHaveText("< 8%");
  await expect(churnRow(page).locator('[data-attr="owner"]')).toHaveText("Approver");
  await expect(churnRow(page).getByTestId("not-measurable")).toHaveCount(0);
});

// protects=criterion 10.3 and c6: a commenter proposes but does not accept: the card offers
// Propose (no Dismiss), then says waiting for an approver, and the Proposals tab lists the
// proposal as "Suggested by Commenter"; fails_when=a commenter sees Accept now or Dismiss, or the
// proposal is missing or unattributed; no_claim=the approver's Inbox row.
test("commenter: Propose, then waiting for an approver, and the Proposals tab says Suggested by", async ({ page }) => {
  await openBaseline(page, COMMENTER);
  await makeChurnMeasurable(page);
  const card = cards(page).first();
  await expect(card.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await card.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(card.getByTestId("version-proposed")).toHaveText(/Proposed\s*· waiting for an approver/);
  await expect(card.getByRole("button", { name: "Accept now" })).toHaveCount(0);

  await page.getByRole("tab", { name: /^Proposals/ }).click();
  const row = page.getByTestId("proposal").filter({ hasText: "Suggested by Commenter" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("From discussion Make “Cut early churn” measurable");
});

// protects=#674 on main: the card's Accept now keeps train Q's gate (shown on accept_proposal,
// after the generic change actions of #573) and #674's words on what Accept does (the item is
// then locked against Oracle's changes until a person unlocks it); fails_when=an approver's
// Accept now is missing or loses the lock tooltip; no_claim=a commenter (the commenter test), the API's
// accept route (api/tests/test_accept_locks_wording.py).
test("approver: Accept now, shown on accept_proposal, says accepting locks the goal", async ({ page }) => {
  await openBaseline(page, APPROVER);
  await makeChurnMeasurable(page);
  const card = cards(page).first();
  await card.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(card.getByTestId("version-proposed")).toContainText("Proposed");
  const accept = card.getByRole("button", { name: "Accept now" });
  await expect(accept).toBeEnabled();
  await expect(accept).toHaveAttribute("title", /locked against Oracle's changes until a person unlocks it/);
  await accept.click();
  await expect(card.getByTestId("version-proposed")).toContainText("Accepted");
});

// protects=decision C1b: a target already met by the start value gets Oracle's pushback once,
// and proposing it again goes through; fails_when=no pushback, a second one, or the keep is
// refused; no_claim=the evidence threshold half of the rule (pytest).
test("proposing a target of 12 gets Oracle's pushback once; Propose anyway goes through", async ({ page }) => {
  await openBaseline(page);
  await makeChurnMeasurable(page);
  const card = cards(page).first();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByTestId("version-edit").getByLabel("Value", { exact: true }).fill("12");
  await card.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(card.getByTestId("version-pushback")).toContainText(
    "The start value 11 already meets the target 12; a target that is already met does not measure progress.",
  );
  const pushback = thread(page).getByTestId("oracle-pushback");
  await expect(pushback).toHaveCount(1);
  await expect(thread(page).getByTestId("oracle-reply").last()).toContainText("Pushback: The start value 11 already meets the target 12");
  await expect(card).toHaveAttribute("data-status", "proposed");

  await card.getByRole("button", { name: "Propose anyway" }).click();
  await expect(card.getByTestId("version-proposed")).toContainText("Proposed");
  await expect(pushback).toHaveCount(1);
  await expect(thread(page).getByTestId("discussion-summary")).toContainText("Kept target 12 although the start value 11 already meets it.");
});

// protects=b6-goal-only-slice (#187): Dismiss on a version goes through G3's generic action
// (B6's own route is gone and answers 410): the card says Dismissed, loses its buttons, and the
// other version stays open; fails_when=Dismiss errors or the card stays proposed;
// no_claim=who may dismiss (pytest: approvers only).
test("an approver dismisses a version: the card says Dismissed and the other stays open", async ({ page }) => {
  await openBaseline(page, APPROVER);
  await makeChurnMeasurable(page);
  const [first, second] = [cards(page).first(), cards(page).nth(1)];
  await first.getByRole("button", { name: "Dismiss" }).click();
  await expect(first).toHaveAttribute("data-status", "dismissed");
  await expect(first).toContainText("Dismissed");
  await expect(first.getByTestId("version-actions")).toHaveCount(0);
  await expect(second).toHaveAttribute("data-status", "proposed");
  await expect(second.getByRole("button", { name: "Propose", exact: true })).toBeVisible();
});

// protects=criterion 10.5 and B6 "Interviews": Interview vague goals (2) steps through the vague
// goals one at a time, each discussion created only when reached; fails_when=both are created
// at once, the count or position is wrong, or Next does not move on; no_claim=Skip's skipped
// goal is checked only for not being created.
test("Interview vague goals (2) steps Goal 1 of 2 · Next, creating each discussion when reached", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Interview vague goals (2)" }).click();
  const stepper = discuss(page).getByTestId("interview-stepper");
  await expect(stepper.getByTestId("stepper-position")).toHaveText("Goal 1 of 2");
  await expect(stepper.getByRole("button", { name: "Next" })).toBeVisible();
  await expect(stepper.getByRole("button", { name: "Skip" })).toBeVisible();
  await expect(thread(page).getByRole("heading", { name: "Who should own “Grow paid conversion”?" })).toBeVisible();
  await expect(chips(page)).toHaveText(["Owner"]);
  expect(await interviews(page)).toBe(1);

  await stepper.getByRole("button", { name: "Next" }).click();
  await expect(stepper.getByTestId("stepper-position")).toHaveText("Goal 2 of 2");
  await expect(thread(page).getByRole("heading", { name: CHURN })).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  expect(await interviews(page)).toBe(2);
});

// protects=criterion 9a and 10.6: approving the seeded baseline review starts nothing: the run
// page's Confirm the baseline row and the From this run band offer "2 goals are not measurable ·
// Interview" with the help tip, and a discussion exists only once Interview is clicked;
// fails_when=the line is missing or miscounted, or a discussion exists before the click;
// no_claim=the model call log (pytest asserts the fake model was never called).
test("after the baseline review: the run row and From this run band offer Interview; nothing starts before", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  const line = page.getByTestId("segment-baseline").getByTestId("vague-goals-line");
  await expect(line).toContainText("2 goals are not measurable · Interview");
  await line.getByRole("button", { name: "About the goals interview" }).click();
  await expect(page.getByText("Oracle asks one question at a time and proposes measurable versions. Nothing runs until you start.")).toBeVisible();
  expect(await interviews(page)).toBe(0);
  const runId = page.url().split("/runs/")[1].split(/[?#]/)[0];

  await page.goto(`/baseline?tab=proposals&run=${runId}`);
  const band = page.getByTestId("from-this-run").getByTestId("vague-goals-line");
  await expect(band).toContainText("2 goals are not measurable · Interview");
  expect(await interviews(page)).toBe(0);
  await band.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(discuss(page).getByTestId("stepper-position")).toHaveText("Goal 1 of 2");
  expect(await interviews(page)).toBe(1);
});

// protects=B5's checks on a version: Edit with a value the checks refuse shows B5's message on
// the card and creates nothing; fails_when=the card proposes anyway or the message shows
// elsewhere; no_claim=every B5 rule (baseline-goals.spec.ts and pytest cover them).
test("Edit with a bad value shows B5's message on the card and proposes nothing", async ({ page }) => {
  await openBaseline(page);
  await makeChurnMeasurable(page);
  const card = cards(page).first();
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await card.getByTestId("version-edit").getByLabel("Value", { exact: true }).fill("-5");
  await card.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(card.getByTestId("field-error-target")).toHaveText("A percentage is 0 or more");
  await expect(card).toHaveAttribute("data-status", "proposed");
  await page.getByRole("tab", { name: /^Proposals/ }).click();
  await expect(page.getByTestId("proposal").filter({ hasText: "From discussion" })).toHaveCount(0);
});

// protects=#370: a viewer sees no control they can never use: no Make measurable, no Interview
// vague goals; fails_when=either shows; no_claim=the API's 403 (pytest).
test("a viewer sees neither Make measurable nor Interview vague goals", async ({ page }) => {
  await openBaseline(page, VIEWER);
  await expect(churnRow(page).getByTestId("not-measurable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Make measurable" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Interview vague goals/ })).toHaveCount(0);
  await churnRow(page).getByRole("button", { name: "Cut early churn" }).click();
  await expect(page.getByRole("dialog", { name: "Cut early churn" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make measurable" })).toHaveCount(0);
});

// protects=a subgoal (#469) is interviewed like any goal: its row, indented under its parent,
// has its own Not measurable chip and Make measurable, which opens the subgoal's interview;
// fails_when=the subgoal row has no Make measurable, loses its indent, or opens the parent's
// interview; no_claim=the roll-up (subgoals.spec.ts).
test("a subgoal's row offers Make measurable and opens the subgoal's own interview", async ({ page }) => {
  const sub = "Fewer cancellations in week one";
  await openBaseline(page, APPROVER);
  await churnRow(page).getByRole("button", { name: "Confirm" }).click();
  await expect(churnRow(page).getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await churnRow(page).getByRole("button", { name: "Add subgoal" }).click();
  const add = page.getByRole("form", { name: "Add subgoal" });
  await add.getByLabel("Subgoal title").fill(sub);
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId("goal-g.early-churn.fewer-cancellations-in-week-one");
  await expect(row).toBeVisible();
  // The parent still offers its own interview beside Add subgoal.
  await expect(churnRow(page).getByRole("button", { name: "Make measurable" })).toBeVisible();
  await expect(churnRow(page).getByRole("button", { name: `Hide subgoals of Cut early churn` })).toBeVisible();
  await expect(row.getByTestId("not-measurable")).toBeVisible();
  expect(await interviews(page)).toBe(0);
  await row.getByRole("button", { name: "Make measurable" }).click();
  await expect(thread(page).getByRole("heading", { name: `Make “${sub}” measurable` })).toBeVisible();
  expect(await interviews(page)).toBe(1);
  await expect(chips(page).first()).toBeVisible();
  await expect(thread(page).getByTestId("oracle-reply").first()).toContainText(`“${sub}”`);
});

// protects=Home's goal card with No target links to the interview (commenter+); fails_when=no
// link, or it does not open the goal's Discuss view; no_claim=Plan's copy of the band.
test("Home: Make measurable on a No target goal card opens its interview", async ({ page }) => {
  await openBaseline(page);
  await churnRow(page).getByRole("button", { name: "Confirm" }).click();
  await expect(churnRow(page)).toContainText("Confirmed");
  await page.goto("/home");
  const g3 = page.getByTestId("home-goal-G3");
  await expect(g3.getByTestId("goal-to-go")).toHaveText("No target");
  await g3.getByTestId("goal-make-measurable").click();
  await expect(page).toHaveURL(/\/baseline/);
  await expect(thread(page).getByRole("heading", { name: CHURN })).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
});

// protects=the phone layout: at 390 px the Discuss view is a full-height sheet that fits, and a
// card's buttons stack and stay visible; fails_when=horizontal scroll, a sheet shorter than the
// screen, or a button off screen; no_claim=other sizes.
test("at 390 px the Discuss sheet fits the screen and the card buttons stack and stay visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBaseline(page);
  await makeChurnMeasurable(page);
  // Oracle's opening turn has finished streaming: nothing moves the cards any more.
  await expect(thread(page).getByTestId("oracle-reply").first()).toContainText("Which version fits best?");
  const box = (await discuss(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeLessThanOrEqual(390);
  expect(Math.round(box.height)).toBe(844);
  const sheetOverflow = await discuss(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(sheetOverflow).toBeLessThanOrEqual(0);
  const card = cards(page).first();
  const propose = card.getByRole("button", { name: "Propose", exact: true });
  const edit = card.getByRole("button", { name: "Edit", exact: true });
  await propose.scrollIntoViewIfNeeded();
  for (const b of [propose, edit, card.getByRole("button", { name: "Dismiss" })]) {
    await expect(b).toBeInViewport();
    const r = (await b.boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(390);
  }
  expect((await edit.boundingBox())!.y).toBeGreaterThan((await propose.boundingBox())!.y);
});

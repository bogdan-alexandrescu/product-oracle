import { expect, test, type Page } from "./test";

import { DISCUSSION_CHANGE_KINDS } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * G3's priority move, ask and decision changes through the UI, on the mock layer
 * ("discussion-change-kinds" scenario): in the approver's open discussion on the feature-set
 * stop's saved-carts item, Oracle proposed moving Saved carts above Guided setup on a thin
 * reason ("Gut feeling"), asking the approver how long a cart lasts, and a decision. The
 * discussion's link opens its thread in a sheet on the run page. Apply is for approvers and
 * Oracle pushes back on a thin reason first (the mock's stand-in for C9 and the reason check);
 * Ask and Propose are for commenters too.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_discussion_changes*.py.
 */

// The run the "feature-set" scenario seeds (web/lib/api/mock/runs.ts FEATURE_SET_RUN).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const MOVE = "Move Saved carts above Guided setup: Gut feeling";
const ASK = "Ask Priya Raman: How long should a saved cart last?";
const APPLY_WHY_NOT = "Approvers apply this change.";
const DECISION = "Ship saved carts before guided setup?";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-change-kinds"), MOCK_SCENARIO_KEY);
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const card = (page: Page) => thread(page).getByTestId("changes-card");
const change = (page: Page, label: string) => card(page).getByTestId("change-row").filter({ hasText: label });
const handled = (page: Page) => card(page).getByTestId("changes-handled");

async function openDiscussion(page: Page) {
  await page.goto(`/runs/${RUN}?discussion=${DISCUSSION_CHANGE_KINDS}`);
  await expect(thread(page)).toBeVisible();
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 3 changes");
}

// protects=G3 Apply with Oracle's pushback: an approver's Apply on a thin reason shows Oracle's
// objections and stores nothing; "Apply anyway" needs a reason, then the move is Done and the
// thread says who applied what; fails_when=Apply stores the move without pushback, Apply anyway
// goes without a reason, or the change stays open; no_claim=C9's real rules and the priority
// order the override changes (pytest, the priorities specs).
test("an approver applies Oracle's priority move after its pushback", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  const row = change(page, MOVE);
  await expect(row.getByTestId("change-by")).toHaveText("Proposed by Oracle");
  await row.getByRole("button", { name: "Apply", exact: true }).click();
  const pushback = row.getByTestId("apply-pushback");
  await expect(pushback).toContainText("Oracle pushed back on this:");
  await expect(pushback).toContainText("The reason does not say what changed.");
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 3 changes");
  const anyway = row.getByRole("button", { name: "Apply anyway" });
  await expect(anyway).toBeDisabled();
  await row.getByRole("textbox", { name: "Why apply it anyway?" }).fill("Three enterprise deals this month wait on saved carts.");
  await anyway.click();
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 2 changes");
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  await expect(change(page, MOVE)).toHaveAttribute("data-status", "done");
  await expect(change(page, MOVE)).toContainText("Done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Approver applied: ${MOVE}`);
});

// protects=#370 for Apply and G3 Ask: a commenter sees Apply disabled with the API's reason,
// and asks the person Oracle named, which marks the change Done with a line in the thread;
// fails_when=a commenter can Apply, the reason is missing, or Ask is refused or leaves the
// change open; no_claim=the question in the asked person's Inbox (the questions specs).
test("a commenter cannot apply, sees why, and asks the person", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  const apply = change(page, MOVE).getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveAttribute("title", APPLY_WHY_NOT);
  await change(page, ASK).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  await expect(change(page, ASK)).toHaveAttribute("data-status", "done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Commenter asked: ${ASK}`);
});

// protects=G3 decision: a person proposes a decision through "Propose a change" (title,
// options, who decides), presses Propose on it, and it lands as a Proposed decision in the
// decision log, which the row links to; fails_when=the kind is not offered, the form loses
// the options or the approver, the change stays open, or the decision log lacks it;
// no_claim=the API's decision subjects (pytest).
test("a commenter proposes a decision that lands in the decision log", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  await card(page).getByRole("button", { name: "Propose a change" }).click();
  await card(page).getByRole("combobox", { name: "Kind of change" }).selectOption({ label: "Propose a decision" });
  const form = card(page).getByTestId("change-form");
  await form.getByRole("textbox", { name: "Decision", exact: true }).fill(DECISION);
  await form.getByRole("textbox", { name: "What is being decided" }).fill("Which ships first next quarter?");
  await form.getByRole("textbox", { name: "Options" }).fill("Saved carts first\nGuided setup first");
  await form.getByRole("combobox", { name: "Who decides" }).selectOption({ label: "Approver" });
  await form.getByRole("button", { name: "Propose" }).click();

  const mine = change(page, `Decide: ${DECISION}`);
  await expect(mine.getByTestId("change-by")).toHaveText("Suggested by Commenter");
  await mine.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  const done = change(page, `Decide: ${DECISION}`);
  await expect(done).toHaveAttribute("data-status", "done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Commenter proposed: Decide: ${DECISION}`);
  const link = done.getByRole("link", { name: /^Open D-\d+$/ });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/company\/decisions\?d=/);
  const row = page.getByTestId("decision-row").filter({ hasText: DECISION });
  await expect(row).toContainText("Proposed");
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText(DECISION);
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Saved carts first" })).toBeVisible();
});

const propose = async (page: Page, kind: string) => {
  await card(page).getByRole("button", { name: "Propose a change" }).click();
  await card(page).getByRole("combobox", { name: "Kind of change" }).selectOption({ label: kind });
  return card(page).getByTestId("change-form");
};
const stagingBar = (page: Page) => page.getByTestId("staging-bar").filter({ visible: true });

// protects=#585 review, the mock as the API: an approver's Ask on the waiting feature-set stop's
// item is the item's D8 question action, staged at that stop and shown in its staging bar as
// from the discussion; fails_when=Ask makes a plain question the stop never shows;
// no_claim=the question in the asked person's Inbox (the questions specs).
test("an approver's Ask on a waiting stop's item is that stop's question", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  await expect(stagingBar(page)).toContainText("Nothing staged");
  await change(page, ASK).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await page.reload();
  const chip = stagingBar(page).getByTestId("staged-chip");
  await expect(chip).toHaveText("Question saved-carts");
  await expect(chip.getByTestId("chip-discussion")).toBeVisible();
});

// protects=#585 review, the scope forms and the mock's Stage as the API: an approver writes
// "Exclude Saved carts" and "Add a requirement under Saved carts" through Propose a change,
// and Stage refuses both with the API's 409 since no waiting feature set holds Saved carts,
// the changes staying open; fails_when=the forms lose the feature, the decision, the reason or
// the text, or the mock stages a scope change no stop holds; no_claim=staging at a stop that
// holds the feature (pytest: test_scope_feature_is_staged_at_the_feature_set_stop).
test("an approver writes scope changes and Stage needs a feature set holding the feature", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  let form = await propose(page, "Include, exclude or defer a feature");
  await expect(form.getByRole("combobox", { name: "Feature", exact: true })).toHaveValue(/.+/);
  await form.getByRole("button", { name: "Exclude", exact: true }).click();
  await form.getByRole("textbox", { name: "Reason" }).fill("No goal this quarter needs it");
  await form.getByRole("button", { name: "Propose" }).click();
  const exclude = change(page, "Exclude Saved carts: No goal this quarter needs it");
  await exclude.getByRole("button", { name: "Stage", exact: true }).click();
  await expect(exclude).toContainText("No feature set waiting for approval has this feature");
  await expect(exclude).toHaveAttribute("data-status", "proposed");

  form = await propose(page, "Add, change or cut a requirement");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await form.getByRole("combobox", { name: "Feature it belongs to" }).selectOption({ label: "Saved carts" });
  await form.getByRole("textbox", { name: "Requirement text" }).fill("A saved cart lasts thirty days");
  await form.getByRole("button", { name: "Propose" }).click();
  const add = change(page, "A saved cart lasts thirty days");
  await add.getByRole("button", { name: "Stage", exact: true }).click();
  await expect(add).toContainText("No feature set waiting for approval has this feature");
  await expect(stagingBar(page)).toContainText("Nothing staged");
});

// protects=#585 review, the priority forms: an approver writes a move (feature, above which,
// reason) and a pin (feature, position, reason) through Propose a change and applies each,
// which ends Done with the line in the thread; fails_when=either form loses a field or Apply
// leaves it open; no_claim=C9's own rules (pytest, the priorities specs).
test("an approver writes and applies a priority move and a pin", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  let form = await propose(page, "Move a priority");
  await form.getByRole("combobox", { name: "Feature", exact: true }).selectOption({ label: "Guided setup" });
  await form.getByRole("combobox", { name: "Move above" }).selectOption({ label: "Saved carts" });
  const why = "Activation needs setup before carts this quarter";
  await form.getByRole("textbox", { name: "Reason" }).fill(why);
  await form.getByRole("button", { name: "Propose" }).click();
  const moved = `Move Guided setup above Saved carts: ${why}`;
  await change(page, moved).getByRole("button", { name: "Apply", exact: true }).click();
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Approver applied: ${moved}`);

  form = await propose(page, "Pin a priority");
  await form.getByRole("combobox", { name: "Feature", exact: true }).selectOption({ label: "Saved carts" });
  await form.getByRole("spinbutton", { name: "Position" }).fill("2");
  const pinWhy = "Committed to the launch partner for next month";
  await form.getByRole("textbox", { name: "Reason" }).fill(pinWhy);
  await form.getByRole("button", { name: "Propose" }).click();
  const pinned = `Pin Saved carts at #2: ${pinWhy}`;
  await change(page, pinned).getByRole("button", { name: "Apply", exact: true }).click();
  await expect(thread(page).getByTestId("discussion-system-line").last()).toHaveText(`Approver applied: ${pinned}`);
  await handled(page).locator("summary").click();
  await expect(change(page, moved)).toHaveAttribute("data-status", "done");
  await expect(change(page, pinned)).toHaveAttribute("data-status", "done");
});

// protects=#585 review, Ask's person picker: a commenter writes "Ask someone" (whom, the
// question) and asks it, which ends Done with the line in the thread; fails_when=the picker or
// the question is lost; no_claim=the asked person's Inbox (the questions specs).
test("a commenter writes a question for a person and asks it", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  const form = await propose(page, "Ask someone");
  await form.getByRole("combobox", { name: "Ask whom" }).selectOption({ label: "Approver" });
  await form.getByRole("textbox", { name: "Question" }).fill("Who owns cart expiry?");
  await form.getByRole("button", { name: "Propose" }).click();
  const asked = "Ask Approver: Who owns cart expiry?";
  await expect(change(page, asked).getByTestId("change-by")).toHaveText("Suggested by Commenter");
  await change(page, asked).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Commenter asked: ${asked}`);
  await handled(page).locator("summary").click();
  await expect(change(page, asked)).toHaveAttribute("data-status", "done");
});

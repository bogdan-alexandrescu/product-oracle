import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, openTab, sectionAction, signOut } from "./helpers";

/*
 * G3 Outcome extraction through the UI, on the mock layer: Oracle's reply ends with changes
 * that people suggest, edit, stage or dismiss in the card under the thread. On a section the
 * mock's canned reply proposes 2 section edits (the API offers a section only section_edit and
 * answer: "Edit problem: …" and "Edit solution: …"); the change
 * routes follow the API's rules for the four mock roles. checkout-redesign v2 has no
 * discussions, so every test starts its own on its Problem, as a person would.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_discussion_changes*.py.
 */

const DOC = "/documents/checkout-redesign/v/2";
const SUBJECT = "Checkout redesign PRD · 2. Problem";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const EDIT = "Edit problem: say that detection follows once activation holds";
const SECOND = "Edit solution: read the caps from the plan thresholds";
/** The kinds the API offers on a section (kinds.available_for("section")). */
const SECTION_KINDS = ["section_edit", "answer", "ask_person", "decision"];
const STAGE_WHY_NOT = "Approvers stage changes. You can suggest it.";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussions"), MOCK_SCENARIO_KEY);
const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const card = (page: Page) => thread(page).getByTestId("changes-card");
const header = (page: Page) => card(page).getByTestId("changes-header");
const change = (page: Page, label: string) => card(page).getByTestId("change-row").filter({ hasText: label });

/** Starts a discussion on DOC's Problem (private when asked), alone, and optionally asks Oracle and waits for its reply. */
async function startDiscussion(page: Page, opts: { private?: boolean; ask?: boolean } = {}) {
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Discuss this section");
  const form = page.getByTestId("start-discussion").filter({ visible: true });
  if (opts.private) await form.getByRole("group", { name: "Who can read it" }).getByRole("button", { name: "Private" }).click();
  await form.getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
  if (opts.ask === false) return;
  await thread(page).getByRole("textbox", { name: "Message" }).fill("Can caps ship without detection?");
  await thread(page).getByRole("button", { name: "Send" }).click();
  await expect(thread(page).getByTestId("oracle-reply").last()).toHaveAttribute("data-status", "complete");
}

/** Opens the discussion on DOC's Problem from the Feedback tab. */
async function openDiscussion(page: Page) {
  await page.goto(DOC);
  await openTab(page, "Feedback");
  await panel(page).getByTestId("feedback-discussions").click();
  await panel(page).getByTestId("discussion-row").filter({ hasText: SUBJECT }).first().click();
  await expect(thread(page)).toBeVisible();
}

// protects=criterion 13.1: when Oracle's reply ends, the card under the thread lists its 2
// changes, each of a kind the API offers on a section, with their rationale's citation chip and
// "Proposed by Oracle"; fails_when=the card is missing, does not refresh after the stream, shows
// a wrong count, or lists a kind the API would drop on a section (an item move);
// no_claim=the real model's choice of changes (the canned reply stands in).
test("after Oracle's reply, the card shows its 2 changes", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await startDiscussion(page);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  await expect(card(page).getByTestId("change-row")).toHaveCount(2);
  const kinds = await card(page).getByTestId("change-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-kind")));
  expect(kinds.every((k) => SECTION_KINDS.includes(k ?? ""))).toBe(true);
  await expect(change(page, EDIT).getByTestId("change-by")).toHaveText("Proposed by Oracle");
  await expect(change(page, SECOND)).toHaveCount(1);
  await expect(change(page, EDIT).getByTestId("change-rationale").getByTestId("cite-c-1")).toBeVisible();
});

// protects=criterion 13.2 (c6, commenters suggest): Stage is disabled for a commenter and says
// why in its tooltip; Suggest makes it theirs; fails_when=a commenter can stage, the reason is
// missing, or the row does not name them; no_claim=the Inbox row the suggestion makes (G6).
test("a commenter cannot stage, sees why, and suggests the change", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await startDiscussion(page);
  const row = change(page, EDIT);
  const stage = row.getByRole("button", { name: "Stage" });
  await expect(stage).toBeDisabled();
  await expect(stage).toHaveAttribute("title", STAGE_WHY_NOT);
  await expect(row.getByRole("button", { name: "Edit" })).toBeVisible();
  await row.getByRole("button", { name: "Suggest" }).click();
  await expect(row.getByTestId("change-by")).toHaveText("Suggested by Commenter");
  await expect(row.getByRole("button", { name: "Suggest" })).toHaveCount(0);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
});

// protects=criterion 13.3 (approvers edit and stage): Edit's form changes the change's
// sentence (on a section the change is a section edit, so its instruction, not a horizon); Stage moves it to "1 handled" and the thread gets "<name> staged: <label>";
// fails_when=the edit is lost, the row stays open, or no system line; no_claim=the staging list
// and next draft that use it (G4).
test("an approver edits the horizon and stages it: 1 handled, with a line in the thread", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await startDiscussion(page);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  await signOut(page);

  await login(page, APPROVER);
  await openDiscussion(page);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  await change(page, EDIT).getByRole("button", { name: "Edit" }).click();
  const form = card(page).getByTestId("change-form");
  await form.getByRole("textbox", { name: "What to change" }).fill("Name the plan thresholds the caps read.");
  await form.getByRole("button", { name: "Save" }).click();
  const edited = change(page, "Edit problem: name the plan thresholds the caps read");
  await expect(edited).toHaveCount(1);
  await expect(change(page, EDIT)).toHaveCount(0);
  await edited.getByRole("button", { name: "Stage" }).click();
  await expect(header(page)).toHaveText("From this discussion · 1 change");
  await expect(card(page).getByTestId("changes-handled").locator("summary")).toHaveText("1 handled");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText("Approver staged: Edit problem: name the plan thresholds the caps read");
});

// protects=criterion 13.4 (private staging): in a private discussion Stage asks for the
// reason everyone will see, prefilled from the rationale without its markers, says what it
// shares, and will not stage without it; fails_when=Stage shares without asking or with an
// empty reason; no_claim=G5's agent view of the staged change.
test("in a private discussion, an approver's Stage asks for the reason everyone will see", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await startDiscussion(page, { private: true });
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  const row = change(page, EDIT);
  await row.getByRole("button", { name: "Stage" }).click();
  const form = row.getByTestId("stage-form");
  await expect(form).toContainText(`This change and this reason will be visible to everyone who can see ${SUBJECT}. The discussion stays private.`);
  const reason = form.getByRole("textbox", { name: "The reason everyone will see" });
  await expect(reason).toHaveValue("The goal does not depend on detection.");
  await reason.fill("");
  await expect(form.getByRole("button", { name: "Stage" })).toBeDisabled();
  await reason.fill("Caps ship on plan thresholds; detection follows.");
  await form.getByRole("button", { name: "Stage" }).click();
  await expect(header(page)).toHaveText("From this discussion · 1 change");
  await expect(card(page).getByTestId("changes-handled").locator("summary")).toHaveText("1 handled");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Approver staged: ${EDIT}`);
});

// protects=criterion 13.5 (viewers read, #370): a viewer sees the changes and no control at
// all; fails_when=any action, Propose a change or summary button shows to a viewer;
// no_claim=the API's 403 on every action (pytest).
test("a viewer sees the changes and no buttons", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await startDiscussion(page);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  await signOut(page);

  await login(page, VIEWER);
  await openDiscussion(page);
  await expect(header(page)).toHaveText("From this discussion · 2 changes");
  await expect(card(page).getByTestId("change-row")).toHaveCount(2);
  await expect(change(page, EDIT)).toContainText("Proposed by Oracle");
  await expect(card(page).getByTestId("change-actions")).toHaveCount(0);
  await expect(card(page).getByRole("button")).toHaveCount(0);
});

// protects=criterion 13.6: "Propose a change" offers only the kinds the API offers on a section
// (section_edit, answer, ask_person, decision), and a commenter's change lands as their suggestion; fails_when=the
// picker lists a kind the subject does not offer (an item move), or the new change is missing; no_claim=the API's availability rules
// (kinds.available, pytest).
test("Propose a change offers only the subject's kinds", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await startDiscussion(page, { ask: false });
  await card(page).getByRole("button", { name: "Propose a change" }).click();
  const kind = card(page).getByRole("combobox", { name: "Kind of change" });
  await expect(kind.locator("option")).toHaveText(["Edit a section", "Answer a question", "Ask someone", "Propose a decision"]);
  await kind.selectOption({ label: "Edit a section" });
  const form = card(page).getByTestId("change-form");
  await form.getByRole("textbox", { name: "What to change" }).fill("Add a handover step for the first admin.");
  await form.getByRole("button", { name: "Propose" }).click();
  const mine = change(page, "Edit problem: add a handover step for the first admin");
  await expect(mine.getByTestId("change-by")).toHaveText("Suggested by Commenter");
  await expect(header(page)).toHaveText("From this discussion · 1 change");
});

// protects=G7 Share as discussion beside G3: the change Oracle proposed in a panel chat is
// copied into the shared discussion's card as a section edit suggested by the sharer;
// fails_when=the shared discussion has no change, or it loses its kind or who suggested it;
// no_claim=the API's copy (api/tests/test_discussion_changes.py).
test("sharing a panel chat brings its change into the discussion's card, suggested by the sharer", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  const hop = page.getByTestId("hop-panel").filter({ visible: true });
  await page.getByTestId("hop-strip").click();
  await hop.getByRole("textbox", { name: "Ask Oracle" }).fill("Rewrite this section to name the drop-off measure.");
  await hop.getByRole("button", { name: "Send" }).click();
  await expect(hop.getByTestId("oracle-reply").last()).toHaveAttribute("data-status", "complete");
  await expect(hop.getByTestId("hop-change")).toContainText("Change problem");

  await hop.getByRole("button", { name: "Share as discussion" }).click();
  const form = hop.getByTestId("hop-share-form");
  await form.getByRole("textbox", { name: "First message" }).fill("Name the drop-off measure before we ship.");
  await form.getByRole("button", { name: "Post" }).click();
  await expect(hop.getByTestId("hop-shared")).toBeVisible();
  const shared = hop.getByTestId("discussion-thread");
  await expect(shared.getByTestId("discussion-visibility")).toHaveText("Open");
  const row = shared.getByTestId("changes-card").getByTestId("change-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-kind", "section_edit");
  await expect(row).toHaveAttribute("data-status", "suggested");
  await expect(row).toContainText("Change problem");
  await expect(row.getByTestId("change-by")).toHaveText("Suggested by Commenter");
});

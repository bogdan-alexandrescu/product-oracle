import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID, MEETING_ONLY } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, signOut } from "./helpers";

/*
 * Simple chat actions: seven new cards typed in a chat ("<person> owns <item>", "<person>
 * decides <item>", "decision[ by <person>]: <text>", and in a meeting only "note: …", "open
 * question: …", "next: <item>", "skip <item>"). Each reads "I understood one change:" and its
 * one-line restatement; Preview says what Apply changes; Apply has its effect on the meeting
 * screen (S8's live review of Guided setup, started through the UI: the Agenda strip, Notes
 * so far, All decisions) or the plan; Undo takes it back. The Ask panel refuses the
 * meeting-only phrases and records a decision on the page's PRD (the Decisions page). The
 * mock's invented people (Admin the owner, Approver, Commenter, Viewer) and items. Desktop
 * (1366x820) and phone (390x844), light and dark.
 */

const EMAILS = { owner: ADMIN.email, approver: "approver@example.com", viewer: "viewer@example.com" } as const;

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

/** The owner starts a review of Guided setup (S8's sheet) and lands on its live meeting screen. */
async function startReview(page: Page) {
  await signIn(page, EMAILS.owner, "/simple/prds/guided-setup");
  await tap(page.getByRole("button", { name: "Start review" }));
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("checkbox", { name: "Commenter" }).check();
  await tap(sheet.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await expect(page.getByTestId("chat-rules")).toBeVisible();
}

const chat = (page: Page) => page.getByTestId("meeting-chat");

async function sayIn(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

/** Says `text`, sees "I understood one change:" and the card restating it; the card. */
async function understood(box: Locator, text: string, summary: string): Promise<Locator> {
  await sayIn(box, text);
  await expect(box.getByTestId("chat-message-body").filter({ hasText: text }).last()).toBeVisible();
  await expect(box.locator('[data-testid="chat-message"][data-kind="cards"]').filter({ hasText: "I understood one change:" }).last()).toBeVisible();
  const card = box.getByTestId("chat-card").filter({ has: box.page().getByTestId("chat-card-summary").filter({ hasText: summary }) }).last();
  await expect(card.getByTestId("chat-card-summary")).toHaveText(summary);
  return card;
}

/** Preview shows the card's description (each line); Hide preview closes it. */
async function preview(card: Locator, ...lines: string[]) {
  await tap(card.getByRole("button", { name: "Preview" }));
  const p = card.getByTestId("chat-card-preview");
  for (const l of lines) await expect(p).toContainText(l);
}

async function apply(card: Locator, by = "Admin") {
  await tap(card.getByRole("button", { name: "Apply" }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText(`Applied by ${by}`);
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone): the visible panel. */
async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

for (const [phone, dark] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  const where = `${phone ? "phone" : "desktop"}, ${dark ? "dark" : "light"}`;
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, dark ? "dark" : "light"] as const);
      if (dark) await page.emulateMedia({ colorScheme: "dark" });
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`notes and open questions fill "Notes so far", Undo takes one out, the minutes carry them (${where})`, async ({ page }) => {
      // protects: "note: …" and "open question: …" in the meeting chat each restate as one change ("Add to the minutes: …", "Add the open question: …") with a Preview in words; Apply lists them under Notes so far (with who); Undo removes the note; End meeting puts "Notes: …" into the drafted summary and the question into the open questions
      // fails_when: no "I understood one change:" line, the Preview has no description, the list does not follow Apply / Undo, or the minutes miss the note or the question
      // no_claim: the real API's minutes job (the mock drafts at once), who may apply under each change mode (simple-chat.spec.ts)
      await startReview(page);
      if (dark) await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      const notes = page.getByTestId("meeting-notes");
      await expect(notes).toContainText("None yet.");

      const note = await understood(chat(page), "note: Ship the checklist copy first", "Add to the minutes: Ship the checklist copy first");
      await preview(note, "Adds to the minutes' notes: Ship the checklist copy first");
      await apply(note);
      await expect(notes.getByTestId("meeting-note").filter({ hasText: "Ship the checklist copy first" })).toContainText("Note: Ship the checklist copy first");
      await expect(notes.getByTestId("meeting-note").first()).toContainText("Admin");

      const q = await understood(chat(page), "open question: Who writes the tour script?", "Add the open question: Who writes the tour script?");
      await preview(q, "Adds to the open questions: Who writes the tour script?");
      await apply(q);
      await expect(notes.locator('[data-testid="meeting-note"][data-kind="question"]')).toHaveText(/Open question: Who writes the tour script\?/);

      const extra = await understood(chat(page), "note: Drop the welcome video", "Add to the minutes: Drop the welcome video");
      await apply(extra);
      await expect(notes.getByTestId("meeting-note")).toHaveCount(3);
      await tap(extra.getByRole("button", { name: "Undo" }));
      await expect(extra.getByTestId("chat-card-outcome")).toContainText("Undone");
      await expect(notes.getByTestId("meeting-note")).toHaveCount(2);
      await expect(notes).not.toContainText("Drop the welcome video");

      await tap(page.getByRole("button", { name: "End meeting" }));

      await tap(page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }));
      await expect(page.getByTestId("end-screen")).toBeVisible();
      // qa-simple-decide-6: the notes are their own list, the summary says how many.
      await expect(page.getByLabel("Summary")).not.toHaveValue(/Ship the checklist copy first/);
      await expect(page.getByTestId("minutes-notes")).toContainText("Ship the checklist copy first");
      await expect(page.getByLabel("Summary")).not.toHaveValue(/Drop the welcome video/);
      await expect(page.getByLabel("Open questions")).toHaveValue(/Who writes the tour script\?/);
    });

    test(`"next:" and "skip" change the agenda strip; Undo restores it (${where})`, async ({ page }) => {
      // protects: "next: Setup checklist" restates as "Take Setup checklist next" (Preview: "Setup checklist is taken next") and Apply shows "Next: Setup checklist" on the meeting screen; "skip Team invite nudges" ("Skip Team invite nudges", Preview "… is skipped") shows "Skipped: Team invite nudges"; skipping the next item clears Next; Undo puts the agenda back as it was
      // fails_when: the strip does not show, does not follow Apply or Undo, or a card has no Preview description
      // no_claim: the order of the PRD's agenda beyond next and skipped (the contract has none)
      await startReview(page);
      await expect(page.getByTestId("agenda-strip")).toHaveCount(0);

      const next = await understood(chat(page), "next: Setup checklist", "Take Setup checklist next");
      await preview(next, "Setup checklist is taken next");
      await apply(next);
      await expect(page.getByTestId("agenda-next")).toHaveText("Next: Setup checklist");

      const skip = await understood(chat(page), "skip Team invite nudges", "Skip Team invite nudges");
      await preview(skip, "Team invite nudges is skipped");
      await apply(skip);
      await expect(page.getByTestId("agenda-skipped")).toHaveText("Skipped: Team invite nudges");
      await expect(page.getByTestId("agenda-next")).toHaveText("Next: Setup checklist");

      const skipNext = await understood(chat(page), "skip Setup checklist", "Skip Setup checklist");
      await apply(skipNext);
      await expect(page.getByTestId("agenda-next")).toHaveCount(0);
      await expect(page.getByTestId("agenda-skipped")).toHaveText("Skipped: Team invite nudges, Setup checklist");

      await tap(skipNext.getByRole("button", { name: "Undo" }));
      await expect(skipNext.getByTestId("chat-card-outcome")).toContainText("Undone");
      await expect(page.getByTestId("agenda-next")).toHaveText("Next: Setup checklist");
      await expect(page.getByTestId("agenda-skipped")).toHaveText("Skipped: Team invite nudges");
    });

    test(`a decision and a new owner and decider from the meeting chat (${where})`, async ({ page }) => {
      // protects: "decision: …" restates as "Record the decision: …" (Preview: "Decision: … — decided by Admin", "In this meeting's decisions") and Apply adds it under All decisions; "Approver owns Setup checklist" ("Make Approver the owner of Setup checklist", Preview "Owner: … → Approver") makes Approver its owner (Oracle then answers "Approver owns Setup checklist."); "Commenter decides Setup checklist" restates and previews the decider; an unknown person gets the contract's question and no card
      // fails_when: the decision is missing from All decisions, the owner does not change, a Preview has no description, or an unknown name makes a card
      // no_claim: the roadmap's own owner chip (simple-roadmap specs), the decider's rights after the change
      await startReview(page);
      const decided = page.getByRole("region", { name: "All decisions" });

      const d = await understood(chat(page), "decision: Keep the checklist to five steps", "Record the decision: Keep the checklist to five steps");
      await preview(d, "Decision: Keep the checklist to five steps — decided by Admin", "In this meeting's decisions");
      await apply(d);
      await expect(d.getByTestId("chat-card-decision")).toHaveText("Recorded as a meeting decision");
      await expect(decided.getByTestId("meeting-decision").filter({ hasText: "Keep the checklist to five steps" })).toBeVisible();

      const own = await understood(chat(page), "Approver owns Setup checklist", "Make Approver the owner of Setup checklist");
      await preview(own, "Owner: ", "→ Approver");
      await apply(own);
      await sayIn(chat(page), "who owns Setup checklist?");
      await expect(chat(page).locator('[data-testid="chat-message"][data-kind="answer"]').last()).toContainText("Approver owns Setup checklist.");

      const dec = await understood(chat(page), "Commenter decides Setup checklist", "Make Commenter the decider of Setup checklist");
      await preview(dec, "Decider: ", "→ Commenter");
      await apply(dec);
      await sayIn(chat(page), "who decides Setup checklist?");
      await expect(chat(page).locator('[data-testid="chat-message"][data-kind="answer"]').last()).toContainText("Commenter decides Setup checklist.");

      const before = await chat(page).getByTestId("chat-card").count();
      await sayIn(chat(page), "Zelda owns Setup checklist");
      await expect(chat(page).locator('[data-testid="chat-message"][data-kind="question"]').last()).toHaveText(/Who is “Zelda”\? Name a person of the company\./);
      await expect(chat(page).getByTestId("chat-card")).toHaveCount(before);

      // The meeting's decision is on the Decisions page too, under its meeting.
      await page.goto("/simple/decisions");
      await expect(page.getByTestId("meeting-group").filter({ hasText: "Keep the checklist to five steps" })).toBeVisible();
    });

    test(`the Ask panel refuses the meeting-only phrases and records a decision on the page (${where})`, async ({ page }) => {
      // protects: on Ask ("This page", the Guided setup PRD), "note: …" and "skip …" get the contract's note and no card; "decision by Approver: …" restates as "Record the decision: …" (Preview "— decided by Approver", "On the Decisions page") and Apply puts it on the Decisions page
      // fails_when: a meeting-only phrase makes a card outside a meeting, or the applied decision is not on the Decisions page
      // no_claim: Oracle's Ask for other lines (simple-ask-one-box.spec.ts)
      await signIn(page, EMAILS.owner, "/simple/prds/guided-setup");
      const panel = await openAsk(page, phone);
      await expect(panel.getByRole("button", { name: "This page" })).toBeVisible();
      const thread = panel.getByTestId("ask-chat-thread");

      await sayIn(panel, "note: Ship the checklist copy first");
      await expect(thread.locator('[data-testid="chat-message"][data-kind="note"]').last()).toHaveText(new RegExp(MEETING_ONLY.replace(/\./g, "\\.")));
      await sayIn(panel, "skip Setup checklist");
      await expect(thread.locator('[data-testid="chat-message"][data-kind="note"]')).toHaveCount(2);
      await expect(thread.getByTestId("chat-card")).toHaveCount(0);

      const d = await understood(panel, "decision by Approver: Guided setup starts with the checklist", "Record the decision: Guided setup starts with the checklist");
      await preview(d, "Decision: Guided setup starts with the checklist — decided by Approver", "On the Decisions page");
      await apply(d);
      await page.goto("/simple/decisions");
      await expect(page.getByRole("region", { name: "Outside meetings" })).toContainText("Guided setup starts with the checklist");
    });

    test(`questions that only contain "owns" or "skip" go to Oracle's Ask (${where})`, async ({ page }) => {
      // protects: on the Ask panel's one box "Which team owns billing?" is not claimed as a "<person> owns <item>" phrase: it opens Oracle's Ask with the line, with no card and no "Who is …?" or "I could not find …"
      // fails_when: a natural question gets a chat-actions refusal or a card
      // no_claim: the model's answer itself (the mock streams a canned reply)
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const panel = await openAsk(page, phone);
      await sayIn(panel, "Which team owns billing?");
      await expect(panel.getByTestId("ask-answer").last()).toBeVisible();
      await expect(panel.getByTestId("ask-chat-thread")).toContainText("Which team owns billing?");
      await expect(panel.getByTestId("discussion-thread")).toHaveCount(0);
      await expect(page.getByText("Name a person of the company")).toHaveCount(0);
      await expect(page.getByText("on the roadmap. Which item")).toHaveCount(0);
      await expect(panel.getByTestId("chat-card")).toHaveCount(0);
    });

    test(`an approver's "owns" proposes; a viewer in a meeting gets no card (${where})`, async ({ page }) => {
      // protects: an approver's "Approver owns In-app tour" on Ask is a card whose button is Propose (they do not decide that item) and Apply proposes it to the owners ("Proposed to Admin by Approver"); a viewer's "note: …" and "Admin owns …" in a meeting chat get the viewers' note and no card
      // fails_when: the approver's card applies, or a viewer gets a card
      // no_claim: accepting the proposal (simple-deciders.spec.ts covers proposals' accept)
      await chatScenario(page);
      await signIn(page, EMAILS.approver, "/simple/roadmap");
      const panel = await openAsk(page, phone);
      const card = await understood(panel, "Approver owns In-app tour", "Make Approver the owner of In-app tour");
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Admin by Approver");
      await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);

      // The viewer, in a tab of their own (each tab keeps its own sign-in; the account menu is in the desktop rail).
      const tab = await page.context().newPage();
      await tab.goto("/home");
      await signOut(tab);
      if (phone) await tab.setViewportSize({ width: 390, height: 844 });
      await signIn(tab, EMAILS.viewer, `/simple/meetings/${CHAT_MEETING_ID}/chat`);
      await expect(tab.getByTestId("chat-rules")).toBeVisible();
      await sayIn(chat(tab), "note: Ship the checklist copy first");
      await expect(chat(tab).locator('[data-testid="chat-message"][data-kind="note"]').last()).toContainText("Viewers ask questions here");
      await sayIn(chat(tab), "Admin owns Setup checklist");
      await expect(chat(tab).locator('[data-testid="chat-message"][data-kind="note"]')).toHaveCount(2);
      await expect(chat(tab).getByTestId("chat-card")).toHaveCount(0);
    });
  });
}

/** The "simple-chat" scenario (S9's invented meeting, Weekly plan review, which the viewer attends). */
async function chatScenario(page: Page) {
  await page.context().addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
}

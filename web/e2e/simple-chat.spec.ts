import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, signOut } from "./helpers";

/*
 * Simple S9: change by chat in a meeting, in the "simple-chat" mock scenario: the invented
 * Weekly plan review, presented by the owner (Admin), with the approver, the commenter and
 * the viewer attending. Each person signs in, in a tab of their own of one browser context
 * (each tab keeps its own sign-in), and opens the meeting's chat (/simple/meetings/{id}/chat:
 * this lane's host of MeetingChat; S8's meeting page owns /simple/meetings/{id} and renders
 * the same MeetingChat in its right column). Every test runs on desktop (1366x820) and on a phone (390x844); one
 * runs in dark.
 */

const EMAILS = { owner: ADMIN.email, approver: "approver@example.com", commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;
const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

/** A tab signed in as `email` on the meeting's page (a later tab signs the earlier person out of itself first). */
async function attend(page: Page, email: string, first: boolean): Promise<Page> {
  const tab = first ? page : await page.context().newPage();
  if (!first) {
    await tab.goto("/home");
    await signOut(tab);
  }
  await tab.goto("/login");
  await tab.getByLabel("Email").fill(email);
  await tab.getByLabel("Password").fill(ADMIN.password);
  await tap(tab.getByRole("button", { name: "Sign in" }));
  await expect(tab).not.toHaveURL(/\/login/);
  await tab.goto(MEETING);
  await expect(tab.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  return tab;
}

const chat = (tab: Page) => tab.getByTestId("meeting-chat");

async function say(tab: Page, text: string) {
  await chat(tab).getByLabel("Message Oracle").fill(text);
  await tap(chat(tab).getByRole("button", { name: "Send" }));
}

const cardOf = (tab: Page, summary: string) => chat(tab).getByTestId("chat-card").filter({ hasText: summary });

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`two attendees share the thread; only the presenter applies; the applied card is a decision (${where})`, async ({ page }) => {
      // protects: the meeting chat is one thread two tabs both see (polled); in "Only the presenter" mode another attendee's card is disabled with why, the presenter's Apply applies it and the card shows who applied it and the meeting decision it became
      // fails_when: the second tab never sees the first tab's line or card, a non-presenter may apply or discard, or the applied card shows no decision
      // no_claim: the real API's meeting rules and record_meeting_decision (api/tests), S8's meeting screen
      const owner = await attend(page, EMAILS.owner, true);
      const approver = await attend(page, EMAILS.approver, false);
      if (phone) await approver.setViewportSize({ width: 390, height: 844 });
      // qa-simple-decide-7: one wording for the rules (start sheet, header, chat).
      await expect(approver.getByTestId("chat-rules")).toContainText("Who changes things: Only the presenter");
      await expect(approver.getByTestId("chat-mode")).toHaveCount(0);

      await say(approver, "rename Setup checklist to First-run checklist");
      const mine = cardOf(approver, "Rename Setup checklist to “First-run checklist”");
      await expect(mine.getByRole("button", { name: "Apply" })).toBeDisabled();
      // The mode that bars them from applying bars them from discarding too.
      await expect(mine.getByRole("button", { name: "Discard" })).toBeDisabled();
      await expect(mine.getByTestId("chat-card-why-not")).toHaveText("Only the presenter applies changes in this meeting");

      // The presenter's tab sees the approver's line and card, and may apply it.
      await owner.bringToFront();
      await expect(chat(owner).getByTestId("chat-message-body").filter({ hasText: "rename Setup checklist to First-run checklist" })).toBeVisible();
      const theirs = cardOf(owner, "Rename Setup checklist");
      await tap(theirs.getByRole("button", { name: "Apply" }));
      await expect(theirs.getByTestId("chat-card-outcome")).toContainText("Applied by you");
      await expect(theirs.getByTestId("chat-card-decision")).toHaveText("Recorded as a meeting decision");

      // The approver's tab sees it applied.
      await approver.bringToFront();
      await expect(mine.getByTestId("chat-card-outcome")).toContainText("Applied by Admin");
      await expect(mine.getByTestId("chat-card-decision")).toBeVisible();
    });

    test(`the presenter's change mode decides who may apply (${where})`, async ({ page }) => {
      // protects: the presenter's control switches Everyone / Only the presenter / Presenter + named people; under Everyone a non-deciding attendee's Apply is "Propose" (the change engine's rule); under named, only the named may act
      // fails_when: the mode change does not reach the other tab, a non-named attendee may act, or a non-decider's button applies instead of proposing
      // no_claim: who decides each item (simple-deciders.spec.ts), more than two named people (the API refuses)
      const owner = await attend(page, EMAILS.owner, true);
      const approver = await attend(page, EMAILS.approver, false);
      if (phone) await approver.setViewportSize({ width: 390, height: 844 });
      await say(approver, "move In-app tour to next");
      const card = cardOf(approver, "Move In-app tour to Next");
      await expect(card.getByTestId("chat-card-why-not")).toHaveText("Only the presenter applies changes in this meeting");

      await owner.bringToFront();
      await owner.getByLabel("Who changes things").selectOption("everyone");
      await expect(owner.getByLabel("Who changes things")).toHaveValue("everyone");
      await approver.bringToFront();
      await expect(approver.getByTestId("chat-rules")).toContainText("Who changes things: Everyone");
      await expect(card.getByRole("button", { name: "Propose" })).toBeEnabled();

      await owner.bringToFront();
      await owner.getByLabel("Who changes things").selectOption("named");
      await owner.getByTestId("chat-mode").getByLabel("Commenter").check();
      await expect(owner.getByLabel("Who changes things")).toHaveValue("named");
      await expect(owner.getByTestId("chat-mode").getByLabel("Commenter")).toBeChecked();
      await approver.bringToFront();
      await expect(card.getByTestId("chat-card-why-not")).toHaveText("Only the presenter and the people they named apply changes in this meeting");

      await owner.bringToFront();
      await owner.getByTestId("chat-mode").getByLabel("Approver").check();
      await expect(owner.getByTestId("chat-mode").getByLabel("Approver")).toBeChecked();
      await approver.bringToFront();
      await expect(approver.getByTestId("chat-rules")).toContainText("Presenter plus Commenter, Approver");
      await owner.bringToFront();
      await approver.bringToFront();
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Admin by you");
      await expect(card.getByTestId("chat-card-decision")).toHaveCount(0);
    });

    test(`a viewer asks only; an ambiguous request gets one question (${where})`, async ({ page }) => {
      // protects: a viewer's composer says it changes nothing and points questions to Ask Oracle, their change request gets a note and no card, their question an answer; "move alert to Q2" (several items) gets one "Which one" question and no card
      // fails_when: a viewer gets a change card, the composer does not say ask-only, or an ambiguous request makes a card or more than one reply
      // no_claim: Oracle's wording beyond the contract's examples
      const viewer = await attend(page, EMAILS.viewer, true);
      // qa-simple-decide-3: the meeting's chat makes changes and notes; a question goes to Ask Oracle.
      await expect(chat(viewer).getByTestId("chat-hint")).toHaveText("Viewers ask questions here; the presenter makes changes and notes.");
      await say(viewer, "move Weekly alert digest to Q2");
      await expect(chat(viewer).locator('[data-testid="chat-message"][data-kind="note"]')).toContainText("Viewers ask questions here");
      await say(viewer, "when is Weekly alert digest?");
      await expect(chat(viewer).locator('[data-testid="chat-message"][data-kind="answer"]')).toContainText("Weekly alert digest:");
      await expect(chat(viewer).getByTestId("chat-card")).toHaveCount(0);

      const owner = await attend(page, EMAILS.owner, false);
      if (phone) await owner.setViewportSize({ width: 390, height: 844 });
      const before = await chat(owner).getByTestId("chat-message").count();
      await say(owner, "move alert to Q2");
      const question = chat(owner).locator('[data-testid="chat-message"][data-kind="question"]');
      await expect(question).toHaveCount(1);
      await expect(question).toContainText("Which one: Alert rules engine, Weekly alert digest, Mobile alert push, Alert history export or Alert routing by team?");
      await expect(chat(owner).getByTestId("chat-message")).toHaveCount(before + 2);
      await expect(chat(owner).getByTestId("chat-card")).toHaveCount(0);
    });
  });
}

test.describe("desktop, dark", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addInitScript(
      ([key, themeKey]) => {
        localStorage.setItem(key, "simple-chat");
        localStorage.setItem(themeKey, "dark");
      },
      [MOCK_SCENARIO_KEY, THEME_KEY],
    );
    await page.emulateMedia({ colorScheme: "dark" });
  });

  test("preview then discard leaves the plan as it was (desktop, dark)", async ({ page }) => {
    // protects: Preview then Discard writes nothing: the card says so, offers no Undo, and the roadmap's bar keeps its dates; in dark
    // fails_when: Discard writes the change, the card stays open, or the bar moves
    // no_claim: the ghost on the roadmap (simple-ask-changes.spec.ts draws it beside the chart)
    await page.goto("/login");
    await page.getByLabel("Email").fill(EMAILS.owner);
    await page.getByLabel("Password").fill(ADMIN.password);
    await tap(page.getByRole("button", { name: "Sign in" }));
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto("/simple/roadmap");
    const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
    const start = await bar.getAttribute("data-start");
    expect(start).toBeTruthy();
    await page.goto(MEETING);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await say(page, "move Weekly alert digest to Q2");
    const card = cardOf(page, "Move Weekly alert digest to");
    await tap(card.getByRole("button", { name: "Preview" }));
    await expect(card.getByRole("button", { name: "Hide preview" })).toHaveAttribute("aria-pressed", "true");
    await tap(card.getByRole("button", { name: "Discard" }));
    await expect(card.getByTestId("chat-card-outcome")).toHaveText("Discarded: nothing changed");
    await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await tap(page.getByRole("link", { name: "Roadmap" }).first());
    await expect(bar).toHaveAttribute("data-start", start!);
  });
});

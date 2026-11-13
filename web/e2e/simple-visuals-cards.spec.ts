import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";

/*
 * Simple S10 (#723): a meeting chat card's flow and a goal suggestion's flow open in the one
 * flow viewer (FlowPanel: the row thumbnail, opened across the page or a full-height sheet on a
 * phone, full screen with its numbered notes, Comment and Revise), against the mock's
 * `chat_card` and `suggestion` visuals. Invented data; desktop 1366x820 and phone 390x844.
 */

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;
const ASK = "Snooze alerts for a day";

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** An attendee (by default the owner, the meeting's presenter) in the meeting's chat, with a feature ask's card. */
async function askInMeeting(page: Page, email: string = ADMIN.email): Promise<Locator> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(MEETING);
  const chat = page.getByTestId("meeting-chat");
  await chat.getByLabel("Message Oracle").fill(`feature ask: ${ASK}`);
  await tap(chat.getByRole("button", { name: "Send" }));
  const card = chat.getByTestId("chat-card").filter({ hasText: `New feature ask: ${ASK}` });
  await expect(card).toHaveCount(1);
  return card;
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a meeting chat card's flow opens full screen with its numbered notes (${where})`, async ({ page }) => {
      // protects: a chat card's flow is its chat_card visual in the one viewer: the row thumbnail opens it, Full screen shows it over the meeting, Comment shows its numbered notes
      // fails_when: the card shows the old 4-box picture and plain step list, or the viewer has no full screen or no notes
      // no_claim: the real drawing job (api tests of oracle.simple.visuals)
      const card = await askInMeeting(page);
      await tap(card.getByRole("button", { name: `Open the flow for ${ASK}` }));
      const opened = page.getByTestId("flow-detail");
      await expect(opened.getByTestId("flow-svg")).toBeVisible();
      await opened.getByRole("button", { name: "Full screen" }).click();
      const full = page.getByTestId("flow-fullscreen");
      await expect(full).toBeVisible();
      const box = (await full.boundingBox())!;
      expect(Math.round(box.height)).toBe(page.viewportSize()!.height);
      await full.getByRole("button", { name: "Comment" }).click();
      const notes = full.getByTestId("flow-annotations").getByRole("listitem");
      await expect(notes).toHaveCount(2);
      await expect(notes.first()).toContainText("1");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(full).toHaveCount(0);
    });

    test(`an attendee who is no owner reads a chat card's flow and comments on it (${where})`, async ({ page }) => {
      // protects: a meeting attendee who is no owner opens a chat card's flow (its chat_card visual) and comments; Revise is the owners'
      // fails_when: the attendee is told "No such visual", cannot comment, or is offered Revise
      // no_claim: the real API's rule (api tests: test_card_and_suggestion_visuals_follow_who_reads_them)
      const card = await askInMeeting(page, "approver@example.com");
      await tap(card.getByRole("button", { name: `Open the flow for ${ASK}` }));
      await expect(page.getByTestId("flow-detail").getByTestId("flow-svg")).toBeVisible();
      await page.getByTestId("flow-detail").getByRole("button", { name: "Comment" }).click();
      const full = page.getByTestId("flow-fullscreen");
      const panel = full.getByTestId("flow-comments-panel");
      await panel.getByLabel("Comment on the flow").fill("Snooze for a week too");
      await panel.getByRole("button", { name: "Post comment" }).click();
      await expect(panel.getByTestId("flow-comments")).toContainText("Snooze for a week too");
      await expect(panel.getByTestId("flow-version")).toHaveText("Version 1 of 1");
      await expect(full.getByRole("button", { name: "Revise" })).toHaveCount(0);
    });

    test(`the presenter revises a chat card's flow from a comment (${where})`, async ({ page }) => {
      // protects: a chat card's flow takes a comment and the owner's Revise draws version 2, which the card's row then shows
      // fails_when: the card's flow has no Comment or Revise, or the row still reads version 1
      // no_claim: who may revise in the real API (api tests: visuals.may_revise)
      const card = await askInMeeting(page);
      await tap(card.getByRole("button", { name: `Open the flow for ${ASK}` }));
      await page.getByTestId("flow-detail").getByRole("button", { name: "Comment" }).click();
      const full = page.getByTestId("flow-fullscreen");
      const panel = full.getByTestId("flow-comments-panel");
      await panel.getByLabel("Comment on the flow").fill("Snooze for a week too");
      await panel.getByRole("button", { name: "Post comment" }).click();
      await expect(panel.getByTestId("flow-comments")).toContainText("Snooze for a week too");
      await panel.getByRole("button", { name: "Revise" }).click();
      await expect(panel.getByTestId("flow-version")).toHaveText("Version 2 of 2");
      await full.getByRole("button", { name: /Exit/ }).click();
      await page.keyboard.press("Escape");
      await expect(card.getByTestId("flow-drawn")).toContainText("Version 2");
    });

    test(`a commenter opens a goal suggestion's flow in the panel and comments on it (${where})`, async ({ page }) => {
      // protects: a goal suggestion's flow is its suggestion visual in the one viewer, opened in the goal's panel by a commenter (no owner), and takes a comment
      // fails_when: the suggestion shows the old plain step list, a commenter is told "No such visual", or its flow cannot be commented on
      // no_claim: the suggestion job's ideas (api tests of oracle.simple.additions)
      await page.context().addInitScript((key) => localStorage.setItem(key, "default"), MOCK_SCENARIO_KEY);
      await login(page, "commenter@example.com");
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await tap(page.getByTestId("goal-counter-empty").getByTestId("goal-counter-suggestions"));
      const panel = page.getByTestId("goal-panel");
      await panel.getByRole("tab", { name: /Oracle/ }).click();
      const s = panel.locator('[data-testid="goal-suggestion"][data-title="Quiet hours for alerts"]');
      await tap(s.getByRole("button", { name: "Show the flow" }));
      // Widened in place in the panel on a desktop, a full-height sheet on a phone (as Priorities' proposals).
      const opened = (phone ? page.getByTestId("flow-sheet") : s).getByTestId("flow-detail");
      await expect(opened.getByTestId("flow-svg")).toBeVisible();
      await expect(opened.getByTestId("flow-drawn")).toContainText("Version 1");
      const comments = opened.getByTestId("flow-comments-panel");
      await comments.getByLabel("Comment on the flow").fill("Let teams pick the hours");
      await comments.getByRole("button", { name: "Post comment" }).click();
      await expect(comments.getByTestId("flow-comments")).toContainText("Let teams pick the hours");
      await expect(comments.getByRole("button", { name: "Revise" })).toHaveCount(0);
    });
  });
}

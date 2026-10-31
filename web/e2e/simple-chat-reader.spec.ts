import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * chat-reader: a line Oracle's fixed parser does not know goes to Oracle's reader (an async
 * job). The line shows "Reading that…" while the thread polls; then the reader restates what
 * it understood with one card per change ("I understood two changes:" and Apply all), asks
 * "Which item?" with clickable choices, refuses plainly, fails with Retry, or (the Ask panel's
 * one box) hands a question to Oracle's Ask. The "simple-chat" mock scenario (the mock's today:
 * Oct 22 2026) with its invented Delivery integrity and release safety and Delivery pipeline
 * v2; the mock's reader is deterministic (keyword rules, no model). Desktop (1366x820) and
 * phone (390x844), light and dark.
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;
const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

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

/** The meeting's chat, signed in as `email`. */
async function meeting(page: Page, email: string): Promise<Locator> {
  await signIn(page, email, MEETING);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  return page.getByTestId("meeting-chat");
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone): the visible panel. */
async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

const last = (box: Locator) => box.getByTestId("chat-message").last();
const card = (box: Locator, summary: string) => box.getByTestId("chat-card").filter({ hasText: summary });

for (const [phone, dark] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  const where = `${phone ? "phone" : "desktop"}, ${dark ? "dark" : "light"}`;
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(
        ([key, themeKey, theme]) => {
          localStorage.setItem(key, "simple-chat");
          localStorage.setItem(themeKey, theme);
        },
        [MOCK_SCENARIO_KEY, THEME_KEY, dark ? "dark" : "light"] as const,
      );
      if (dark) await page.emulateMedia({ colorScheme: "dark" });
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`meeting chat: a free-form line is read, restated with its card, and applies (${where})`, async ({ page }) => {
      // protects: a line the fixed parser does not know shows "Reading that…" then (polled, no reload) "I understood one change:" with one move card three months on; the presenter applies it; "… and make <person> own it" restates the date change and the new owner (chat-join)
      // fails_when: the line gets "I did not understand", the pending line never resolves without a reload, the restated line or the card is missing, or the owner half makes no card
      // no_claim: the real reader's model output (api tests with a fake model)
      const chat = await meeting(page, EMAILS.owner);
      if (dark) await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await say(chat, "can we push Delivery pipeline v2 out a quarter");
      await expect(chat.getByTestId("chat-pending").or(chat.getByText("I understood one change."))).toBeVisible();
      await expect(last(chat)).toHaveAttribute("data-kind", "cards");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I understood one change.");
      await expect(chat.getByTestId("chat-pending")).toHaveCount(0);
      const moved = card(chat, "Move Delivery pipeline v2 to Apr 11");
      await expect(moved).toHaveCount(1);
      await expect(last(chat).getByRole("button", { name: "Apply all" })).toHaveCount(0);
      await tap(moved.getByRole("button", { name: "Apply" }));
      await expect(moved.getByTestId("chat-card-outcome")).toContainText("Applied by you");

      // chat-join: the owner half is chat-actions' set_owner, a second card.
      await say(chat, "push Delivery integrity and release safety to next quarter and make Commenter own it");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I understood two changes.");
      await expect(last(chat).getByTestId("chat-card")).toHaveCount(2);
      await expect(last(chat).getByTestId("chat-card").first()).toContainText("Move Delivery integrity and release safety to Jan 1");
      await expect(last(chat).getByTestId("chat-card").last()).toContainText("Make Commenter the owner of Delivery integrity and release safety");
      await expect(page.getByText("I did not understand that.")).toHaveCount(0);
    });

    test(`meeting chat: two changes get two cards and Apply all; it stops at the first that cannot apply (${where})`, async ({ page }) => {
      // protects: a line with two changes restates "I understood two changes:" with two cards and one Apply all, which applies both; a line whose second card cannot apply (its item changed under the first) applies the first, says "Applied 1 of 2. Stopped at …: <why>" and leaves the second open
      // fails_when: one card shows for two changes, Apply all is missing or applies past a card that cannot apply, the stop is silent, or the rest are not left open
      // no_claim: the order of more than two cards (api tests), proposals' routing (simple-chat.spec.ts)
      const chat = await meeting(page, EMAILS.owner);
      await say(chat, "push Delivery pipeline v2 to next quarter and cut Delivery integrity and release safety");
      const line = last(chat);
      await expect(line.getByTestId("chat-message-body")).toHaveText("I understood two changes.");
      await expect(line.getByTestId("chat-card")).toHaveCount(2);
      await expect(card(line, "Move Delivery pipeline v2 to")).toHaveCount(1);
      await expect(card(line, "Cut Delivery integrity and release safety")).toHaveCount(1);
      await tap(line.getByRole("button", { name: "Apply all" }));
      await expect(line.locator('[data-testid="chat-card"][data-status="applied"]')).toHaveCount(2);
      await expect(line.getByRole("button", { name: "Apply all" })).toHaveCount(0);

      await say(chat, "push Delivery pipeline v2 out a quarter and push it to next quarter");
      const two = last(chat);
      await expect(two.getByTestId("chat-message-body")).toHaveText("I understood two changes.");
      await expect(two.getByTestId("chat-card")).toHaveCount(2);
      await tap(two.getByRole("button", { name: "Apply all" }));
      const said = two.getByRole("status").filter({ hasText: "Applied 1 of 2." });
      await expect(said).toContainText(/^Applied 1 of 2\. Stopped at “Move Delivery pipeline v2 to .+”: Changed since you saw it.*\.$/);
      await expect(two.locator('[data-testid="chat-card"][data-status="applied"]')).toHaveCount(1);
      await expect(two.locator('[data-testid="chat-card"][data-status="open"]')).toHaveCount(1);
    });

    test(`meeting chat: an ambiguous line asks which item; a pick makes the card, Neither asks again (${where})`, async ({ page }) => {
      // protects: "move delivery to next quarter" and the reader's "push delivery to next quarter" ask which item with one button per item and Neither last (a group named Choices); a pick posts the item's name as the person's line and Oracle's one card; Neither gets "Say it another way." and no card; picked choices close
      // fails_when: no choices row, a pick makes no card or the wrong item's, Neither makes a card, or the choices stay clickable after a pick
      // no_claim: more than five matching items (the list is cut at five)
      const chat = await meeting(page, EMAILS.owner);
      await say(chat, "move delivery to next quarter");
      const asked = chat.getByTestId("chat-message").filter({ has: page.getByTestId("chat-choices") }).last();
      const choices = asked.getByRole("group", { name: "Choices" });
      await expect(choices.getByRole("button")).toHaveText(["Delivery integrity and release safety", "Delivery pipeline v2", "Neither"]);
      await tap(choices.getByRole("button", { name: "Delivery pipeline v2" }));
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I understood one change.");
      await expect(last(chat).getByTestId("chat-card")).toContainText("Move Delivery pipeline v2 to Jan 1");
      await expect(chat.locator('[data-testid="chat-message"][data-author="person"]').last().getByTestId("chat-message-body")).toHaveText("Delivery pipeline v2");
      for (const b of await choices.getByRole("button").all()) await expect(b).toBeDisabled();

      await say(chat, "push delivery to next quarter");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("Which item?");
      const again = last(chat).getByRole("group", { name: "Choices" });
      await expect(again.getByRole("button")).toHaveText(["Delivery integrity and release safety", "Delivery pipeline v2", "Neither"]);
      const cards = await chat.getByTestId("chat-card").count();
      await tap(again.getByRole("button", { name: "Neither" }));
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("Say it another way.");
      await expect(chat.getByTestId("chat-card")).toHaveCount(cards);
    });

    test(`meeting chat: nonsense is refused plainly; a failed read retries (${where})`, async ({ page }) => {
      // protects: a line with no change gets a plain note and no card; a read that fails says "I couldn't read that just now." with a Retry button, and Retry reads it again into the restated line and its card
      // fails_when: nonsense makes a card or a question, a failed read shows no Retry, or Retry does not end in the card
      // no_claim: why the real reader fails (timeouts, the model's errors: api tests)
      const chat = await meeting(page, EMAILS.owner);
      await say(chat, "purple monkey dishwasher");
      await expect(last(chat)).toHaveAttribute("data-kind", "note");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I could not tell what to change. Say it another way.");
      await expect(chat.getByTestId("chat-card")).toHaveCount(0);
      await expect(chat.getByTestId("chat-choices")).toHaveCount(0);

      await say(chat, "flaky line: push Delivery pipeline v2 to next quarter");
      await expect(last(chat)).toHaveAttribute("data-kind", "failed");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I couldn't read that just now.");
      await tap(last(chat).getByRole("button", { name: "Retry" }));
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("I understood one change.");
      await expect(last(chat).getByRole("button", { name: "Retry" })).toHaveCount(0);
      await expect(card(chat, "Move Delivery pipeline v2 to Jan 1")).toHaveCount(1);
    });

    test(`meeting chat: a viewer's free-form change gets the ask-the-presenter note (${where})`, async ({ page }) => {
      // protects: a viewer's line read by the reader as a change gets the viewers' note in the meeting and no card
      // fails_when: a viewer gets a card or Apply all from the reader
      // no_claim: a viewer's questions (simple-chat.spec.ts)
      const chat = await meeting(page, EMAILS.viewer);
      await say(chat, "can we push Delivery pipeline v2 out a quarter");
      await expect(last(chat)).toHaveAttribute("data-kind", "note");
      await expect(last(chat).getByTestId("chat-message-body")).toHaveText("Viewers ask questions here; ask the presenter to make a change.");
      await expect(chat.getByTestId("chat-card")).toHaveCount(0);
    });

    test(`Ask "This page": a free-form change is restated with its card; a question goes to Oracle's Ask (${where})`, async ({ page }) => {
      // protects: in the Ask panel's one box (This page) a commenter's free-form change is read into "I understood one change:" with a card they may propose, and Apply all shows for two open cards; a question the reader finds goes to Oracle's Ask chat about the page with the line in it, once
      // fails_when: the change goes to Ask, the card is applied instead of proposed, or the question stays in the plan thread with no Ask chat
      // no_claim: the model's Ask answer (the mock streams a canned reply)
      await signIn(page, EMAILS.commenter, "/simple/roadmap");
      const panel = await openAsk(page, phone);
      const thread = panel.getByTestId("ask-chat-thread");
      await say(panel, "can we push Delivery pipeline v2 out a quarter");
      await expect(last(thread).getByTestId("chat-message-body")).toHaveText("I understood one change:");
      const moved = card(thread, "Move Delivery pipeline v2 to Apr 11");
      await expect(moved.getByRole("button", { name: "Propose" })).toBeEnabled();

      await say(panel, "push Delivery pipeline v2 to next quarter and cut Delivery integrity and release safety");
      await expect(last(thread).getByTestId("chat-message-body")).toHaveText("I understood two changes:");
      // qa-simple-decide-13: a commenter's cards all propose, so the line says Propose all.
      await expect(last(thread).getByRole("button", { name: "Propose all" })).toBeVisible();

      await say(panel, "why is Delivery pipeline v2 after the integrity work");
      // ask-fresh: Oracle's Ask answers in the same chat (no discussion screen in Simple).
      await expect(thread.getByTestId("ask-answer").last()).toBeVisible();
      await expect(thread.getByTestId("chat-message-body").filter({ hasText: "why is Delivery pipeline v2 after the integrity work" })).toHaveCount(1);
      await expect(panel.getByTestId("discussion-thread")).toHaveCount(0);
      await expect(page.getByText("I did not understand that.")).toHaveCount(0);
    });
  });
}

test.describe("chat-reader review", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(([key]) => localStorage.setItem(key, "simple-chat"), [MOCK_SCENARIO_KEY] as const);
  });

  test("meeting chat: a question gets the same note as the API", async ({ page }) => {
    // protects: in the meeting chat a line the reader reads as a question gives the API's own words, "Kept as a question for the minutes. For an answer now, use Ask Oracle."
    // fails_when: the mock says something the API never says ("That reads as a question…")
    // no_claim: Ask's one box (it goes to Oracle's Ask)
    const chat = await meeting(page, EMAILS.owner);
    await say(chat, "why is Delivery pipeline v2 after the integrity work?");
    await expect(last(chat)).toHaveAttribute("data-kind", "note");
    await expect(last(chat).getByTestId("chat-message-body")).toHaveText("Kept as a question for the minutes. For an answer now, use Ask Oracle.");
  });

  test("Ask: a line handed to Oracle's Ask leaves nothing in the plan thread", async ({ page }) => {
    // protects: a question the reader hands to Oracle's Ask shows neither the person's line nor "Asking Oracle…" in the plan thread (This page)
    // fails_when: the plan thread keeps "Asking Oracle…" and the person's line
    // no_claim: the model's Ask answer (the mock streams a canned reply)
    await signIn(page, EMAILS.commenter, "/simple/roadmap");
    const panel = await openAsk(page, false);
    await say(panel, "why is Delivery pipeline v2 after the integrity work");
    await expect(panel.getByTestId("ask-answer").last()).toBeVisible();
    // ask-fresh: the same chat shows the line once (as Ask's), never "Asking Oracle…" from the plan reader.
    const thread = panel.getByTestId("ask-chat-thread");
    await say(panel, "can we push Delivery pipeline v2 out a quarter");
    await expect(last(thread).getByTestId("chat-message-body")).toHaveText("I understood one change:");
    await expect(thread.getByText("Asking Oracle…")).toHaveCount(0);
    await expect(thread.getByText("why is Delivery pipeline v2 after the integrity work")).toHaveCount(1);
  });

  test("Ask chat: a line still being read after the first wait goes to Oracle's Ask when read", async ({ page }) => {
    // protects: in the panel's chat a line the reader is still reading after a long wait (25 reads) is handed to Oracle's Ask once the reader reads it as a question
    // fails_when: the slow line stays "Asking Oracle…" and never reaches Ask
    // no_claim: the model's Ask answer (the mock streams a canned reply)
    test.setTimeout(150_000);
    await signIn(page, EMAILS.commenter, "/simple/roadmap");
    const panel = await openAsk(page, false);
    await say(panel, "why is Delivery pipeline v2 after the integrity work");
    const thread = panel.getByTestId("ask-chat-thread");
    await expect(thread.getByTestId("ask-answer")).toHaveCount(1);
    await say(panel, "why is Delivery pipeline v2 moving so slowly");
    await expect(thread.getByTestId("ask-answer")).toHaveCount(2, { timeout: 90_000 });
    await expect(thread.getByTestId("chat-message-body").filter({ hasText: "why is Delivery pipeline v2 moving so slowly" })).toHaveCount(1);
    await expect(panel.getByText("Asking Oracle…")).toHaveCount(0);
  });
});

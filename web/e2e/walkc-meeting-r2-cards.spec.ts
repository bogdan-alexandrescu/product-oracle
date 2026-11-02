import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * walkc-meeting r2: the chat cards of a live review meeting (the "simple-chat" scenario's
 * Weekly plan review, as the company's owner, who presents it), desktop and phone.
 *
 * Card move-before-basis (5b): protects = a move card on an item the engineering lead dated
 * (Mobile alert push: no dates of its own) says Before with the dates it has now and "Dates
 * from engineering"; fails_when = Before reads "Estimated by Oracle"; no_claim = items with
 * their own dates (simple-roadmap-talk.spec.ts), the API's `current` (api
 * tests/test_walkc_meeting.py).
 *
 * Card preview-in-meeting (5c): protects = Preview on a move card in the meeting's chat shows
 * what the change does, in the card ("After this change: Mobile alert push moves to Jan 1 –
 * ..."), and Hide preview takes it away; fails_when = Preview draws nothing (only the roadmap
 * page draws its ghost); no_claim = the roadmap's ghost (qa4r-card.spec.ts).
 *
 * Card task-no-preview (5g): protects = a task line's card has no Preview, no date warning,
 * and Oracle's line does not ask to preview it ("Here is the change. Apply or discard it.");
 * fails_when = the line says "Preview it" or the card shows the item's red warning (the API's
 * part: api tests/test_walkc_meeting.py); no_claim = the task's own fields.
 */

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meetingChat(page: Page): Promise<{ chat: Locator; say: (text: string) => Promise<void> }> {
  await login(page);
  await page.goto(MEETING);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  const chat = page.getByTestId("meeting-chat");
  const say = async (text: string) => {
    await chat.getByLabel("Message Oracle").fill(text);
    await tap(chat.getByRole("button", { name: "Send" }));
  };
  return { chat, say };
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 } });
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
    });

    test(`a move card's Before says the engineering lead's dates, and Preview shows the change (${where})`, async ({ page }) => {
      const { chat, say } = await meetingChat(page);
      await say("move Mobile alert push to next quarter");
      const card = chat.getByTestId("chat-card").filter({ hasText: "Move Mobile alert push to Jan 1" });
      const change = card.getByTestId("chat-card-change");
      await expect(change).toContainText("Before:");
      await expect(change).toContainText("Dates from engineering");
      await expect(change).not.toContainText("Estimated by Oracle");
      await expect(change).toContainText("After: Jan 1 –");

      await expect(card.getByTestId("chat-card-preview")).toHaveCount(0);
      await tap(card.getByRole("button", { name: "Preview" }));
      const preview = card.getByTestId("chat-card-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("After this change: Mobile alert push moves to Jan 1 –");
      await tap(card.getByRole("button", { name: "Hide preview" }));
      await expect(card.getByTestId("chat-card-preview")).toHaveCount(0);
    });

    test(`a task card has no Preview, no date warning, and its line does not ask to preview it (${where})`, async ({ page }) => {
      const { chat, say } = await meetingChat(page);
      await say("add a task 'Write the FAQ' to Weekly alert digest");
      const card = chat.getByTestId("chat-card").filter({ hasText: "Add the task “Write the FAQ” to Weekly alert digest" });
      await expect(card).toBeVisible();
      await expect(chat.getByTestId("chat-message-body").filter({ hasText: "Here is the change" })).toHaveText("Here is the change. Apply or discard it.");
      await expect(chat.getByText(/Preview it/)).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Preview" })).toHaveCount(0);
      await expect(card.getByTestId("chat-card-flag")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
    });
  });
}

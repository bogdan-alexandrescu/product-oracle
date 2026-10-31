import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID, STRAY_REPLY } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * meet-chat-kind: a meeting's chat that already holds a line an earlier build's discussion
 * reply job wrote there (the "simple-chat-stray" mock scenario) still reads: that line shows as
 * Oracle's answer, and a change asked after it gets the chat reader's card. Desktop and phone.
 */

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meeting(page: Page): Promise<Locator> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(MEETING);
  return page.getByTestId("meeting-chat");
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(([key]) => localStorage.setItem(key, "simple-chat-stray"), [MOCK_SCENARIO_KEY] as const);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a stray discussion reply reads as Oracle's answer and the chat keeps answering (${where})`, async ({ page }) => {
      // protects: an Oracle line whose stored kind is not a chat kind (an earlier build's discussion_reply.v2) shows as an answer with its words, and a change asked after it gets the reader's card
      // fails_when: the stray line shows with its prompt id as its kind, or the chat stops answering after it
      // no_claim: how the stray line got there (api tests: the discussion reply sweep leaves Simple chats alone)
      const chat = await meeting(page);
      const stray = chat.getByTestId("chat-message").filter({ hasText: STRAY_REPLY });
      await expect(stray).toHaveCount(1);
      await expect(stray).toHaveAttribute("data-kind", "answer");
      await chat.getByRole("textbox", { name: "Message Oracle" }).fill("can we push Delivery pipeline v2 out a quarter");
      await tap(chat.getByRole("button", { name: "Send" }));
      const last = chat.getByTestId("chat-message").last();
      await expect(last).toHaveAttribute("data-kind", "cards");
      await expect(last.getByTestId("chat-card")).toHaveCount(1);
      await expect(stray).toHaveAttribute("data-kind", "answer");
    });
  });
}

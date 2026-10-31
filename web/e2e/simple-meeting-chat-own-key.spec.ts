import { expect, test, type Locator, type Page } from "./test";

import { ADMIN } from "./helpers";

/*
 * meet-chat-own-key: a meeting's chat has its own discussion, apart from the Ask panel on the
 * meeting's page. A question asked in the Ask panel shows only there; a line posted in the
 * meeting's chat shows only in the chat. Desktop (1440x900) and phone (390x844). On a phone the
 * meeting screen covers the header's Ask button, so the phone run asks on a desktop-wide
 * window (as from a laptop) and reads and writes the meeting chat on the phone.
 *
 * Card: protects = on a review meeting's page, the Ask panel's question (and Oracle's answer)
 * never shows in the meeting chat, and the meeting chat's line never shows in the Ask chat
 * reopened from Recent chats; fails_when = either message shows in the other place (the
 * meeting chat adopting the Ask panel's discussion, or the other way round); no_claim = the
 * answers' words (api: test_simple_meeting_chat_own_key).
 */

const ASK = "Who is still waiting on this review?";
const CHAT = "Let's look at the setup numbers next.";

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple/prds/guided-setup");
  await tap(page.getByRole("button", { name: "Start review" }));
  const sheet = page.getByRole("dialog", { name: "Start a review" });
  await sheet.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
  await expect(page).toHaveURL(/\/simple\/meetings\/[^/]+$/);
}

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Opens Ask Oracle over the meeting screen (it covers the rail): ⌘J, as a person would. */
async function openAsk(page: Page): Promise<Locator> {
  await page.setViewportSize(DESKTOP);
  await page.keyboard.press("ControlOrMeta+j");
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  return ask;
}

async function closeAsk(page: Page) {
  await tap(page.getByRole("button", { name: "Close Ask Oracle" }).filter({ visible: true }).first());
  await expect(page.getByTestId("ask-chat").filter({ visible: true })).toHaveCount(0);
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? PHONE : DESKTOP });
    const toChat = async (page: Page) => {
      if (phone) await page.setViewportSize(PHONE);
    };

    test(`the Ask panel and the meeting chat each keep their own messages (${where})`, async ({ page }) => {
      test.setTimeout(90_000);
      await startReview(page);

      // Ask first, before anyone writes in the meeting's chat.
      const ask = await openAsk(page);
      await ask.getByLabel("Message Oracle").fill(ASK);
      await tap(ask.getByRole("button", { name: "Send" }));
      await expect(ask.getByTestId("chat-message").filter({ hasText: ASK })).toHaveCount(1);
      await expect(ask.getByTestId("ask-answer").last()).toBeVisible();
      await closeAsk(page);
      await toChat(page);

      // The meeting chat starts empty of the Ask question, then holds only its own line.
      const chat = page.getByTestId("meeting-chat");
      await expect(chat).toBeVisible();
      await expect(chat).not.toContainText(ASK);
      await chat.getByRole("textbox", { name: "Message Oracle" }).fill(CHAT);
      await tap(chat.getByRole("button", { name: "Send" }));
      await expect(chat.getByTestId("chat-message").filter({ hasText: CHAT })).toHaveCount(1);
      await expect(chat).not.toContainText(ASK);

      // The Ask chat, reopened from Recent chats, holds the question and not the chat's line.
      const again = await openAsk(page);
      await tap(page.getByTestId("ask-recent").filter({ visible: true }).first());
      await tap(page.getByTestId("ask-recent-row").filter({ hasText: ASK }).first());
      await expect(again.getByTestId("chat-message").filter({ hasText: ASK })).toHaveCount(1);
      await expect(again).not.toContainText(CHAT);
      await closeAsk(page);
      await toChat(page);

      // After a reload each place still shows only its own message.
      await page.reload();
      await expect(chat.getByTestId("chat-message").filter({ hasText: CHAT })).toHaveCount(1);
      await expect(chat).not.toContainText(ASK);
    });
  });
}

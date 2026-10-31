import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * meet-chat-right-prd: a review meeting's chat reads the meeting's own PRD. In the
 * "meet-chat-right-prd" mock scenario the meeting reviews Guided setup, whose new draft's
 * features are only on its draft roadmap (Setup checklist first); Usage alerts, another PRD,
 * keeps its items (Delivery pipeline v2) on its roadmap. Desktop and phone.
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

async function say(chat: Locator, text: string): Promise<Locator> {
  const before = await chat.getByTestId("chat-message").count();
  await chat.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(chat.getByRole("button", { name: "Send" }));
  await expect(chat.getByTestId("chat-message")).toHaveCount(before + 2);
  const last = chat.getByTestId("chat-message").last();
  await expect(last).not.toHaveAttribute("data-kind", "pending");
  return last;
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(([key]) => localStorage.setItem(key, "meet-chat-right-prd"), [MOCK_SCENARIO_KEY] as const);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a move of the meeting PRD's first feature gets its change card (${where})`, async ({ page }) => {
      // protects: "Move <the meeting PRD's first feature> to start on Dec 1, 2026." in the meeting chat gets one change card for that item (on the PRD's draft roadmap), dated month first, and Apply applies it
      // fails_when: the chat reads another PRD's items (no card: "I could not find …"), or the card names another item or an ISO date
      // no_claim: the card's flags; who may apply (api tests)
      const chat = await meeting(page);
      const last = await say(chat, "Move Setup checklist to start on Dec 1, 2026.");
      await expect(last).toHaveAttribute("data-kind", "cards");
      const card = last.getByTestId("chat-card");
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId("chat-card-summary")).toContainText("Move Setup checklist to Dec 1");
      await expect(card).not.toContainText(/\d{4}-\d{2}-\d{2}/);
      await tap(card.getByRole("button", { name: "Apply" }));
      await expect(card).toHaveAttribute("data-status", "applied");
    });

    test(`another PRD's item is not read in this meeting's chat (${where})`, async ({ page }) => {
      // protects: an item of another PRD of the company (Usage alerts' Delivery pipeline v2) is not on this meeting's plan: no card for it
      // fails_when: the meeting chat reads every PRD's items and offers a card for another PRD's item
      // no_claim: the refusal's exact words
      const chat = await meeting(page);
      const last = await say(chat, "Move Delivery pipeline v2 to start on Dec 1, 2026.");
      await expect(last.getByTestId("chat-card")).toHaveCount(0);
      await expect(last).toContainText("Delivery pipeline v2");
    });

    test(`an ended meeting's chat says who ended it, month first (${where})`, async ({ page }) => {
      // protects: once a person ends the meeting, its chat reads "Ended by <name>, <Mon d, yyyy, h:mm>"
      // fails_when: the chat only says "The meeting has ended", or shows an ISO date
      // no_claim: a meeting that ended by itself (api tests)
      await meeting(page);
      await page.goto("/simple/meetings");
      await tap(page.getByRole("button", { name: "Start review" }).first());
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
      await tap(sheet.getByRole("button", { name: "Start", exact: true }));
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
      const id = /\/simple\/meetings\/([^/?#]+)/.exec(page.url())![1];
      await tap(page.getByRole("button", { name: "End meeting" }));
      await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
      await expect(page.getByTestId("end-screen")).toBeVisible();
      await page.goto(`/simple/meetings/${id}/chat`);
      const ended = page.getByTestId("meeting-chat").getByTestId("chat-ended");
      await expect(ended).toContainText(/Ended by \S.*, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}/);
      await expect(ended).not.toContainText(/\d{4}-\d{2}-\d{2}/);
    });
  });
}

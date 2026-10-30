import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * dod-data (Simple Definition of Done, item 5): a chat card whose item changed after the card
 * was made is refused with a reason and offered again on the new state, so the person's next
 * Apply lands it (the API's chat.rebase; the mock mirrors it). The "simple-chat" mock scenario
 * and its invented Delivery pipeline v2, in the meeting chat. Desktop 1440x900 and phone 390x844.
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
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  return page.getByTestId("meeting-chat");
}

for (const [label, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`a stale chat card is refused with its reason, then offered again on the new state (${label})`, async ({ context, page }) => {
    // protects: Apply all stops at the card whose item the first card moved ("Changed since you saw it …", in words), leaves it open, and that card's own Apply then lands on the item as it is now ("Applied by you")
    // fails_when: the stop is silent or shows the engine's raw answer, the stopped card is lost, or its Apply keeps failing as changed since
    // no_claim: which dates the card lands (api tests: test_simple_dod_concurrency_api), a stale card in another person's thread
    await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
    await page.setViewportSize(size);
    const chat = await meeting(page);
    await chat.getByRole("textbox", { name: "Message Oracle" }).fill("push Delivery pipeline v2 out a quarter and push it to next quarter");
    await tap(chat.getByRole("button", { name: "Send" }));
    const line = chat.getByTestId("chat-message").last();
    await expect(line.getByTestId("chat-message-body")).toHaveText("I understood two changes:");
    await tap(line.getByRole("button", { name: "Apply all" }));
    const said = line.getByRole("status").filter({ hasText: "Applied 1 of 2." });
    await expect(said).toContainText("Changed since you saw it");
    await expect(said).not.toContainText("{");
    const open = line.locator('[data-testid="chat-card"][data-status="open"]');
    await expect(open).toHaveCount(1);
    await tap(open.getByRole("button", { name: "Apply", exact: true }));
    await expect(line.locator('[data-testid="chat-card"][data-status="applied"]')).toHaveCount(2);
    await expect(line.getByTestId("chat-card-outcome").last()).toContainText("Applied by you");
  });
}

for (const [label, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`a stale card that moves by a span is offered again from the item's new dates (${label})`, async ({ context, page }) => {
    // protects: "out a quarter" after the first card moved the item to next quarter (Jan 1, 2027) is offered again a quarter on from there: its words say Apr 1, and its Apply lands it
    // fails_when: the re-offered card still names the quarter from the item's old dates (the API's chat.rebase and the mock's rebaseShift)
    // no_claim: a card naming a day (it keeps that day; api test: test_stale_relative_chat_card_moves_from_the_new_dates)
    await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
    await page.setViewportSize(size);
    const chat = await meeting(page);
    await chat.getByRole("textbox", { name: "Message Oracle" }).fill("push Delivery pipeline v2 to next quarter and push it out a quarter");
    await tap(chat.getByRole("button", { name: "Send" }));
    const line = chat.getByTestId("chat-message").last();
    await expect(line.getByTestId("chat-message-body")).toHaveText("I understood two changes:");
    const second = line.getByTestId("chat-card").last();
    await expect(second.getByTestId("chat-card-summary")).not.toContainText("Apr 1 –");
    await tap(line.getByRole("button", { name: "Apply all" }));
    await expect(line.getByRole("status").filter({ hasText: "Applied 1 of 2." })).toContainText("Changed since you saw it");
    const open = line.locator('[data-testid="chat-card"][data-status="open"]');
    await expect(open).toHaveCount(1);
    await expect(open.getByTestId("chat-card-summary")).toContainText("Apr 1 –");
    await tap(open.getByRole("button", { name: "Apply", exact: true }));
    await expect(line.locator('[data-testid="chat-card"][data-status="applied"]')).toHaveCount(2);
  });
}

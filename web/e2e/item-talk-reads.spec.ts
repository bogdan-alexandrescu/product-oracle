import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * item-talk-reads: "Talk to Oracle" in a feature's panel reads the item it is about. A question
 * about what the item waits on, or what waits on it, is answered naming those items, never
 * "I couldn't read that". The "roadmap-talk-two-deps" mock scenario: the invented Alert SLA
 * report waits on Alert rules engine and on Reliability work.
 */

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function openTalk(page: Page, key: string, title: string): Promise<Locator> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/simple/roadmap");
  await tap(page.getByTestId("format-gantt"));
  const bar = page.locator(`[data-testid="bar"][data-item="${key}"]`);
  await expect(bar).toBeVisible();
  await bar.click();
  const card = page.getByTestId("floating-card");
  await expect(card.getByRole("heading", { name: title, level: 2, exact: true })).toBeVisible();
  await tap(card.getByRole("button", { name: "Talk to Oracle" }));
  return card.getByTestId("item-talk");
}

async function ask(talk: Locator, text: string): Promise<Locator> {
  const before = await talk.getByTestId("chat-message").count();
  await talk.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(talk.getByRole("button", { name: "Send" }));
  await expect(talk.getByTestId("chat-message")).toHaveCount(before + 2);
  return talk.getByTestId("chat-message").last();
}

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(([key]) => localStorage.setItem(key, "roadmap-talk-two-deps"), [MOCK_SCENARIO_KEY] as const);
  await page.setViewportSize({ width: 1366, height: 820 });
});

/**
 * Card item-talk-reads: protects = a question in an item's talk about what it depends on, and
 * what depends on it, gets Oracle's answer naming those items, with its source; fails_when = the
 * answer says only the item's dates, or "I couldn't read that"; no_claim = the real reader's words.
 */
test("Talk to Oracle in a feature's panel answers naming the items it is linked to", async ({ page }) => {
  const talk = await openTalk(page, "alert-sla", "Alert SLA report");
  const answer = await ask(talk, "What does it depend on?");
  await expect(answer).toHaveAttribute("data-kind", "answer");
  const body = answer.getByTestId("chat-message-body");
  await expect(body).toContainText("Alert SLA report depends on ");
  await expect(body).toContainText("Alert rules engine");
  await expect(body).toContainText("Reliability work");
  await expect(body).not.toContainText("couldn't read");
  await expect(answer.getByTestId("answer-source")).toHaveText("From the roadmap · Alert SLA report");
  const again = await ask(talk, "What needs it?");
  await expect(again.getByTestId("chat-message-body")).toHaveText("Nothing depends on Alert SLA report.");
});

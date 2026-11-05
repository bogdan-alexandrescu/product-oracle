import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * ask-oracle-actions (owner, Nov 4): Ask Oracle does what a person can do. The owner's own
 * sentence, "it should not depend on <item>. remove that dependency relationship", typed in a
 * feature's talk is one card naming exactly what changes ("Remove dependency: Weekly alert
 * digest no longer depends on Alert rules engine"), never "I could not tell what to change";
 * Apply removes the dependency (saying it again: it does not depend on it), Undo puts it back.
 * The same change from the Ask Oracle panel and from a meeting's chat. Mock-backed (invented
 * alert items); the mock's reader is deterministic. Desktop (1366x820).
 */

const DEP = "Alert rules engine";
const SUMMARY = new RegExp(`^Remove dependency: Weekly alert digest no longer depends on (F-\\d+ )?${DEP}$`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

const last = (box: Locator) => box.getByTestId("chat-message").last();

/** Says `line`; one card removes the dependency; Apply applies it; the same line again finds none; Undo restores it. */
async function removeAndUndo(box: Locator, line: string) {
  await say(box, line);
  const reply = last(box);
  await expect(reply).not.toContainText("could not tell what to change");
  const card = reply.getByTestId("chat-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("chat-card-summary")).toHaveText(SUMMARY);
  await tap(card.getByRole("button", { name: "Apply", exact: true }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
  await say(box, line);
  await expect(last(box).getByTestId("chat-message-body")).toContainText(`does not depend on`);
  await expect(last(box).getByTestId("chat-card")).toHaveCount(0);
  const applied = box.locator('[data-testid="chat-card"][data-status="applied"]');
  await expect(applied).toHaveCount(1);
  await tap(applied.getByRole("button", { name: "Undo" }));
  await expect(box.locator('[data-testid="chat-card"][data-status="undone"]')).toHaveCount(1);
  await say(box, line);
  await expect(last(box).getByTestId("chat-card").getByTestId("chat-card-summary")).toHaveText(SUMMARY);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
});

/**
 * Card ask-actions-talk: protects = the owner's sentence in a feature's talk removes the
 * dependency as a card, Apply removes it and Undo restores it; fails_when = the talk answers
 * "I could not tell what to change", the card names another change, or Apply/Undo leave the
 * dependency as it was; no_claim = the Gantt's arrows.
 */
test("the feature talk removes a dependency from the owner's sentence, with Undo", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("format-gantt"));
  const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
  await expect(bar).toBeVisible();
  await bar.click();
  const panel = page.getByTestId("floating-card");
  await expect(panel).toBeVisible();
  await tap(panel.getByRole("button", { name: "Talk to Oracle" }));
  const talk = panel.getByTestId("item-talk");
  await removeAndUndo(talk, `it should not depend on the ${DEP.toLowerCase()}. remove that dependency relationship`);
});

/**
 * Card ask-actions-panel: protects = the Ask Oracle panel takes the same change by name;
 * fails_when = no card, or Apply/Undo do nothing; no_claim = the General tab.
 */
test("the Ask Oracle panel removes a dependency, with Undo", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  await removeAndUndo(ask, `Weekly alert digest should not depend on ${DEP}`);
});

/**
 * Card ask-actions-meeting: protects = a meeting's chat takes the same change; fails_when =
 * the meeting chat answers "I could not tell what to change"; no_claim = the minutes.
 */
test("a meeting's chat removes a dependency, with Undo", async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await signIn(page, `/simple/meetings/${CHAT_MEETING_ID}/chat`);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  const box = page.getByTestId("meeting-chat");
  await removeAndUndo(box, `Weekly alert digest should not depend on ${DEP}. Remove that dependency relationship`);
});

/**
 * An action of the API as a card, from `box`: "add the assumption …" is a card naming what it
 * adds; Apply adds it, Undo takes it back. "add the gap …" has no way back: its card says so
 * before Apply, and once applied it offers no Undo.
 */
async function apiActions(box: Locator) {
  await say(box, "add the assumption Night shift nurse");
  const made = last(box).getByTestId("chat-card");
  await expect(made).toHaveCount(1);
  await expect(made.getByTestId("chat-card-summary")).toHaveText(
    "Add a product record: type “assumption”, key “night-shift-nurse”, title “Night shift nurse”.",
  );
  await tap(made.getByRole("button", { name: "Apply", exact: true }));
  await expect(made).toHaveAttribute("data-status", "applied");
  await expect(made.getByTestId("chat-card-outcome")).toContainText("Applied by you");
  await tap(made.getByRole("button", { name: "Undo" }));
  await expect(made).toHaveAttribute("data-status", "undone");

  await say(box, "add the gap Who reads the export");
  const kept = last(box).getByTestId("chat-card");
  await expect(kept).toHaveCount(1);
  await expect(kept.getByTestId("chat-card-summary")).toHaveText("Add a gap: title “Who reads the export”. This cannot be undone.");
  await tap(kept.getByRole("button", { name: "Apply", exact: true }));
  await expect(kept).toHaveAttribute("data-status", "applied");
  await expect(kept.getByRole("button", { name: "Undo" })).toHaveCount(0);
}

/**
 * Card ask-actions-api-talk: protects = a feature's talk offers the API's actions as cards, with
 * Undo only where it is sure; fails_when = no card, a card with Undo for an add that has no way
 * back, or Apply/Undo leave the card as it was; no_claim = the record pages.
 */
test("the feature talk applies an action of the API, with Undo, and one that cannot be undone", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("format-gantt"));
  const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
  await expect(bar).toBeVisible();
  await bar.click();
  const panel = page.getByTestId("floating-card");
  await tap(panel.getByRole("button", { name: "Talk to Oracle" }));
  await apiActions(panel.getByTestId("item-talk"));
});

/** Card ask-actions-api-panel: the same from the Ask Oracle panel. */
test("the Ask Oracle panel applies an action of the API, with Undo, and one that cannot be undone", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  await apiActions(ask);
});

/** Card ask-actions-api-meeting: the same from a meeting's chat. */
test("a meeting's chat applies an action of the API, with Undo, and one that cannot be undone", async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await signIn(page, `/simple/meetings/${CHAT_MEETING_ID}/chat`);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  await apiActions(page.getByTestId("meeting-chat"));
});

/**
 * Card ask-actions-secret-value: protects = a token pasted into what a card would add gets a
 * plain refusal and no card, in a feature's talk, the Ask Oracle panel and a meeting's chat;
 * fails_when = a card (or its summary) carries the token; no_claim = the API's own check
 * (tests/test_ask_oracle_actions.py).
 */
test("a pasted token never lands in a card, in the three chats", async ({ context, page }) => {
  const token = "ghp_" + "Example0Token1Not2Real3Value4Abc5";
  async function refused(box: Locator) {
    await say(box, `add the assumption Use ${token}`);
    const reply = last(box);
    await expect(reply).toContainText("looks like a secret");
    await expect(reply.getByTestId("chat-card")).toHaveCount(0);
    await expect(box.getByTestId("chat-card-summary").filter({ hasText: token })).toHaveCount(0);
  }
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("format-gantt"));
  const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
  await expect(bar).toBeVisible();
  await bar.click();
  const panel = page.getByTestId("floating-card");
  await tap(panel.getByRole("button", { name: "Talk to Oracle" }));
  await refused(panel.getByTestId("item-talk"));

  await page.goto("/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  await refused(ask);

  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await page.goto(`/simple/meetings/${CHAT_MEETING_ID}/chat`);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  await refused(page.getByTestId("meeting-chat"));
});

import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * chat-latest-card (owner, Nov 4): in a chat only the latest card acts. Two cards on one item:
 * only the newest offers Apply; the older reads "Replaced by a newer card" with a link to it.
 * Cards on two items: one active card per item. Once a card is applied, every earlier card in
 * the chat is replaced too (an applied card keeps its Undo), and a reload reads the same.
 * In the feature talk, the Ask Oracle panel and a meeting's chat. A card that makes a new
 * record (a note, a decision, a suggestion) is its own topic: two different notes both stay
 * active, and so do two drafts sharing most words ("we launch billing in March" / "... in April");
 * only a line asking to change the earlier draft ("make it April instead", "no, note: ...")
 * replaces it. Discard and Propose replace earlier cards as Apply does. Apply in the Ask panel
 * shows the change on the page under it at once. Mock-backed (invented items); desktop (1366x820).
 */

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
  const n = await box.getByTestId("chat-message").count();
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
  await expect(box.getByTestId("chat-message")).toHaveCount(n + 2);
}

/** The card of the chat's latest reply. */
async function newest(box: Locator): Promise<Locator> {
  const card = box.getByTestId("chat-message").last().getByTestId("chat-card");
  await expect(card).toHaveCount(1);
  const id = await card.getAttribute("data-card-id");
  return box.locator(`[data-testid="chat-card"][data-card-id="${id}"]`);
}

const applyOf = (card: Locator) => card.getByRole("button", { name: "Apply", exact: true });

async function active(card: Locator) {
  await expect(applyOf(card)).toBeVisible();
  await expect(card.getByTestId("chat-card-replaced")).toHaveCount(0);
}

async function replaced(card: Locator) {
  await expect(card.getByTestId("chat-card-replaced")).toContainText("Replaced by a newer card");
  await expect(applyOf(card)).toHaveCount(0);
  await expect(card.getByRole("button", { name: /^(Discard|Reject)$/ })).toHaveCount(0);
}

type Lines = { first: string; again: string; other: string };

/**
 * Two cards on one item, then one on another; the older on the first item is replaced and its
 * link goes to the newer; Apply on the newest replaces every earlier card; `reopen` reloads.
 */
async function latestCard(page: Page, box: () => Locator, lines: Lines, reopen: () => Promise<void>) {
  await say(box(), lines.first);
  const a1 = await newest(box());
  await active(a1);
  await say(box(), lines.again);
  const a2 = await newest(box());
  await active(a2);
  await replaced(a1);
  const a1Id = await a1.getAttribute("data-card-id");
  const a2Id = await a2.getAttribute("data-card-id");
  // The link goes to the card that replaced it.
  await tap(a1.getByRole("link", { name: "Go to the newer card" }));
  await expect(page.locator(`[data-card-id="${a2Id}"]`)).toBeFocused();
  await expect(page.locator(`[data-card-id="${a2Id}"]`)).toBeInViewport();
  // A card on another target: one active card per target.
  await say(box(), lines.other);
  const b = await newest(box());
  await active(b);
  await active(a2);
  await replaced(a1);
  // Apply the newest: every earlier card is replaced.
  await tap(applyOf(b));
  await expect(b).toHaveAttribute("data-status", "applied");
  await replaced(a2);
  await replaced(a1);
  const bId = await b.getAttribute("data-card-id");
  // A reload reads the same.
  await reopen();
  const card = (id: string | null) => box().locator(`[data-testid="chat-card"][data-card-id="${id}"]`);
  await replaced(card(a1Id));
  await replaced(card(a2Id));
  await expect(card(bId)).toHaveAttribute("data-status", "applied");
  await expect(card(bId).getByTestId("chat-card-replaced")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
});

/**
 * Card latest-card-talk: protects = in a feature's talk only the newest card on the item acts
 * and Apply replaces the earlier ones, after a reload too; fails_when = an older card still
 * offers Apply or Discard; no_claim = the Gantt's bars.
 */
test("the feature talk keeps only the newest card per target active", async ({ page }) => {
  const open = async () => {
    await tap(page.getByTestId("format-gantt"));
    const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
    await expect(bar).toBeVisible();
    await bar.click();
    // This line's feature panel opens its talk from "Talk to Oracle".
    await tap(page.getByTestId("floating-card").getByRole("button", { name: "Talk to Oracle" }));
    await expect(page.getByTestId("item-talk")).toBeVisible();
  };
  await signIn(page, "/simple/roadmap");
  await open();
  const box = () => page.getByTestId("floating-card").getByTestId("item-talk");
  await latestCard(page, box, { first: "rename it to Alert digest one", again: "rename it to Alert digest two", other: "add the assumption Night shift nurse" }, async () => {
    await page.reload();
    await open();
  });
});

/**
 * Card latest-card-panel: protects = the Ask Oracle panel keeps one active card per item and
 * Apply replaces every earlier card, after a reload too; fails_when = an older card applies.
 */
test("the Ask Oracle panel keeps only the newest card per item active", async ({ page }) => {
  const open = async () => {
    await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
    await expect(page.getByTestId("ask-chat").filter({ visible: true })).toBeVisible();
  };
  await signIn(page, "/simple/roadmap");
  await open();
  const box = () => page.getByTestId("ask-chat").filter({ visible: true });
  await latestCard(page, box, { first: "rename Setup checklist to First-run checklist", again: "rename Setup checklist to Setup guide", other: "rename In-app tour to Product tour" }, async () => {
    await page.reload();
    await open();
    // Ask opens a clean chat: Recent chats reopens this one.
    const panel = page.getByTestId("hop-panel").filter({ visible: true });
    await tap(panel.getByRole("button", { name: "Recent chats" }));
    await tap(panel.getByTestId("ask-recent-row").first());
    await expect(box().getByTestId("chat-card")).toHaveCount(3);
  });
});

/**
 * Card latest-card-meeting: protects = a meeting's chat follows the same rule; fails_when = an
 * older card in the meeting still applies; no_claim = the minutes.
 */
test("a meeting's chat keeps only the newest card per item active", async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await signIn(page, `/simple/meetings/${CHAT_MEETING_ID}/chat`);
  const ready = () => expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  await ready();
  const box = () => page.getByTestId("meeting-chat");
  await latestCard(page, box, { first: "rename Setup checklist to First-run checklist", again: "rename Setup checklist to Setup guide", other: "rename In-app tour to Product tour" }, async () => {
    await page.reload();
    await ready();
  });
});

async function openMeeting(page: Page, context: import("@playwright/test").BrowserContext) {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await signIn(page, `/simple/meetings/${CHAT_MEETING_ID}/chat`);
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
}

async function openAsk(page: Page) {
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  await expect(page.getByTestId("ask-chat").filter({ visible: true })).toBeVisible();
}

/**
 * Card latest-card-new-records: protects = in a meeting's chat two different notes and two
 * different decisions all stay active and both notes apply; a note said again with "no, ..."
 * (asking to change it) replaces the earlier draft, after a reload too; a note sharing most of
 * its words without that stays active; fails_when = the meeting makes every note (or every
 * decision) one topic, or word overlap replaces a different note.
 */
test("a meeting's chat keeps different notes and decisions active", async ({ context, page }) => {
  await openMeeting(page, context);
  const box = () => page.getByTestId("meeting-chat");
  await say(box(), "note: the budget is approved");
  const n1 = await newest(box());
  await say(box(), "note: we hire a designer next month");
  const n2 = await newest(box());
  await say(box(), "decision: the pilot starts in spring");
  const d1 = await newest(box());
  await say(box(), "decision: the tour stays optional");
  const d2 = await newest(box());
  for (const c of [n1, n2, d1, d2]) await active(c);
  // Most of the same words, not asked as a change: another note, both active.
  await say(box(), "note: the budget is approved for the summer");
  const n0 = await newest(box());
  await active(n0);
  await active(n1);
  // Asked as a change of the note ("no, ..."): it replaces the earlier draft; the others stay active.
  await say(box(), "no, note: the budget is approved for the spring");
  const n3 = await newest(box());
  await active(n3);
  await replaced(n0);
  for (const c of [n1, n2, d1, d2]) await active(c);
  const n3Id = await n3.getAttribute("data-card-id");
  await page.reload();
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  await replaced(n0);
  for (const c of [n1, n2, d1, d2]) await active(c);
  const again = box().locator(`[data-testid="chat-card"][data-card-id="${n3Id}"]`);
  await active(again);
  // Both different notes apply.
  await tap(applyOf(again));
  await expect(again).toHaveAttribute("data-status", "applied");
  await replaced(n2);
});

/**
 * Card latest-card-discard: protects = two features suggested for one goal both stay active, and
 * Discard on the newest replaces every earlier card; fails_when = the goal makes them one topic,
 * or an earlier card still applies after a Discard.
 */
test("Discard on the newest card replaces the earlier ones", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await openAsk(page);
  const box = () => page.getByTestId("ask-chat").filter({ visible: true });
  await say(box(), "suggest a feature for Grow retention: Search across saved notes");
  const a = await newest(box());
  await say(box(), "suggest a feature for Grow retention: Export reports to a sheet");
  const b = await newest(box());
  await active(a);
  await active(b);
  await tap(b.getByRole("button", { name: "Discard", exact: true }));
  await expect(b).toHaveAttribute("data-status", "discarded");
  await replaced(a);
});

/**
 * Card latest-card-propose: protects = a commenter's two decisions on the Ask panel both offer
 * Propose, and Propose on the newest replaces the earlier one; fails_when = the page makes them
 * one topic, or the earlier one still offers Propose after it.
 */
test("Propose on the newest card replaces the earlier ones", async ({ page }) => {
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "commenter"] as const);
  await signIn(page, "/simple/roadmap");
  await openAsk(page);
  const box = () => page.getByTestId("ask-chat").filter({ visible: true });
  const propose = (c: Locator) => c.getByRole("button", { name: "Propose", exact: true });
  await say(box(), "decision: the pilot starts in spring");
  const a = await newest(box());
  await say(box(), "decision: the tour stays optional");
  const b = await newest(box());
  await expect(propose(a)).toBeVisible();
  await expect(propose(b)).toBeVisible();
  await tap(propose(b));
  await expect(b).toHaveAttribute("data-status", "proposed");
  await expect(a.getByTestId("chat-card-replaced")).toContainText("Replaced by a newer card");
  await expect(propose(a)).toHaveCount(0);
});

/**
 * Card latest-card-not-words (fix round 2): protects = drafts sharing most words are different
 * records: March vs April, Postgres vs Redis, Dana vs Lee all stay active in a meeting's chat;
 * "make it April instead" (the reader's redo of the March draft) replaces the March card, after
 * a reload too; fails_when = word overlap replaces a different decision or note, or the asked
 * change leaves the March card active.
 */
test("drafts sharing most words stay active; only an asked change replaces one", async ({ context, page }) => {
  await openMeeting(page, context);
  const box = () => page.getByTestId("meeting-chat");
  const pairs = [
    ["decision: we launch billing in March", "decision: we launch billing in April"],
    ["note: Use Postgres for the events store", "note: Use Redis for the events store"],
    ["note: Ask Dana about the pricing page", "note: Ask Lee about the pricing page"],
  ];
  const cards: Locator[] = [];
  for (const [one, two] of pairs) {
    await say(box(), one);
    cards.push(await newest(box()));
    await say(box(), two);
    cards.push(await newest(box()));
  }
  for (const c of cards) await active(c);
  // The person asks to change the newest decision draft: the reader makes it a redo of that card.
  await say(box(), "decision: we launch payroll in March");
  const march = await newest(box());
  await say(box(), "make it April instead");
  const april = await newest(box());
  await expect(april.getByTestId("chat-card-summary")).toContainText("April");
  await active(april);
  await replaced(march);
  for (const c of cards) await active(c);
  await page.reload();
  await expect(page.locator('[data-testid="chat-rules"], [data-testid="chat-mode"]').first()).toBeVisible();
  await replaced(march);
  await active(april);
  for (const c of cards) await active(c);
});

/**
 * Card latest-card-redo-rules (fix round 3): protects = a note ending "instead" is a note of its
 * own, in the person's words ("we use Redis instead"), and leaves the earlier note active; "no,
 * ..." after a plain answer in between is a new card, not a change of the older draft;
 * fails_when = "instead" replaces the earlier note or drops the word, or "no, ..." replaces a
 * draft from before the plain answer.
 */
test("only a short change request or a 'no' right after a card replaces a draft", async ({ context, page }) => {
  await openMeeting(page, context);
  const box = () => page.getByTestId("meeting-chat");
  await say(box(), "note: the export runs nightly");
  const a = await newest(box());
  await say(box(), "note: we use Redis instead");
  const b = await newest(box());
  await expect(b.getByTestId("chat-card-summary")).toContainText("we use Redis instead");
  await active(a);
  await active(b);
  await say(box(), "who owns Setup checklist?");
  await expect(box().getByTestId("chat-message").last().getByTestId("chat-card")).toHaveCount(0);
  await say(box(), "no, note: we use Redis for the export");
  const c = await newest(box());
  for (const x of [a, b, c]) await active(x);
});

/**
 * Card latest-card-page-updates (from PR 1229's review): protects = Apply in the Ask Oracle
 * panel shows the change on the page under it at once (the roadmap reads the renamed feature),
 * with no reload; fails_when = the page keeps the old name until a reload.
 */
test("Apply in the Ask panel updates the page under it at once", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  // The roadmap's own feature buttons (the Ask panel's card text is not a button).
  const feature = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(feature("Setup checklist").first()).toBeVisible();
  await openAsk(page);
  const box = () => page.getByTestId("ask-chat").filter({ visible: true });
  await say(box(), "rename Setup checklist to First-run checklist");
  const card = await newest(box());
  await tap(applyOf(card));
  await expect(card).toHaveAttribute("data-status", "applied");
  await expect(feature("First-run checklist").first()).toBeVisible();
  await expect(feature("Setup checklist")).toHaveCount(0);
});

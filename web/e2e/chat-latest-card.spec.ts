import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * chat-latest-card (owner, Nov 4): in a chat only the latest card acts. Two cards on one item:
 * only the newest offers Apply; the older reads "Replaced by a newer card" with a link to it.
 * Cards on two items: one active card per item. Once a card is applied, every earlier card in
 * the chat is replaced too (an applied card keeps its Undo), and a reload reads the same.
 * In the feature talk, the Ask Oracle panel and a meeting's chat. Mock-backed (invented
 * items); desktop (1366x820).
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

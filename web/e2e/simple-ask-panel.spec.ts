import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * The Ask panel as the owner's pick C "Always a clean slate" draws it (ask-panel fidelity,
 * 2026-10-28: "keep the mockup design very strictly"): the header row is Ask Oracle, a small
 * New chat button and the close button; one row under it holds the This page | General
 * switch (sized to its two labels) and "Just you and Oracle"; then "New chat about Home"
 * with "Recent chats ▾" on its right; the conversation (author · time over each line,
 * Oracle's answer with its title, labelled lists and its sources as links); and the message
 * box with Send on one row pinned to the bottom. Recent chats opens as a small menu OVER the
 * chat (YOUR RECENT CHATS, each chat's question with its page · time, "Meeting chats stay in
 * their meeting."), and choosing one reopens it. On a phone the Ask sheet is the whole
 * screen, over the tab bar, with the same head. The "simple-chat" mock scenario, the owner;
 * desktop (1366x820) and phone (390x844), light and dark.
 *
 * Card: protects=the pick's rows and their order, the box pinned at the bottom, the answer's
 * sections and sources, Recent as a menu over the chat that Escape closes alone, the phone
 * sheet over the tab bar; fails_when=New chat or Recent chats are big buttons under the
 * header, the switch spans the panel, the box sits under the header, Recent replaces the
 * chat, an answer is one plain paragraph, or the phone's tab bar shows over the sheet;
 * no_claim=which chats Recent lists (simple-ask-fresh.spec.ts), Oracle's Ask's own words
 * (simple-ask-plan-first.spec.ts).
 */

const Q = "What is Weekly alert digest about and when does it run?";
const TIME = String.raw`\d{1,2}:\d{2}\s?[AP]M`;

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function openAsk(page: Page, phone: boolean): Promise<Locator> {
  await page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Same row: the two boxes' vertical middles within 2 px. */
async function sameRow(a: Locator, b: Locator) {
  const [x, y] = [await box(a), await box(b)];
  expect(Math.abs(x.y + x.height / 2 - (y.y + y.height / 2))).toBeLessThanOrEqual(2);
}

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

    test(`The pick's rows, an answer with its sections and sources, the box at the bottom (${where})`, async ({ page }) => {
      await signIn(page, "/simple");
      const panel = await openAsk(page, phone);
      const p = await box(panel);
      const head = panel.getByRole("heading", { name: "Ask Oracle" });
      const newChat = panel.getByRole("button", { name: "New chat" });
      const close = panel.getByRole("button", { name: "Close Ask Oracle" });
      // Row 1: Ask Oracle, New chat (32 px, outlined) and the close button.
      await sameRow(head, newChat);
      await sameRow(newChat, close);
      expect((await box(newChat)).height).toBe(32);
      expect((await box(close)).x).toBeGreaterThan((await box(newChat)).x);
      // Row 2: the switch, sized to its two labels, and "Just you and Oracle" on the right.
      const about = panel.getByRole("group", { name: "About" });
      const lock = panel.getByTestId("hop-visibility");
      await sameRow(about, lock);
      expect((await box(about)).width).toBeLessThan(p.width / 2);
      await expect(about.getByRole("button", { name: "This page" })).toHaveAttribute("aria-pressed", "true");
      expect((await box(lock)).x).toBeGreaterThan((await box(about)).x + (await box(about)).width);
      // Row 3: "New chat about Home" and Recent chats on its right, under row 2.
      const recent = panel.getByRole("button", { name: "Recent chats" });
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Home");
      await sameRow(panel.getByTestId("ask-about"), recent);
      expect((await box(recent)).y).toBeGreaterThan((await box(about)).y + (await box(about)).height);
      // The empty chat invites a question.
      await expect(panel.getByTestId("hop-empty")).toHaveText("Nothing yetAsk about Home, or ask for a change.");
      // The box and Send: one row, pinned to the panel's bottom.
      const input = panel.getByRole("textbox", { name: "Message Oracle" });
      const send = panel.getByRole("button", { name: "Send" });
      expect((await box(send)).x).toBeGreaterThan((await box(input)).x + (await box(input)).width - 1);
      const inBox = await box(input);
      expect(p.y + p.height - (inBox.y + inBox.height)).toBeLessThanOrEqual(16);
      expect((await box(input)).height).toBeGreaterThanOrEqual(44);

      // A question: author · time over it, Oracle's answer with its title, labels and sources.
      await input.fill(Q);
      await send.click();
      const asked = panel.locator('[data-testid="chat-message"][data-author="person"]').last();
      await expect(asked.getByTestId("chat-message-body")).toHaveText(Q);
      await expect(asked.getByTestId("chat-who")).toHaveText(new RegExp(`^You · ${TIME}$`));
      const answer = panel.getByTestId("ask-answer").last();
      await expect(answer.getByTestId("answer-title")).toHaveText("Weekly alert digest");
      await expect(answer.getByTestId("chat-who")).toHaveText(new RegExp(`^Oracle · ${TIME}$`));
      await expect(answer).toContainText(/Runs .+ – .+ · /);
      await expect(answer.getByTestId("answer-label")).not.toHaveCount(0);
      await expect(answer.getByTestId("answer-label").first()).toHaveCSS("text-transform", "uppercase");
      await expect(answer.getByTestId("answer-source").filter({ hasText: "Open Weekly alert digest on the roadmap" })).toBeVisible();
      // Still the same rows: the answered chat is titled by its question; the box stays at the bottom.
      await expect(panel.getByTestId("ask-about")).toHaveText(Q);
      expect((await box(input)).y).toBeGreaterThan((await box(answer)).y);
      // The page itself never scrolled with the chat.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);

      // Recent chats: a small menu over the chat, the chat still there under it.
      await recent.click();
      const menu = panel.getByTestId("ask-recent-list");
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("heading", { name: "Your recent chats" })).toHaveCSS("text-transform", "uppercase");
      await expect(answer).toBeVisible();
      const m = await box(menu);
      expect(m.width).toBeLessThanOrEqual(340);
      expect(m.y).toBeGreaterThan((await box(recent)).y);
      const row = menu.getByTestId("ask-recent-row").first();
      await expect(row.getByTestId("ask-recent-question")).toHaveText(Q);
      await expect(row.getByTestId("ask-recent-when")).toHaveText(new RegExp(`^Home · Today, ${TIME}$`));
      await expect(menu.getByTestId("ask-recent-meetings")).toHaveText("Meeting chats stay in their meeting.");
      // Escape closes the menu, not the panel.
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(panel.getByTestId("ask-chat")).toBeVisible();

      // New chat clears it; Recent reopens the chat from the menu.
      await newChat.click();
      await expect(panel.getByTestId("chat-message")).toHaveCount(0);
      await recent.click();
      await menu.getByTestId("ask-recent-row").first().click();
      await expect(menu).toHaveCount(0);
      await expect(panel.getByTestId("ask-about")).toHaveText(Q);
      await expect(panel.getByTestId("answer-title")).toHaveText("Weekly alert digest");

      if (phone) {
        // The phone's Ask sheet is the whole screen, over the tab bar; no handle.
        const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
        const s = await box(sheet);
        expect(s.y).toBe(0);
        expect(s.height).toBe(844);
        await expect(page.getByTestId("sheet-handle")).toHaveCount(0);
        const top = await page.evaluate(() => document.elementFromPoint(195, 830)?.closest("[role=dialog]") !== null);
        expect(top).toBe(true);
        await close.click();
        await expect(sheet).toHaveCount(0);
        await expect(page.getByTestId("simple-tab-bar")).toBeVisible();
      }
    });
  });
}

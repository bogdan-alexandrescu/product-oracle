import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * ask-fresh (the owner's pick C "Always a clean slate" and pick B "Accent-ink mark",
 * 2026-10-28): every time Ask opens in Simple it is a new, empty chat about the page it was
 * opened on; New chat clears it; Recent chats lists the person's last chats from any page,
 * named by page and time, and reopens one to continue it; a meeting's chat never shows
 * there. None of Detailed's discussion screen shows in Simple's panel. Simple's rail (and
 * the phone header) draw Oracle's mark in the accent ink: #075985 light, #b9e3fc dark. The
 * "simple-chat" mock scenario, the owner; desktop (1366x820) and phone (390x844), light and dark.
 *
 * Card: protects=Ask opened twice starts clean; New chat clears the chat; Recent reopens a
 * chat from another page and continues it; a meeting chat is not in Recent; the panel has
 * none of Detailed's discussion UI; the mark's colour is the accent ink in both themes;
 * fails_when=a reopened panel shows the last chat's lines, Recent lists a meeting chat or
 * names a chat by its route, a reopened chat loses its lines, or the mark is the sky
 * gradient on Simple's light rail; a General chat is listed by its page, or a Recent row's
 * time carries a zone after it; no_claim=Oracle's Ask answers themselves (the mock's
 * canned reply; simple-ask-plan-first.spec.ts), Detailed's panel (hop-panel.spec.ts).
 */

const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;
const INK = { light: "rgb(7, 89, 133)", dark: "rgb(185, 227, 252)" } as const;
// "Today, 7:42 PM", as the owner's example reads: the company's time, no zone after it.
const WHEN = String.raw`Today, \d{1,2}:\d{2}\s?[AP]M`;

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom). */
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

/** Opens Ask the way a person does: the rail's Ask Oracle, or the phone header's Ask. */
async function openAsk(page: Page, phone: boolean): Promise<Locator> {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function closeAsk(page: Page, phone: boolean) {
  await tap(page.getByRole("button", { name: "Close Ask Oracle" }).filter({ visible: true }).first());
  await expect(page.getByTestId("hop-panel").filter({ visible: true })).toHaveCount(0);
  void phone;
}

async function say(panel: Locator, text: string) {
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(panel.getByRole("button", { name: "Send" }));
  await expect(panel.getByTestId("chat-message-body").filter({ hasText: text })).toBeVisible();
  await expect(panel.locator('[data-testid="chat-message"][data-author="oracle"]').last()).toBeVisible();
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

    test(`Ask starts clean each time; New chat; Recent reopens another page's chat, never a meeting's (${where})`, async ({ page }) => {
      // A line in the meeting's chat first: it stays in its meeting.
      await signIn(page, MEETING);
      const meeting = page.getByTestId("meeting-chat");
      await meeting.getByRole("textbox", { name: "Message Oracle" }).fill("who owns Weekly alert digest?");
      await tap(meeting.getByRole("button", { name: "Send" }));
      await expect(meeting.getByTestId("chat-message")).not.toHaveCount(0);

      await page.goto("/simple");
      let panel = await openAsk(page, phone);
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Home");
      await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask about Home, or ask for a change…");
      await expect(panel.getByText("This page", { exact: true })).toBeVisible();
      await expect(panel.getByText("General", { exact: true })).toBeVisible();
      await expect(panel.getByTestId("hop-visibility")).toContainText("Just you and Oracle");
      // None of Detailed's discussion screen in Simple's panel.
      for (const gone of ["Private · 1 person", "Research this", "Reply to Oracle and the team", "Propose a change", "Summary", "/simple"])
        await expect(panel.getByText(gone, { exact: false })).toHaveCount(0);
      await expect(panel.getByRole("checkbox")).toHaveCount(0);
      await say(panel, "who owns Weekly alert digest?");
      // qa-simple-home-16: once asked, the chat is titled by its question.
      await expect(panel.getByTestId("ask-about")).toHaveText("who owns Weekly alert digest?");

      // Opened again: a new, empty chat.
      await closeAsk(page, phone);
      panel = await openAsk(page, phone);
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Home");
      await expect(panel.getByTestId("chat-message")).toHaveCount(0);

      // Another page: a chat about it; New chat clears it.
      await closeAsk(page, phone);
      await page.goto("/simple/roadmap");
      panel = await openAsk(page, phone);
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Roadmap");
      await say(panel, "when is Alert rules engine?");
      await tap(panel.getByRole("button", { name: "New chat" }));
      await expect(panel.getByTestId("chat-message")).toHaveCount(0);
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about Roadmap");

      // Recent chats: both, newest first, each by its question, page and time; never the meeting's.
      await tap(panel.getByRole("button", { name: "Recent chats" }));
      const rows = panel.getByTestId("ask-recent-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).getByTestId("ask-recent-question")).toHaveText("when is Alert rules engine?");
      await expect(rows.nth(0).getByTestId("ask-recent-when")).toHaveText(new RegExp(`^Roadmap · ${WHEN}$`));
      await expect(rows.nth(1).getByTestId("ask-recent-question")).toHaveText("who owns Weekly alert digest?");
      await expect(rows.nth(1).getByTestId("ask-recent-when")).toHaveText(new RegExp(`^Home · ${WHEN}$`));
      await expect(panel.getByTestId("ask-recent-meetings")).toHaveText("Meeting chats stay in their meeting.");
      await expect(rows.filter({ hasText: /Meeting/ })).toHaveCount(0);

      // Choosing Home's chat (from the Roadmap page) reopens it and continues it.
      await tap(rows.nth(1));
      await expect(panel.getByTestId("ask-about")).toHaveText("who owns Weekly alert digest?");
      await expect(panel.getByTestId("chat-message-body").filter({ hasText: "who owns Weekly alert digest?" })).toBeVisible();
      await say(panel, "when is Weekly alert digest?");
      await expect(panel.locator('[data-testid="chat-message"][data-author="person"]')).toHaveCount(2);
    });

    test(`A chat about General is listed in Recent as General and reopens as one (${where})`, async ({ page }) => {
      await signIn(page, "/simple/roadmap");
      const panel = await openAsk(page, phone);
      await tap(panel.getByRole("button", { name: "General", exact: true }));
      await expect(panel.getByTestId("ask-about")).toHaveText("New chat about General");
      await say(panel, "who owns Weekly alert digest?");
      await tap(panel.getByRole("button", { name: "New chat" }));
      // New chat keeps the scope the reader chose (qa-simple-home-18): back to the page by hand.
      await expect(panel.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-pressed", "true");
      await tap(panel.getByRole("button", { name: "This page", exact: true }));
      await say(panel, "when is Alert rules engine?");
      await tap(panel.getByRole("button", { name: "Recent chats" }));
      const rows = panel.getByTestId("ask-recent-row");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).getByTestId("ask-recent-when")).toHaveText(new RegExp(`^Roadmap · ${WHEN}$`));
      await expect(rows.nth(1).getByTestId("ask-recent-when")).toHaveText(new RegExp(`^General · ${WHEN}$`));
      await expect(rows.nth(1).getByTestId("ask-recent-question")).toHaveText("who owns Weekly alert digest?");
      await tap(rows.nth(1));
      await expect(panel.getByTestId("ask-about")).toHaveText("who owns Weekly alert digest?");
      await expect(panel.getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(panel.getByTestId("chat-message-body").filter({ hasText: "who owns Weekly alert digest?" })).toBeVisible();
    });

    test(`Simple's mark is drawn in the accent ink (${where})`, async ({ page }) => {
      await signIn(page, "/simple");
      const mark = page.getByTestId(phone ? "phone-brand" : "simple-nav-brand").locator("svg");
      await expect(mark).toBeVisible();
      await expect(mark).toHaveCSS("color", INK[dark ? "dark" : "light"]);
      await expect(mark.locator("linearGradient")).toHaveCount(0);
      // The "Oracle" word beside it on the rail is the same ink.
      if (!phone) await expect(page.getByTestId("simple-nav-brand").getByText("Oracle")).toHaveCSS("color", INK[dark ? "dark" : "light"]);
    });
  });
}

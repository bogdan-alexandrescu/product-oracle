import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * Simple S9 production walk: the Ask panel on Simple's pages has ONE question box. A line
 * Oracle's plan reader understands (a change request, who owns / who decides / when is) gets
 * its cards or answer; any other line goes to Oracle's Ask about the page, as the old box did.
 * Chat moves take relative times ("next quarter"), and a change card's fixes wrap inside the
 * panel with constraint lines that name the dependent and the dependency. The "simple-chat"
 * mock scenario (the mock's today: Oct 22 2026); desktop (1366x820) and phone (390x844, the
 * panel is a full-height sheet), light and dark.
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone): the visible panel. */
async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

async function say(panel: Locator, text: string) {
  await panel.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(panel.getByRole("button", { name: "Send" }));
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

    test(`one box: plan lines get S9's answer, any other line goes to Oracle's Ask (${where})`, async ({ page }) => {
      // protects: the Simple Ask panel shows exactly one question box and one Send, with the This page / General switch; "who owns <item>" is answered in the panel's chat; "What should we cut first?" goes to Oracle's Ask and its answer shows in the same chat (ask-fresh: Simple's own panel, none of Detailed's discussion screen); in that chat's one box a change line gets S9's move card and the next other line goes on to Ask in the same chat; New chat clears it
      // fails_when: two boxes show, a plan question goes to the model's Ask, an other line gets "I did not understand", or Detailed's discussion screen opens
      // no_claim: the model's answer itself (the mock streams a canned reply); Detailed's panel (hop-panel.spec.ts)
      await signIn(page, EMAILS.commenter, "/simple/roadmap");
      if (dark) await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      const panel = await openAsk(page, phone);
      await expect(panel.getByRole("textbox")).toHaveCount(1);
      await expect(panel.getByRole("button", { name: "Send" })).toHaveCount(1);
      await expect(panel.getByRole("button", { name: "This page" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "General" })).toBeVisible();

      await say(panel, "who owns Weekly alert digest?");
      const thread = panel.getByTestId("ask-chat-thread");
      await expect(thread.getByTestId("chat-message").last()).toHaveAttribute("data-kind", "answer");
      await expect(thread.getByTestId("chat-message").last()).toContainText(/Weekly alert digest (has no owner yet|\(its track's owner\))|owns Weekly alert digest/);
      await expect(thread.getByTestId("ask-answer")).toHaveCount(0);

      await say(panel, "What should we cut first?");
      await expect(thread.getByTestId("chat-message-body").filter({ hasText: "What should we cut first?" })).toHaveCount(1);
      await expect(thread.getByTestId("ask-answer").last()).toHaveAttribute("data-status", "complete");
      await expect(panel.getByTestId("discussion-thread")).toHaveCount(0);
      await expect(page.getByText("I did not understand that.")).toHaveCount(0);
      // The same chat's one box: a change line gets S9's card there, any other line stays Ask's.
      await expect(panel.getByRole("textbox")).toHaveCount(1);
      await say(panel, "move Alert rules engine to next quarter");
      await expect(thread.getByTestId("chat-card").filter({ hasText: "Move Alert rules engine to 1 Jan" })).toBeVisible();
      await say(panel, "And what is missing?");
      await expect(thread.getByTestId("chat-message-body").filter({ hasText: "And what is missing?" })).toHaveCount(1);
      await expect(thread.getByTestId("ask-answer")).toHaveCount(2);
      await expect(page.getByText("I did not understand that.")).toHaveCount(0);
      await tap(panel.getByRole("button", { name: "New chat" }));
      await expect(panel.getByTestId("chat-message")).toHaveCount(0);
      await expect(panel.getByRole("textbox")).toHaveCount(1);
    });

    test(`"next quarter" moves an item; the card's fixes wrap and its lines name both items (${where})`, async ({ page }) => {
      // protects: "this quarter" (begun Oct 1) says the move starts on a past day; "move <item> to next quarter" gives a move card from Jan 1 (not "I did not understand"); its red lines name each dependent first and the moved item as what it depends on; every fix button stays inside the card (labels wrap, nothing cut off) and applying one fix proposes it under the commenter's rights
      // fails_when: the relative time is refused, a line names only the moved item, or a fix button pokes out of the card or panel
      // no_claim: the other phrasings (API tests per phrasing); the fixes' resulting dates (test_simple_review_fixes.py)
      await signIn(page, EMAILS.commenter, "/simple/roadmap");
      const panel = await openAsk(page, phone);
      await say(panel, "move Alert rules engine to this quarter");
      await expect(panel.getByTestId("chat-message").last()).toContainText("That period began Oct 1, so the move starts on a past day.");
      await say(panel, "move Alert rules engine to next quarter");
      await expect(panel.getByTestId("chat-message").last()).not.toContainText("past day");
      const card = panel.getByTestId("chat-card").filter({ hasText: "Move Alert rules engine to 1 Jan" });
      await expect(card).toBeVisible();
      const flags = card.getByTestId("chat-card-flag");
      await expect(flags.filter({ hasText: /^‘Weekly alert digest’ starts .+, but ‘Alert rules engine’, which it depends on, ends .+$/ })).toHaveCount(1);
      await expect(flags.filter({ hasText: /^‘Mobile alert push’ starts .+, but ‘Alert rules engine’, which it depends on, ends .+$/ })).toHaveCount(1);
      const fixes = card.getByTestId("chat-card-fix");
      await expect(fixes.filter({ hasText: "Propose: Start Weekly alert digest after Alert rules engine ends" })).toHaveCount(1);
      const box = (await card.boundingBox())!;
      const panelBox = (await panel.boundingBox())!;
      for (const f of await fixes.all()) {
        const b = (await f.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 0.5);
        // The whole label shows: the button is as wide as its text needs.
        expect(await f.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      await tap(fixes.filter({ hasText: "Propose: Start Weekly alert digest after Alert rules engine ends" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to");
    });
  });
}

test("a viewer's one box still answers the plan and changes nothing (desktop)", async ({ page, context }) => {
  // protects: a viewer (who starts no Ask chats) still has the one box: "move <item> to H1" gives a card they may not apply, with why; a line the plan reader does not know gets the reader's reply in the same thread (no second box, no chat started)
  // fails_when: a viewer loses the box, their card is actionable, or a second box appears
  // no_claim: Oracle's Ask for viewers (they start no chats, as before)
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await signIn(page, EMAILS.viewer, "/simple");
  const panel = await openAsk(page, false);
  await expect(panel.getByRole("textbox")).toHaveCount(1);
  await say(panel, "move Weekly alert digest to H1");
  const card = panel.getByTestId("chat-card").filter({ hasText: "Move Weekly alert digest to 1 Jan" });
  await expect(card.getByRole("button", { name: "Apply" })).toBeDisabled();
  await expect(card.getByTestId("chat-card-why-not")).toHaveText("Viewers read the plan; they don't change it");
  await say(panel, "Summarise this page for me");
  // chat-reader: Oracle's reader reads the line; with no change in it, a plain refusal.
  await expect(panel.getByTestId("chat-message").last()).toContainText("I could not tell what to change. Say it another way.");
  await expect(panel.getByTestId("discussion-thread")).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(1);
});

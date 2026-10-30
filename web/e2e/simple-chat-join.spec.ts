import { expect, test, type Locator, type Page } from "./test";

import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * chat-join: Oracle's reader offers chat-actions' new actions too, so free-form lines in a
 * meeting's chat ask for them in the person's own words: "push <item> to next quarter and
 * make <person> own it" restates two changes with Apply all, "we decided to …" a decision
 * card, "note that …" a minutes card, "let's do <item> next" an agenda card. Each card is
 * restated, previewed and applied as any other. The "simple-chat" mock scenario with its
 * invented Delivery items and people; the mock's reader is deterministic (keyword rules, no
 * model). Desktop (1366x820) and phone (390x844), light and dark; the owner and a viewer.
 */

const EMAILS = { owner: ADMIN.email, viewer: "viewer@example.com" } as const;
const MEETING = `/simple/meetings/${CHAT_MEETING_ID}/chat`;

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** The meeting's chat, signed in as `email`. */
async function meeting(page: Page, email: string): Promise<Locator> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(MEETING);
  await expect(page.getByTestId("chat-rules")).toBeVisible();
  return page.getByTestId("meeting-chat");
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

const last = (box: Locator) => box.getByTestId("chat-message").last();

/** Says `text`; Oracle restates one change with the card `summary`, whose Preview reads `lines`; Apply applies it. */
async function oneChange(box: Locator, text: string, summary: string, ...lines: string[]) {
  await say(box, text);
  await expect(box.getByTestId("chat-message-body").filter({ hasText: text }).last()).toBeVisible();
  const line = last(box);
  await expect(line.getByTestId("chat-message-body")).toHaveText("I understood one change:");
  const card = line.getByTestId("chat-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("chat-card-summary")).toHaveText(summary);
  await tap(card.getByRole("button", { name: "Preview" }));
  for (const l of lines) await expect(card.getByTestId("chat-card-preview")).toContainText(l);
  await tap(card.getByRole("button", { name: "Apply", exact: true }));
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
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

    test(`meeting chat: free-form lines ask for the new actions as cards (${where})`, async ({ page }) => {
      // protects: "push <item> to next quarter and make <person> own it" restates two changes (the move and the new owner) and Apply all applies both; "we decided to keep <item> in M3" is a decision card, "note that legal must review the PII rules" a minutes card, "let's do <item> next" an agenda card, each restated "I understood one change:" with its Preview and applied by the owner
      // fails_when: the owner half is dropped (one card), a line gets "I did not understand" or "Say it another way.", a card is missing its restatement or Preview, or Apply fails
      // no_claim: the real reader's model (api tests with a fake model); the meeting screen's notes and agenda (simple-chat-actions.spec.ts)
      const chat = await meeting(page, EMAILS.owner);
      if (dark) await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await say(chat, "push Delivery pipeline v2 to next quarter and make Commenter own it");
      const two = last(chat);
      await expect(two.getByTestId("chat-message-body")).toHaveText("I understood two changes:");
      await expect(two.getByTestId("chat-card")).toHaveCount(2);
      await expect(two.getByTestId("chat-card").nth(0)).toContainText("Move Delivery pipeline v2 to");
      await expect(two.getByTestId("chat-card").nth(1).getByTestId("chat-card-summary")).toHaveText("Make Commenter the owner of Delivery pipeline v2");
      await tap(two.getByRole("button", { name: "Apply all" }));
      await expect(two.locator('[data-testid="chat-card"][data-status="applied"]')).toHaveCount(2);

      await oneChange(chat, "we decided to keep Delivery integrity and release safety in M3", "Record the decision: keep Delivery integrity and release safety in M3", "keep Delivery integrity and release safety in M3");
      await oneChange(chat, "note that legal must review the PII rules", "Add to the minutes: legal must review the PII rules", "legal must review the PII rules");
      await oneChange(chat, "let's do Delivery pipeline v2 next", "Take Delivery pipeline v2 next", "Delivery pipeline v2");
      await expect(chat.getByText("I did not understand that.")).toHaveCount(0);
      await expect(chat.getByText("Say it another way.")).toHaveCount(0);
    });

    test(`meeting chat: a viewer's free-form action gets the ask-the-presenter note (${where})`, async ({ page }) => {
      // protects: a viewer's free-form decision, minutes note, agenda change and owner change each get the viewers' note and no card
      // fails_when: a viewer gets a card or Apply all for any of the new actions
      // no_claim: a viewer's questions (simple-chat.spec.ts)
      const chat = await meeting(page, EMAILS.viewer);
      for (const text of [
        "push Delivery pipeline v2 to next quarter and make Commenter own it",
        "we decided to keep Delivery integrity and release safety in M3",
        "note that legal must review the PII rules",
        "let's do Delivery pipeline v2 next",
      ]) {
        await say(chat, text);
        await expect(chat.getByTestId("chat-message-body").filter({ hasText: text }).last()).toBeVisible();
        await expect(last(chat).getByTestId("chat-message-body")).toHaveText("Viewers ask questions here; ask the presenter to make a change.");
      }
      await expect(chat.getByTestId("chat-card")).toHaveCount(0);
    });
  });
}

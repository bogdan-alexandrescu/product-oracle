import { expect, test, type Locator, type Page } from "./test";

import { THEME_KEY } from "../lib/theme";
import { ADMIN, signOut } from "./helpers";

/*
 * Simple chat follow-ups (the owner's pick, 2026-10-27: "Approvers and owners record it at
 * once, commenters as proposal"): on the Ask panel a commenter's "decision: …" card proposes
 * the decision to the page's decider (the mock's Guided setup PRD names none: its owner,
 * Admin). Apply opens it on the Decisions page; Admin's Home lists it under "Decisions
 * waiting for you", where Decide decides it. Desktop light and phone dark.
 */

const COMMENTER = "commenter@example.com";
const TEXT = "Guided setup ships the tour first";

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

for (const [phone, dark] of [
  [false, false],
  [true, true],
] as const) {
  const where = `${phone ? "phone" : "desktop"}, ${dark ? "dark" : "light"}`;
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript(([themeKey, theme]) => localStorage.setItem(themeKey, theme), [THEME_KEY, dark ? "dark" : "light"] as const);
      if (dark) await page.emulateMedia({ colorScheme: "dark" });
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a commenter's decision on Ask is proposed to the decider, who decides it on Home (${where})`, async ({ page }) => {
      // protects: on Ask a commenter's "decision: …" card offers Propose (not a refusal) and says it goes to the decider; Propose leaves "Proposed to Admin; they decide"; the decision is open on the Decisions page; the decider's Home lists it under "Decisions waiting for you" and Decide decides it
      // fails_when: the commenter's card is refused ("Approvers and owners record decisions"), it records a decided decision, or the decider is not asked
      // no_claim: an approver's and an owner's Ask decision (simple-chat-actions.spec.ts), meetings (unchanged)
      await signIn(page, COMMENTER, "/simple/prds/guided-setup");
      const panel = await openAsk(page, phone);
      await panel.getByRole("textbox", { name: "Message Oracle" }).fill(`decision: ${TEXT}`);
      await tap(panel.getByRole("button", { name: "Send" }));
      const card = panel.getByTestId("chat-card").filter({ hasText: `Record the decision: ${TEXT}` }).last();
      await expect(card.getByTestId("chat-card-proposed-to")).toHaveText("Goes to Admin; they decide");
      await expect(card.getByTestId("chat-card-why-not")).toHaveCount(0);
      await tap(card.getByRole("button", { name: "Preview" }));
      await expect(card.getByTestId("chat-card-preview")).toContainText("Proposed to Admin; they decide");
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Admin; they decide");
      await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);

      await page.goto("/simple/decisions");
      await expect(page.getByRole("region", { name: "Outside meetings" })).toContainText(TEXT);

      await signOut(page);
      await signIn(page, ADMIN.email, "/simple");
      const row = page.getByTestId("home-decision").filter({ hasText: TEXT });
      await expect(row).toBeVisible();
      await tap(row.getByRole("button", { name: `Decide: ${TEXT}` }));
      await expect(page.getByText(`Decided: ${TEXT}`)).toBeVisible();
      await expect(page.getByTestId("home-decision").filter({ hasText: TEXT })).toHaveCount(0);
    });
  });
}

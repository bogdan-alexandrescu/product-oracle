import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/**
 * Simple Definition of Done, item 4 (docs/simple-dod-actions-meet.md): change by chat in
 * Simple's Ask panel on every Simple page, under the person's own permissions, in the
 * "simple-chat" mock scenario, desktop (1440x900) and phone (390x844).
 *
 * Card dod-meet-ask-every-page: protects = on Home, One-pagers, PRDs, a PRD, Roadmap,
 * Priorities, Decisions and Meetings the Ask panel turns "rename …" into a change card; the
 * owner's card says Apply and applies ("Applied by you"), a commenter's says Propose and
 * proposes ("Proposed to Avery Stone by you"); fails_when = a page's Ask panel has no change card,
 * an owner's card proposes, or a commenter's applies; no_claim = previews and ghosts
 * (simple-ask-changes.spec.ts), Oracle's answers to questions.
 *
 * Card dod-meet-ask-viewer: protects = a viewer's rename card, on a phone as on a desktop,
 * has its button disabled with "Viewers read the plan; they don't change it"; fails_when =
 * a viewer's card may act or gives no reason; no_claim = Detailed's panel.
 */

const PAGES = ["/simple", "/simple/one-pagers", "/simple/prds", "/simple/prds/guided-setup", "/simple/roadmap", "/simple/priorities", "/simple/decisions", "/simple/meetings"];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
}

/** Opens Ask Oracle on `to` (the rail's button; the header's Ask on a phone) and sends `text`. */
async function askOn(page: Page, to: string, phone: boolean, text: string) {
  await page.goto(to);
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  await ask.getByLabel("Message Oracle").fill(text);
  await tap(ask.getByRole("button", { name: "Send" }));
  return ask;
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
    });

    for (const [role, email, verb, outcome] of [
      ["an owner", ADMIN.email, "Apply", "Applied by you"],
      ["a commenter", "commenter@example.com", "Propose", "Proposed to Avery Stone by you"],
    ] as const) {
      // card: dod-meet-ask-every-page
      test(`${role}'s Ask card on every Simple page says ${verb} and does it (${where})`, async ({ page }) => {
        test.setTimeout(90_000);
        await signIn(page, email);
        for (const [i, to] of PAGES.entries()) {
          await test.step(to, async () => {
            const name = `Weekly alert digest ${i + 1}`;
            const ask = await askOn(page, to, phone, `rename Weekly alert digest to ${name}`);
            const card = ask.getByTestId("chat-card").filter({ hasText: `“${name}”` });
            await expect(card.getByRole("button", { name: verb, exact: true })).toBeEnabled();
            await tap(card.getByRole("button", { name: verb, exact: true }));
            await expect(card.getByTestId("chat-card-outcome")).toContainText(outcome);
            // An owner's applied rename is undone so the next page renames the same item.
            if (verb === "Apply") {
              await tap(card.getByRole("button", { name: "Undo" }));
              await expect(card.getByTestId("chat-card-outcome")).toContainText("Undone");
            }
          });
        }
      });
    }

    // card: dod-meet-ask-viewer
    test(`a viewer's Ask card is disabled with why (${where})`, async ({ page }) => {
      await signIn(page, "viewer@example.com");
      const ask = await askOn(page, "/simple/roadmap", phone, "rename Weekly alert digest to Weekly alert summary");
      const card = ask.getByTestId("chat-card").filter({ hasText: "Rename Weekly alert digest" });
      await expect(card.getByRole("button", { name: /^(Apply|Propose)$/ })).toBeDisabled();
      await expect(card.getByTestId("chat-card-why-not")).toHaveText("Viewers read the plan; they don't change it");
    });
  });
}

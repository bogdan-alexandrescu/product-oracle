import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * Current state's word pill where a feature is named outside Priorities and the roadmap:
 * a feature (or its roadmap item) Oracle's Ask answer cites, and the item a review meeting's
 * agenda takes next, and each roadmap item a one-pager's plan strip lists under its row. Each
 * pill is a button whose card says what the mark means and names the feature. Against the mock
 * (lib/api/mock/currentstate.ts: Weekly alert digest and Welcome video run today, Alert routing
 * by team with old proof, Setup checklist is being built, Sample data import is new), with the
 * mock's invented people; desktop and phone.
 *
 * Card: protects=the pill beside a feature an answer cites, beside the agenda's next item and
 * beside each roadmap item listed under a one-pager's plan-strip row (by the item's id), and
 * its card opening on a click with its meaning and proof; fails_when=no pill shows there, the
 * row lists no items, or clicking it opens no card; no_claim=the one-pager's lines (bets,
 * risks: they carry no feature or item id in the API) and the plan-led page (PrdPlan).
 */

const PHONE = { width: 390, height: 844 };

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

for (const size of ["desktop", "phone"] as const) {
  test.describe(size, () => {
    if (size === "phone") test.use({ viewport: PHONE });

    test(`an Ask answer's feature carries its pill, and the pill opens its card (${size})`, async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      await signIn(page, "/simple");
      await tap(page.getByTestId(size === "phone" ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const panel = page.getByTestId("hop-panel").filter({ visible: true });
      await expect(panel.getByTestId("ask-chat")).toBeVisible();
      await say(panel, "what is Weekly alert digest about and when does it run?");

      const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      const title = reply.getByTestId("answer-title");
      await expect(title).toContainText("Weekly alert digest");
      await expect(title.getByTestId("cs-mark")).toHaveText("Exists");

      await tap(title.getByRole("button", { name: "What Exists means" }));
      const card = reply.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Weekly alert digest");
      await expect(card).toContainText("Runs today");
    });

    test(`a one-pager lists each plan-strip row's items with their pills (${size})`, async ({ page }) => {
      await signIn(page, "/simple/prds/guided-setup");
      const strip = page.getByLabel("Timeline strip");
      const row = (name: string) => strip.getByRole("listitem").filter({ has: page.getByTestId("plan-strip-label").filter({ hasText: name }) });
      const m1 = row("Milestone M1 · 12 roadmap items");
      await expect(m1.getByTestId("plan-strip-item")).toHaveCount(12);
      await expect(m1.getByTestId("plan-strip-item").first()).toContainText("Setup checklist");
      const item = (r: Locator, name: string) => r.getByTestId("plan-strip-item").filter({ hasText: name });
      // An item with no feature behind it is listed, with no pill.
      await expect(item(m1, "Setup step 3")).toBeVisible();
      await expect(item(m1, "Setup step 3").getByTestId("cs-mark")).toHaveCount(0);

      const kinds: [Locator, string, string, string, RegExp][] = [
        [m1, "Setup checklist", "In progress", "Being built", /4 merged pull requests/],
        [m1, "Sample data import", "New", "Nothing built yet", /No merged pull requests or done tasks yet/],
        [row("Milestone M2 · 5 roadmap items"), "Welcome video", "Exists", "Runs today, with proof", /11 merged pull requests/],
        [row("No milestone · 2 roadmap items"), "Alert routing by team", "Exists · proof old", "more than 30 days old", /4 merged pull requests/],
      ];
      for (const [r, name, word, means, proof] of kinds) {
        const it = item(r, name);
        await expect(it.getByTestId("cs-mark")).toHaveText(word);
        await tap(it.getByRole("button", { name: `What ${word} means` }));
        const card = it.getByTestId("cs-mark-card");
        await expect(card).toBeVisible();
        await expect(card).toContainText(name);
        await expect(card).toContainText(means);
        await expect(card).toContainText(proof);
        await page.keyboard.press("Escape");
        await expect(card).toHaveCount(0);
      }
      // The page still fits a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size === "phone" ? PHONE.width : 1440);
    });

    test(`the meeting agenda's next item carries its pill, and the pill opens its card (${size})`, async ({ page }) => {
      await signIn(page, "/simple/prds/guided-setup");
      await tap(page.getByRole("button", { name: "Start a review meeting" }));
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
      await tap(sheet.getByRole("button", { name: "Start", exact: true }));
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();

      const chat = page.getByTestId("meeting-chat");
      await say(chat, "next: Setup checklist");
      const cardIn = chat.getByTestId("chat-card").filter({ has: page.getByTestId("chat-card-summary").filter({ hasText: "Take Setup checklist next" }) }).last();
      await tap(cardIn.getByRole("button", { name: "Apply" }));
      await expect(cardIn.getByTestId("chat-card-outcome")).toContainText("Applied by you");

      const strip = page.getByTestId("agenda-strip");
      await expect(page.getByTestId("agenda-next")).toHaveText("Next: Setup checklist");
      await expect(strip.getByTestId("cs-mark")).toHaveText("In progress");

      await tap(strip.getByRole("button", { name: "What In progress means" }));
      const card = strip.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Setup checklist");
      await expect(card).toContainText("Being built");
    });
  });
}

import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

/*
 * Ask Oracle visual QA, Nov 12, 2026 (docs/qa/2026-11-12/ask-phone.md), on the mock layer.
 *
 * Cards: share-no-tokens (row 1): protects=Share as discussion never shows Oracle's raw
 * "[c:1]", in the form or the posted discussion; fails_when=the token is pre-filled or
 * stored; no_claim=the API's own strip (api/tests/test_hop_panel.py).
 * intro-heading (row 3): protects=a chat on a PRD's title section reads "<PRD> · Introduction";
 * fails_when=the PRD's name shows twice. one-pager-phone (row 4): protects=the phone sheet
 * names the one-pager; fails_when=it says "One-pager". menu-escape (row 8): protects=Escape on
 * the phone sheet's Discussion actions closes the menu only; fails_when=the sheet closes.
 * live-source (row 10): protects=a Simple answer from a live read lists the read under it;
 * fails_when=only a raised number shows. feature-code (row 11): protects=a Simple answer
 * names a feature with its code; fails_when=the name shows alone. no_claim=visual taste.
 */

const DOC = "/documents/checkout-redesign/v/2";
const COMMENTER = "commenter@example.com";
const PHONE = { width: 390, height: 844 };

const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });

async function askDetailed(page: Page, question: string): Promise<Locator> {
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill(question);
  await panel(page).getByRole("button", { name: "Send" }).click();
  const thread = panel(page).getByTestId("discussion-thread");
  await expect(thread.getByTestId("oracle-reply").last()).toContainText("the goal does not depend on it");
  return thread;
}

async function openSimpleAsk(page: Page, phone: boolean): Promise<Locator> {
  await page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first().click();
  const p = panel(page);
  await expect(p.getByTestId("ask-chat")).toBeVisible();
  return p;
}

test("row 1: Share as discussion pre-fills and posts the reply without its raw citation token", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  await page.getByTestId("hop-strip").click();
  await askDetailed(page, "Why is this ranked third?");

  await panel(page).getByRole("button", { name: "Share as discussion" }).click();
  const box = panel(page).getByTestId("hop-share-form").getByRole("textbox", { name: "First message" });
  await expect(box).toHaveValue(/read the plan thresholds only\. Detection/);
  await expect(box).not.toHaveValue(/\[c:/);
  await panel(page).getByTestId("hop-share-form").getByRole("button", { name: "Post" }).click();
  await expect(panel(page).getByTestId("hop-shared")).toBeVisible();
  const first = panel(page).getByTestId("discussion-thread").getByTestId("discussion-message").first();
  await expect(first).toContainText("read the plan thresholds only. Detection");
  await expect(first).not.toContainText("[c:");
});

test("row 1: a raw token typed into the first message is not stored", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await openSection(page, "problem");
  await page.getByTestId("hop-strip").click();
  await askDetailed(page, "Why is this ranked third?");

  await panel(page).getByRole("button", { name: "Share as discussion" }).click();
  const form = panel(page).getByTestId("hop-share-form");
  await form.getByRole("textbox", { name: "First message" }).fill("Ship the caps first [c:1]. Then detection [l:2].");
  await form.getByRole("button", { name: "Post" }).click();
  await expect(panel(page).getByTestId("hop-shared")).toBeVisible();
  const first = panel(page).getByTestId("discussion-thread").getByTestId("discussion-message").first();
  await expect(first).toContainText("Ship the caps first. Then detection.");
  await expect(first).not.toContainText("[");
});

test("row 3: a chat on a PRD's title section is headed with its Introduction, not the PRD's name twice", async ({ page }) => {
  await login(page, COMMENTER);
  await page.goto(DOC);
  await page.getByTestId("hop-strip").click();
  const about = panel(page).getByTestId("hop-about");
  await expect(about).toContainText("Introduction");
  const thread = await askDetailed(page, "What is this PRD about?");
  await expect(thread).toContainText("Introduction");
  await expect(thread).not.toContainText(/(\S[^·]*\S) · \1(?!\S)/);
});

test("row 4: on a phone, the one-pager's Ask sheet names the one-pager", async ({ context, page }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
  const p = await openSimpleAsk(page, true);
  await expect(p.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", /Guided setup/);
  await expect(p).not.toContainText("about One-pager");
});

test("row 8: on a phone, Escape in the chat's Discussion actions menu closes the menu, not the sheet", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page, COMMENTER);
  await page.getByTestId("phone-ask").click();
  const sheet = page.getByRole("dialog", { name: "Ask Oracle" });
  await expect(sheet).toBeVisible();
  const thread = await askDetailed(page, "Why is this ranked third?");
  await thread.getByRole("button", { name: "Discussion actions" }).click();
  const menu = page.getByRole("menu", { name: "Discussion actions" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(thread.getByTestId("oracle-reply").last()).toContainText("the goal does not depend on it");
  // A second Escape, with no menu open, closes the sheet as before.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test.describe("Simple Ask answers", () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
  });

  for (const size of ["desktop", "phone"] as const) {
    test(`row 10: a live read is listed under the answer with its source, call and time (${size})`, async ({ page }) => {
      await page.setViewportSize(size === "phone" ? PHONE : { width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple");
      const p = await openSimpleAsk(page, size === "phone");
      await p.getByRole("group", { name: "About" }).getByRole("button", { name: "General", exact: true }).click();
      await p.getByRole("textbox", { name: "Message Oracle" }).fill("What are our focus areas, with their Ground Truth features?");
      await p.getByRole("button", { name: "Send" }).click();
      const reply = p.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      await expect(reply.getByTestId("chat-message-body")).toContainText("The last planning call named the same three");
      // The read's words, as Detailed's live chip has them: source, call, time; plain text, no link.
      const read = reply.getByTestId("answer-sources").getByTestId("answer-source").filter({ hasText: "Meeting notes" });
      await expect(read).toHaveText(/^Meeting notes · search · read 5:\d\d AM PDT$/);
      await expect(read).toBeVisible();
      await expect(read).not.toHaveAttribute("href", /./);
    });

    test(`row 11: an answer names a feature with its code before its name (${size})`, async ({ page }) => {
      await page.setViewportSize(size === "phone" ? PHONE : { width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple");
      const p = await openSimpleAsk(page, size === "phone");
      await p.getByRole("textbox", { name: "Message Oracle" }).fill("What is Weekly alert digest about and when does it run?");
      await p.getByRole("button", { name: "Send" }).click();
      const reply = p.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      const title = reply.getByTestId("answer-title");
      await expect(title).toHaveText(/^F-\d+\s*Weekly alert digest.*Exists$/);
      await expect(title.getByTestId("code-tag")).toBeVisible();
      // Every line that names it carries the code too.
      for (const line of await reply.getByTestId("chat-message-body").locator("p, li").filter({ hasText: "Weekly alert digest" }).all())
        await expect(line).toContainText(/F-\d+\s*Weekly alert digest/);
    });
  }
});

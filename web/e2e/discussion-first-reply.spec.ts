import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, sectionAction } from "./helpers";

/*
 * #402 through the UI, on the mock layer ("discussion-replies" scenario): the First message
 * of a new discussion gets Oracle's live reply under the composer's rule. The mock streams a
 * canned answer in 5 pieces that cites the seed's "Raise activation" goal.
 *
 * Card (E2E): protects=the first message's reply streams in, and the start form's rule copy
 * and Ask Oracle; fails_when=no reply comes, or a team discussion gets an unasked one;
 * no_claim=the real model. The API's rule is covered by
 * api/tests/test_discussion_first_reply.py.
 */

const DOC = "/documents/checkout-redesign/v/2";
const COMMENTER = "commenter@example.com";
const ASK = "Can caps ship without detection?";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-replies"), MOCK_SCENARIO_KEY);
const form = (page: Page) => page.getByTestId("start-discussion").filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const reply = (page: Page) => thread(page).getByTestId("oracle-reply").last();
const replyText = (page: Page) => reply(page).getByTestId("oracle-reply-text");

async function openStart(page: Page) {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Start a discussion");
  await expect(form(page)).toBeVisible();
}

async function textLength(page: Page): Promise<number> {
  return ((await replyText(page).textContent()) ?? "").replace("Oracle is thinking…", "").length;
}

// protects=starting a discussion alone with a First message shows Oracle's reply streaming
// in to its cited end; fails_when=the first message gets no reply (#402); no_claim=the model.
test("a discussion started alone with a first message gets Oracle's reply", async ({ page }) => {
  await openStart(page);
  await expect(form(page).getByTestId("oracle-rule")).toHaveText("Oracle will reply");
  await form(page).getByRole("textbox", { name: "First message" }).fill(ASK);
  await form(page).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page).getByTestId("discussion-message").filter({ hasText: ASK })).toHaveCount(1);
  await expect.poll(() => textLength(page), { intervals: [25] }).toBeGreaterThan(0);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(reply(page).getByTestId("cite-c-1")).toBeVisible();
  await expect(replyText(page)).toContainText("Detection can follow once activation holds");
});

async function startPrivateWithApprover(page: Page, first: string, askOracle: boolean) {
  await openStart(page);
  await form(page).getByRole("group", { name: "Visible to" }).getByRole("button", { name: "Only people I pick" }).click();
  await form(page).getByRole("searchbox", { name: "Find a person" }).fill("approver");
  await form(page).getByRole("option", { name: /Approver/ }).click();
  await expect(form(page).getByTestId("oracle-rule")).toHaveText("Oracle replies when you @mention it");
  if (askOracle) {
    await form(page).getByRole("checkbox", { name: "Ask Oracle" }).check();
    await expect(form(page).getByTestId("oracle-rule")).toHaveText("Oracle will reply");
  }
  await form(page).getByRole("textbox", { name: "First message" }).fill(first);
  await form(page).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page).getByTestId("discussion-message").filter({ hasText: first })).toHaveCount(1);
}

// protects=with a teammate picked, the first message gets no reply unasked; fails_when=a team
// discussion gets an unasked reply; no_claim=the API's rule (pytest).
test("with a teammate picked, the first message gets no unasked reply", async ({ page }) => {
  await startPrivateWithApprover(page, "Between us: is the shipping step the real problem?", false);
  await page.waitForTimeout(400);
  await expect(thread(page).getByTestId("oracle-reply")).toHaveCount(0);
});

// protects=Ask Oracle on the start form gets the first message a reply in a team discussion;
// fails_when=it is ignored; no_claim=the API's rule (pytest).
test("Ask Oracle on the start form gets the first message a reply", async ({ page }) => {
  await startPrivateWithApprover(page, ASK, true);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(replyText(page)).toContainText("Detection can follow once activation holds");
});

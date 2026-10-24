import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection, openTab, sectionAction, signOut } from "./helpers";

/*
 * G2 Live replies through the UI, on the mock layer ("discussion-replies" scenario): Oracle
 * answers in a discussion as it writes. The mock streams a canned answer in 5 pieces (the
 * first after a short think, the rest 150 ms apart) that cites the seed's "Raise activation"
 * goal. The scenario seeds, on team-workspaces v2's Problem: the commenter's private
 * discussion with the approver, an open one whose Oracle reply failed for want of a Claude
 * account, and one whose intake has 2 of the commenter's private findings.
 *
 * Card (E2E): protects=streaming is visible, plus Stop, Retry and the reply rule copy;
 * fails_when=text appears only at the end or controls are missing; no_claim=the real model
 * (the mock layer streams canned text). The API's rules are covered by
 * api/tests/test_discussion_replies.py.
 */

const DOC = "/documents/checkout-redesign/v/2";
const SEEDED = "/documents/team-workspaces/v/2";
const PRIVATE_TITLE = "Problem: who owns the admin role?";
const FAILED_TITLE = "Caps: ship without detection?";
const NOTICE_TITLE = "Saved addresses: what the intake found";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const OWNER = "admin@example.com";
const ANSWER = "Yes, if caps read the plan thresholds only [c:1]. Detection can follow once activation holds; the goal does not depend on it.";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-replies"), MOCK_SCENARIO_KEY);
const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const reply = (page: Page) => thread(page).getByTestId("oracle-reply").last();
const replyText = (page: Page) => reply(page).getByTestId("oracle-reply-text");

async function openDiscussion(page: Page, title: string) {
  await page.goto(SEEDED);
  await openTab(page, "Feedback");
  await panel(page).getByTestId("feedback-discussions").click();
  await panel(page).getByTestId("discussion-row").filter({ hasText: title }).first().click();
  await expect(thread(page)).toBeVisible();
}

/** The commenter starts an open discussion on DOC's Problem and asks Oracle. */
async function askAlone(page: Page) {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Discuss this section");
  await page.getByTestId("start-discussion").filter({ visible: true }).getByRole("button", { name: "Start discussion" }).click();
  await expect(thread(page)).toBeVisible();
  await expect(thread(page).getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Reply to Oracle and the team");
  await expect(thread(page).getByTestId("oracle-rule")).toHaveText("Oracle will reply");
  await thread(page).getByRole("textbox", { name: "Message" }).fill("Can caps ship without detection?");
  await thread(page).getByRole("button", { name: "Send" }).click();
}

async function textLength(page: Page): Promise<number> {
  return ((await replyText(page).textContent()) ?? "").replace("Oracle is thinking…", "").length;
}

// protects=criterion 13.1: the reply shows "Oracle is thinking…", then its text grows over
// at least two paints and ends with a citation chip; fails_when=the text appears only at the
// end or no chip; no_claim=the real model.
test("a commenter alone sees Oracle think, then write, then cite", async ({ page }) => {
  await askAlone(page);
  await expect(replyText(page)).toHaveText("Oracle is thinking…");
  await expect.poll(() => textLength(page), { intervals: [25] }).toBeGreaterThan(0);
  const early = await textLength(page);
  await expect(reply(page).getByTestId("oracle-caret")).toBeVisible();
  await expect.poll(() => textLength(page), { intervals: [25] }).toBeGreaterThan(early);
  expect(early).toBeLessThan(ANSWER.length);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(reply(page).getByTestId("cite-c-1")).toBeVisible();
  await expect(replyText(page)).toContainText("Detection can follow once activation holds");
});

// protects=criterion 13.2: Stop during the stream leaves the partial text and Retry;
// fails_when=Stop is missing, the text is lost, or there is no Retry; no_claim=the API's
// cancel timing (test_discussion_replies).
test("Stop leaves the partial text and Retry", async ({ page }) => {
  await askAlone(page);
  await expect.poll(() => textLength(page), { intervals: [25] }).toBeGreaterThan(0);
  await reply(page).getByRole("button", { name: "Stop" }).click();
  await expect(reply(page)).toHaveAttribute("data-status", "cancelled");
  const partial = await textLength(page);
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(ANSWER.length);
  await expect(reply(page).getByRole("button", { name: "Retry" })).toBeVisible();
});

// protects=criterion 13.3: a failed reply reads "Oracle can't reply right now." to a
// commenter and the no-account message to the owner; Retry streams a reply; fails_when=a
// commenter sees account details or Retry does not answer; no_claim=real accounts.
test("the failed reply's copy follows the reader, and Retry streams an answer", async ({ page }) => {
  await withScenario(page);
  await login(page, OWNER);
  await openDiscussion(page, FAILED_TITLE);
  await expect(reply(page).getByTestId("oracle-reply-error")).toContainText("No Claude account: an owner adds one on Settings > Claude accounts");
  await signOut(page);
  await login(page, COMMENTER);
  await openDiscussion(page, FAILED_TITLE);
  await expect(reply(page).getByTestId("oracle-reply-error")).toHaveText("Oracle can't reply right now.");
  await reply(page).getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => textLength(page), { intervals: [25] }).toBeGreaterThan(0);
  await expect(reply(page)).toHaveAttribute("data-status", "complete");
  await expect(reply(page).getByTestId("cite-c-1")).toBeVisible();
});

// protects=criterion 13.4: with the approver in the discussion the composer says Oracle
// replies when @mentioned, and a message without @Oracle gets no reply; fails_when=a team
// thread gets an unasked reply or the copy is wrong; no_claim=the API's rule (pytest).
test("with a teammate in it, Oracle replies only when mentioned", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page, PRIVATE_TITLE);
  await expect(thread(page).getByTestId("oracle-rule")).toHaveText("Oracle replies when you @mention it");
  await thread(page).getByRole("textbox", { name: "Message" }).fill("Handover step added to Scope.");
  await thread(page).getByRole("button", { name: "Send" }).click();
  await expect(thread(page).getByTestId("discussion-message").filter({ hasText: "Handover step added to Scope." })).toHaveCount(1);
  await page.waitForTimeout(400);
  await expect(thread(page).getByTestId("oracle-reply")).toHaveCount(0);
  await thread(page).getByRole("checkbox", { name: "Ask Oracle" }).check();
  await expect(thread(page).getByTestId("oracle-rule")).toHaveText("Oracle will reply");
});

// protects=criterion 13.5: the author of the private findings sees the notice with Review
// sharing; a commenter who is not the author does not; fails_when=anyone else learns of
// them; no_claim=the count's source (pytest).
test("the private-findings notice shows to its author only", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page, NOTICE_TITLE);
  const notice = thread(page).getByTestId("private-findings-notice");
  await expect(notice).toContainText("2 of your private findings bear on this. Share them to let Oracle use them here.");
  await expect(notice.getByRole("link", { name: "Review sharing" })).toBeVisible();
  await signOut(page);
  await login(page, APPROVER);
  await openDiscussion(page, NOTICE_TITLE);
  await expect(thread(page)).toContainText(NOTICE_TITLE);
  await expect(thread(page).getByTestId("private-findings-notice")).toHaveCount(0);
});

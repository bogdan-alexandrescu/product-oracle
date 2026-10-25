import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openTab } from "./helpers";

/*
 * G2 §4 Research this, from inside a discussion, on the mock layer ("discussion-replies"
 * scenario: the open "Caps: ship without detection?" discussion on team-workspaces v2, with
 * the commenter's question). An approver clicks Research this on the question, sees the
 * run's cost before it starts, starts it, and the thread says Oracle is researching; the
 * mock's run then answers, and the answer shows in the thread as Oracle's, marked as
 * research, with its source as a citation chip.
 *
 * Card (E2E): protects=the button for the roles that may start it, the cost first, the
 * answer posted back as Oracle's with its sources; fails_when=a commenter can start it, the
 * cost is not shown before it starts, or the answer does not come back; no_claim=the real
 * runtime (the mock's run answers on the thread's next check). The API's rules are covered
 * by api/tests/test_discussion_research.py.
 */

const SEEDED = "/documents/team-workspaces/v/2";
const TITLE = "Caps: ship without detection?";
const QUESTION = "Can caps ship without detection?";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-replies"), MOCK_SCENARIO_KEY);
const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const question = (page: Page) => thread(page).getByTestId("discussion-message").filter({ hasText: QUESTION });

async function openDiscussion(page: Page, who: string) {
  await withScenario(page);
  await login(page, who);
  await page.goto(SEEDED);
  await openTab(page, "Feedback");
  await panel(page).getByTestId("feedback-discussions").click();
  await panel(page).getByTestId("discussion-row").filter({ hasText: TITLE }).first().click();
  await expect(thread(page)).toBeVisible();
  await expect(question(page)).toBeVisible();
}

// protects=an approver sees the cost before the run starts, can keep from starting it,
// then starts it; the thread says Oracle is researching, then shows Oracle's answer marked
// as research with a citation chip; fails_when=no cost first, no line, or no answer;
// no_claim=the agent's answer.
test("an approver researches a question and Oracle's answer comes back into the thread", async ({ page }) => {
  await openDiscussion(page, APPROVER);
  await question(page).getByRole("button", { name: "Research this" }).click();
  const confirm = thread(page).getByTestId("research-confirm");
  await expect(confirm).toContainText("One research run · $2.00 est.");
  await expect(confirm).toContainText("Oracle posts what it finds here, with its sources.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();

  await question(page).getByRole("button", { name: "Research this" }).click();
  await thread(page).getByTestId("research-confirm").getByRole("button", { name: "Start research" }).click();
  const line = thread(page).getByTestId("research-line");
  await expect(line).toContainText("Approver asked Oracle to research this");
  await expect(line).toContainText("Oracle is researching…");
  await expect(line.getByRole("link", { name: "See the run" })).toHaveAttribute("href", /^\/runs\//);
  await expect(question(page).getByRole("button", { name: "Research this" })).toBeHidden();

  const answer = thread(page).getByTestId("discussion-message").filter({ has: page.getByTestId("research-answer") });
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer).toContainText("Oracle");
  await expect(answer.getByTestId("research-answer")).toHaveText("From research");
  await expect(answer.getByTestId("oracle-reply-text")).toContainText("Teams on the starter plan asked for caps");
  await expect(answer.getByTestId("cite-c-1")).toBeVisible();
  await expect(line).toContainText("Research done");
});

// protects=a commenter cannot start research (an approver's run); fails_when=the button
// shows to a commenter; no_claim=the API's 403 (pytest).
test("a commenter does not see Research this", async ({ page }) => {
  await openDiscussion(page, COMMENTER);
  await expect(question(page).getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(thread(page).getByRole("button", { name: "Research this" })).toHaveCount(0);
});

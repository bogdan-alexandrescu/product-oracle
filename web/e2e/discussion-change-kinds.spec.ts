import { expect, test, type Page } from "./test";

import { DISCUSSION_CHANGE_KINDS } from "../lib/api/mock/discussions";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * G3's priority move, ask and decision changes through the UI, on the mock layer
 * ("discussion-change-kinds" scenario): in the approver's open discussion on the feature-set
 * stop's saved-carts item, Oracle proposed moving Saved carts above Guided setup on a thin
 * reason ("Gut feeling"), asking the approver how long a cart lasts, and a decision. The
 * discussion's link opens its thread in a sheet on the run page. Apply is for approvers and
 * Oracle pushes back on a thin reason first (the mock's stand-in for C9 and the reason check);
 * Ask and Propose are for commenters too.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules are covered by api/tests/test_discussion_changes*.py.
 */

// The run the "feature-set" scenario seeds (web/lib/api/mock/runs.ts FEATURE_SET_RUN).
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";
const MOVE = "Move Saved carts above Guided setup: Gut feeling";
const ASK = "Ask Approver: How long should a saved cart last?";
const APPLY_WHY_NOT = "Approvers apply this change.";
const DECISION = "Ship saved carts before guided setup?";

const withScenario = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "discussion-change-kinds"), MOCK_SCENARIO_KEY);
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });
const card = (page: Page) => thread(page).getByTestId("changes-card");
const change = (page: Page, label: string) => card(page).getByTestId("change-row").filter({ hasText: label });
const handled = (page: Page) => card(page).getByTestId("changes-handled");

async function openDiscussion(page: Page) {
  await page.goto(`/runs/${RUN}?discussion=${DISCUSSION_CHANGE_KINDS}`);
  await expect(thread(page)).toBeVisible();
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 3 changes");
}

// protects=G3 Apply with Oracle's pushback: an approver's Apply on a thin reason shows Oracle's
// objections and stores nothing; "Apply anyway" needs a reason, then the move is Done and the
// thread says who applied what; fails_when=Apply stores the move without pushback, Apply anyway
// goes without a reason, or the change stays open; no_claim=C9's real rules and the priority
// order the override changes (pytest, the priorities specs).
test("an approver applies Oracle's priority move after its pushback", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page);
  const row = change(page, MOVE);
  await expect(row.getByTestId("change-by")).toHaveText("Proposed by Oracle");
  await row.getByRole("button", { name: "Apply", exact: true }).click();
  const pushback = row.getByTestId("apply-pushback");
  await expect(pushback).toContainText("Oracle pushed back on this:");
  await expect(pushback).toContainText("The reason does not say what changed.");
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 3 changes");
  const anyway = row.getByRole("button", { name: "Apply anyway" });
  await expect(anyway).toBeDisabled();
  await row.getByRole("textbox", { name: "Why apply it anyway?" }).fill("Three enterprise deals this month wait on saved carts.");
  await anyway.click();
  await expect(card(page).getByTestId("changes-header")).toHaveText("From this discussion · 2 changes");
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  await expect(change(page, MOVE)).toHaveAttribute("data-status", "done");
  await expect(change(page, MOVE)).toContainText("Done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Approver applied: ${MOVE}`);
});

// protects=#370 for Apply and G3 Ask: a commenter sees Apply disabled with the API's reason,
// and asks the person Oracle named, which marks the change Done with a line in the thread;
// fails_when=a commenter can Apply, the reason is missing, or Ask is refused or leaves the
// change open; no_claim=the question in the asked person's Inbox (the questions specs).
test("a commenter cannot apply, sees why, and asks the person", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  const apply = change(page, MOVE).getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveAttribute("title", APPLY_WHY_NOT);
  await change(page, ASK).getByRole("button", { name: "Ask", exact: true }).click();
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  await expect(change(page, ASK)).toHaveAttribute("data-status", "done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Commenter asked: ${ASK}`);
});

// protects=G3 decision: a person proposes a decision through "Propose a change" (title,
// options, who decides), presses Propose on it, and it lands as a Proposed decision in the
// decision log, which the row links to; fails_when=the kind is not offered, the form loses
// the options or the approver, the change stays open, or the decision log lacks it;
// no_claim=the API's decision subjects (pytest).
test("a commenter proposes a decision that lands in the decision log", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page);
  await card(page).getByRole("button", { name: "Propose a change" }).click();
  await card(page).getByRole("combobox", { name: "Kind of change" }).selectOption({ label: "Propose a decision" });
  const form = card(page).getByTestId("change-form");
  await form.getByRole("textbox", { name: "Decision", exact: true }).fill(DECISION);
  await form.getByRole("textbox", { name: "What is being decided" }).fill("Which ships first next quarter?");
  await form.getByRole("textbox", { name: "Options" }).fill("Saved carts first\nGuided setup first");
  await form.getByRole("combobox", { name: "Who decides" }).selectOption({ label: "Approver" });
  await form.getByRole("button", { name: "Propose" }).click();

  const mine = change(page, `Decide: ${DECISION}`);
  await expect(mine.getByTestId("change-by")).toHaveText("Suggested by Commenter");
  await mine.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(handled(page).locator("summary")).toHaveText("1 handled");
  await handled(page).locator("summary").click();
  const done = change(page, `Decide: ${DECISION}`);
  await expect(done).toHaveAttribute("data-status", "done");
  await expect(thread(page).getByTestId("discussion-system-line")).toHaveText(`Commenter proposed: Decide: ${DECISION}`);
  const link = done.getByRole("link", { name: /^Open D-\d+$/ });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/company\/decisions\?d=/);
  const row = page.getByTestId("decision-row").filter({ hasText: DECISION });
  await expect(row).toContainText("Proposed");
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText(DECISION);
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Saved carts first" })).toBeVisible();
});

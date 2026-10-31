import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login, signOut } from "./helpers";

/*
 * C5 Pre-draft questions, lane 1: the "Before drafting" page (/intakes/<id>), where Oracle
 * asks named people in short batches and says when the PRD is ready to draft. The
 * "before-drafting" mock scenario is the default company plus one brief by
 * admin@example.com with two batches: batch 1 holds an answered question, a critical
 * blocker answered by the approver (waiting for review) and a question asked of
 * approver@example.com; batch 2 two questions asked of admin; twelve more are not asked yet.
 *
 * Test cards:
 * - "answer, review, ready": protects=the page end to end on the mock (answer, review, the
 *   draft gate); fails_when=answer paths, review or gate do not update, or Draft with Oracle
 *   is enabled while a critical question is open (C5 "Draft gate", decided 2026-10-21);
 *   no_claim=the real engine.
 * - "next questions": protects=the preview asks exactly what it shows, of the people chosen;
 *   fails_when=the new batch differs from the preview or the chosen person's Inbox lacks
 *   it; no_claim=ranking quality.
 * - "phone": protects=the page on a 390 px screen; fails_when=the thread is narrower than the
 *   page, the inspector cannot be opened from "Gaps N open", or the page scrolls sideways;
 *   no_claim=other phone layouts.
 * - "Inbox opens the page": protects=an intake question's Open link lands here;
 *   fails_when=it links elsewhere; no_claim=Home's other rows.
 */

const ANSWER_ME = "Which metric shows this worked, what is its value today, and what target by when?";
const WAITING_REVIEW = "What could stop this from shipping at all?";
const WAITING_ON_APPROVER = "What shows this pain is real, and how often does it happen?";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
    // These tests drive the plain answer path; C3 lane 2's follow-ups are in interviews-team.spec.ts.
    localStorage.setItem("po-interview-follow-up", "off");
  });
});

async function openIntake(page: Page) {
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const thread = (page: Page) => page.getByTestId("intake-thread");
const inspector = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true });
const bubble = (page: Page, prompt: string): Locator => thread(page).getByTestId("question").filter({ hasText: prompt });
const answered = (page: Page) => inspector(page).getByTestId("stat-answered");
const draft = (page: Page) => page.getByRole("button", { name: "Draft with Oracle" });

test("answer, review, ready: answer my question, review the critical one, then draft", async ({ page }) => {
  await login(page);
  await openIntake(page);
  await expect(page.getByTestId("nav-prds")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("intake-status")).toHaveText("Waiting for answers");

  // Two batches, each a thread of Oracle's questions.
  const batches = thread(page).getByTestId("batch");
  await expect(batches).toHaveCount(2);
  await expect(batches.nth(0)).toContainText("Batch 1 · 3 questions · asked Oct 20");
  await expect(batches.nth(1)).toContainText("Batch 2 · 2 questions · asked Oct 21");
  await expect(bubble(page, WAITING_ON_APPROVER)).toContainText("Waiting on Approver");
  await expect(bubble(page, WAITING_ON_APPROVER).getByRole("button", { name: "Ask someone else" })).toBeVisible();

  // Answer the question asked of me: my answer shows as my decision; Answered goes up by one.
  const mine = bubble(page, ANSWER_ME);
  await expect(mine).toContainText("Asked you");
  await expect(mine).toContainText("Success metric and baseline");
  await expect(mine).toContainText("Critical");
  await expect(answered(page)).toContainText("2");
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  const form = mine.getByTestId("answer-question");
  for (const name of ["Send answer", "I don't know", "Defer", "Ask someone", "Research this"]) {
    await expect(form.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await form.getByLabel("Your answer").fill("Repeat checkout time: 95 s today, 45 s by March.");
  await form.getByRole("button", { name: "Send answer" }).click();
  const reply = mine.getByTestId("answer");
  await expect(reply).toContainText("Repeat checkout time: 95 s today, 45 s by March.");
  await expect(reply).toContainText("Your answer");
  await expect(answered(page)).toContainText("3");

  // The critical blocker answered below the owner role waits for review, and holds the draft.
  const review = bubble(page, WAITING_REVIEW);
  await expect(review).toContainText("Waiting for review");
  await expect(draft(page)).toBeDisabled();
  await expect(page.getByTestId("draft-reason")).toHaveText(/^\d critical questions open, 1 holds the draft: answer it or record a decision$/);
  const gate = inspector(page).getByTestId("ready-to-draft");
  await expect(gate).toContainText("1 critical question holds the draft");
  await expect(gate.getByTestId("blocking-gap")).toContainText("Blockers: not known yet.");

  await review.getByRole("button", { name: "Review" }).click();
  await review.getByLabel("Rationale").fill("The address API limit covers our volume.");
  await review.getByRole("button", { name: "Validate" }).click();
  await expect(review).not.toContainText("Waiting for review");
  // Nothing holds the draft; the critical questions still open are named, never "Ready to draft" (#307).
  await expect(gate.getByTestId("blocking-gap")).toHaveCount(0);
  await expect(gate).toContainText("critical questions open");
  await expect(gate).not.toContainText("Ready to draft");
  await expect(page.getByTestId("draft-reason")).toHaveCount(0);
  await expect(draft(page)).toBeEnabled();
});

test("decide from the inspector: a blank rationale is refused, a decision clears the gate", async ({ page }) => {
  await login(page);
  await openIntake(page);
  const gate = inspector(page).getByTestId("ready-to-draft");
  await gate.getByRole("button", { name: "Decide" }).click();
  await gate.getByRole("radio", { name: "Accept the risk" }).check();
  await gate.getByRole("button", { name: "Record decision" }).click();
  await expect(gate).toContainText("Write a rationale first");
  await gate.getByLabel("Rationale").fill("We ship behind the limit and watch it.");
  await gate.getByRole("button", { name: "Record decision" }).click();
  await expect(gate.getByTestId("blocking-gap")).toHaveCount(0);
  await expect(gate.getByTestId("missing-gap")).toHaveCount(3);
  await expect(gate).not.toContainText("Ready to draft");
  await expect(draft(page)).toBeEnabled();
});

test("next questions: ask the preview, one of them of the approver, who finds it in the Inbox", async ({ page }) => {
  await login(page);
  await openIntake(page);
  const next = page.getByTestId("next-questions");
  await expect(next).toContainText("Oracle has 12 more questions");
  const rows = next.getByTestId("next-question");
  await expect(rows).toHaveCount(5);
  await next.getByRole("button", { name: "Ask 3 questions at a time" }).click();
  await expect(rows).toHaveCount(3);
  const prompts = await rows.getByTestId("next-prompt").allTextContents();
  const picked = prompts[1];
  await rows.nth(1).getByRole("combobox").selectOption({ label: "Approver" });
  await next.getByRole("button", { name: "Ask these" }).click();

  const batches = thread(page).getByTestId("batch");
  await expect(batches).toHaveCount(3);
  await expect(batches.nth(2)).toContainText("Batch 3 · 3 questions");
  for (const prompt of prompts) await expect(batches.nth(2)).toContainText(prompt);
  await expect(bubble(page, picked)).toContainText("Asked Approver");
  await expect(next).toContainText("Oracle has 9 more questions");

  await signOut(page);
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  const row = page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: picked });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`Before drafting · ${BEFORE_DRAFTING.title}`);
});

test("Inbox opens the page: an intake question's Open goes to Before drafting", async ({ page }) => {
  await login(page);
  await page.goto("/inbox");
  const row = page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: ANSWER_ME });
  await row.getByRole("link", { name: `Open Before drafting · ${BEFORE_DRAFTING.title}` }).click();
  await expect(page).toHaveURL(new RegExp(`/intakes/${BEFORE_DRAFTING.intakeId}$`));
  await expect(page.getByTestId("intake-thread")).toBeVisible();
});

test("phone: the thread is full width and the inspector opens from Show details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await openIntake(page);
  const width = await thread(page).evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(390 - 2 * 16);
  await expect(page.getByTestId("intake-inspector")).toBeHidden();
  // qa-work-29: the Gaps tab is the one way to the gaps; the card opens the inspector.
  await expect(page.getByRole("button", { name: /^Gaps \d+ open$/ })).toHaveCount(0);
  await page.getByTestId("intake-readiness").getByRole("button", { name: "Show details" }).click();
  const sheet = page.getByTestId("intake-sheet");
  await expect(sheet.getByTestId("ready-to-draft")).toContainText("1 critical question holds the draft");
  await sheet.getByRole("button", { name: /^Close/ }).click();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

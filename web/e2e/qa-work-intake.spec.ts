import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";

import { login } from "./helpers";

/*
 * QA pass on the Before drafting page, /intakes/<id> (qa-work-11, 21, 22, 46, 47), on the
 * "before-drafting" mock scenario (see intake-page.spec.ts).
 */

const ANSWER_ME = "Which metric shows this worked, what is its value today, and what target by when?";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
    localStorage.setItem("po-interview-follow-up", "off");
  });
});

async function openIntake(page: Page) {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const thread = (page: Page) => page.getByTestId("intake-thread");
const inspector = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true });
const bubble = (page: Page, prompt: string) => thread(page).getByTestId("question").filter({ hasText: prompt });

test("qa-work-11: the header has one overflow menu, Delete in it", async ({ page }) => {
  await openIntake(page);
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  // The menu's label names the intake (qa-docs-65): "Actions for <title>".
  await expect(header.getByRole("button", { name: /^Actions for / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await header.getByRole("button", { name: /^Actions for / }).click();
  for (const name of ["Rank the questions again", "Archive", "Delete…"]) {
    await expect(page.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
});

test("qa-work-21: a question answered I don't know counts as answered, as unknown, in plain words", async ({ page }) => {
  await openIntake(page);
  const gate = inspector(page).getByTestId("ready-to-draft");
  // Decide the blocker so the critical questions still open are listed.
  await gate.getByRole("button", { name: "Decide" }).click();
  await gate.getByRole("radio", { name: "Accept the risk" }).check();
  await gate.getByLabel("Rationale").fill("We ship behind the limit and watch it.");
  await gate.getByRole("button", { name: "Record decision" }).click();
  await expect(gate.getByTestId("blocking-gap")).toHaveCount(0);
  await expect(gate).not.toContainText("None of them holds the draft");
  await expect(gate).toContainText("They do not stop the draft.");

  const answered = inspector(page).getByTestId("stat-answered");
  await expect(answered).toContainText("2");
  const mine = bubble(page, ANSWER_ME);
  await mine.getByRole("button", { name: "Answer", exact: true }).click();
  await mine.getByTestId("answer-question").getByRole("button", { name: /^I don't know/ }).click();
  await expect(mine.getByTestId("answer")).toBeVisible();
  await expect(inspector(page).getByTestId("answered-unknown")).toContainText("1 answered as unknown");
  await expect(answered).toContainText("3");
  await expect(gate.getByTestId("missing-gap").filter({ hasText: "answered “I don't know”" })).toHaveCount(1);
});

test("qa-work-22: on a phone, Ready to draft? stays on the page above the questions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIntake(page);
  const ready = page.getByTestId("intake-readiness");
  await expect(ready).toBeVisible();
  await expect(ready.getByRole("heading", { name: "Ready to draft?" })).toBeVisible();
  await expect(ready).toContainText("1 critical question holds the draft");
  await expect(ready.getByTestId("intake-readiness-counts")).toContainText("answered");
  await ready.getByRole("button", { name: /^Gaps \d+ open$/ }).click();
  await expect(page.getByTestId("intake-sheet").getByTestId("ready-to-draft")).toBeVisible();
});

test("qa-work-46: days read one way, 'Oct 20', with the full time on hover", async ({ page }) => {
  await openIntake(page);
  const batches = thread(page).getByTestId("batch");
  await expect(batches.nth(0)).toContainText("asked Oct 20");
  await expect(batches.nth(0)).not.toContainText("20 Oct");
  const time = thread(page).getByTestId("answer").first().locator("time");
  await expect(time).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
  await expect(time).toHaveAttribute("title", /\d{1,2}:\d{2}/);
});

test("qa-work-47: the batch size says what it is, and goes when Oracle has no more questions", async ({ page }) => {
  await openIntake(page);
  const next = page.getByTestId("next-questions");
  await expect(next.getByRole("group", { name: "Ask 5 at a time" })).toBeVisible();
  await expect(next.getByText("at a time")).toBeVisible();
  await next.getByRole("button", { name: "Ask 10 questions at a time" }).click();
  await expect(next.getByRole("group", { name: "Ask 10 at a time" })).toBeVisible();
  await next.getByRole("button", { name: "Ask these" }).click();
  await expect(next).toContainText("Oracle has 2 more questions");
  await next.getByRole("button", { name: "Ask these" }).click();
  await expect(next).toContainText("Oracle has no more questions.");
  await expect(next.getByRole("group")).toHaveCount(0);
});

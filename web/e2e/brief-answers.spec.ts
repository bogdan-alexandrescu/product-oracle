import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_TEAM_FOLLOW_UP } from "../lib/api/mock/interviews";
import { login } from "./helpers";

/*
 * brief-answers: the PRD brief page (/intakes/<id>), driven as a person would on the mock API.
 * The "before-drafting" scenario's brief asks admin@example.com (an owner) two questions, with
 * "Oracle follows up" on.
 *
 * Test cards:
 * - "long answer": protects=one Send answer of a long answer (about 1,500 characters) saves it
 *   and the panel counts it; fails_when=the answer is missing or Answered stays 0;
 *   no_claim=the real proxy's timing (next.config.ts proxyTimeout).
 * - "lost reply": protects=a send whose reply was lost on the way back (the answer saved) says
 *   why and keeps the text, and sending it again saves it once; fails_when=the message reads
 *   "Something went wrong", the text is gone, or the second send is refused or saves twice.
 * - "follow-up counts": protects=an answer Oracle follows up on closes its question and counts
 *   at once; the reply adds to it; fails_when=Answered stays 0 until the reply.
 * - "research": protects=Research this says "Research proposed: waits for approval" with a link
 *   to the proposal; Accept starts the research and the question links its run, which runs;
 *   fails_when=the question says "Being researched" while nothing runs, or the run is a draft.
 */

const thread = (page: Page) => page.getByTestId("intake-thread");
const mine = (page: Page): Locator => thread(page).getByTestId("question").filter({ hasText: "Asked you" });
const answered = (page: Page) => page.getByTestId("intake-inspector").getByTestId("stat-answered");
// About 1,500 characters, as a person writes a long answer.
const LONG = "Small clinics with one front desk and a shared phone line come first, then group practices. ".repeat(17).slice(0, 1500).trim();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "before-drafting");
  });
});

async function openBrief(page: Page) {
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(thread(page)).toBeVisible();
  await expect(mine(page)).toHaveCount(2);
}

async function answeredCount(page: Page): Promise<number> {
  const panel = page.getByTestId("intake-inspector");
  if (await panel.isVisible()) return Number((await panel.getByTestId("stat-answered").innerText()).replace(/\D/g, ""));
  return -1;
}

test("long answer: one Send answer saves it and the panel counts it", async ({ page }) => {
  await openBrief(page);
  const before = await answeredCount(page);
  const first = mine(page).nth(0);
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await first.getByLabel("Your answer").fill(LONG);
  await first.getByRole("button", { name: "Send answer" }).click();
  await expect(first.getByTestId("answer")).toContainText(LONG.slice(0, 80));
  await expect(first.getByTestId("follow-up")).toHaveCount(0);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  if (before >= 0) await expect(answered(page)).toContainText(String(before + 1));
});

test("lost reply: the send says why and keeps the text; sending again saves it once", async ({ page }) => {
  await openBrief(page);
  const first = mine(page).nth(0);
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await first.getByLabel("Your answer").fill(LONG);
  await page.evaluate(() => localStorage.setItem("po-mock-lost", "turns"));
  await first.getByRole("button", { name: "Send answer" }).click();
  await expect(first).toContainText("Your answer did not reach Oracle in time. Your text is still here: send it again.");
  await expect(first.getByText("Something went wrong")).toHaveCount(0);
  await expect(first.getByLabel("Your answer")).toHaveValue(LONG);

  await first.getByRole("button", { name: "Send answer" }).click();
  await expect(first.getByTestId("answer")).toHaveCount(1);
  await expect(first.getByTestId("answer")).toContainText(LONG.slice(0, 80));
  await expect(first.getByLabel("Your answer")).toHaveCount(0);
  // Saved once: the text is not there twice over.
  expect((await first.getByTestId("answer").innerText()).split(LONG.slice(0, 60)).length - 1).toBe(1);
});

test("follow-up counts: an answer Oracle follows up on counts at once; the reply adds to it", async ({ page }) => {
  await openBrief(page);
  const before = await answeredCount(page);
  const first = mine(page).nth(0);
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await first.getByLabel("Your answer").fill("Checkout time.");
  await first.getByRole("button", { name: "Send answer" }).click();
  await expect(first.getByTestId("follow-up")).toContainText(MOCK_TEAM_FOLLOW_UP);
  await expect(first.getByTestId("answer")).toContainText("Checkout time.");
  if (before >= 0) await expect(answered(page)).toContainText(String(before + 1));

  await first.getByLabel("Your reply").fill("Checkout time for returning buyers, confirmed by the support lead.");
  await first.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(first.getByTestId("answer")).toHaveCount(1);
  await expect(first.getByTestId("answer")).toContainText("returning buyers");
  if (before >= 0) await expect(answered(page)).toContainText(String(before + 1));
});

test("research: Research this waits for approval with a link; Accept starts the research", async ({ page }) => {
  await openBrief(page);
  const first = mine(page).nth(0);
  await first.getByRole("button", { name: "Answer", exact: true }).click();
  await first.getByRole("button", { name: "Research this" }).click();
  const research = first.getByTestId("question-research");
  await expect(research).toContainText("Research proposed: waits for approval");
  await expect(first).not.toContainText("Being researched");

  await research.getByRole("link", { name: "See the proposal" }).click();
  await expect(page.getByRole("tab", { name: /^Proposals/ })).toHaveAttribute("aria-selected", "true");
  const card = page.getByTestId("proposal").filter({ hasText: "Research:" }).filter({ has: page.getByRole("button", { name: "Accept" }) }).first();
  await expect(card).toBeInViewport();
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card.getByTestId("proposal-status")).toHaveText("Accepted");

  await page.getByRole("tab", { name: /^Questions/ }).click();
  const after = mine(page).nth(0).getByTestId("question-research");
  await expect(after).toContainText("Being researched");
  await after.getByRole("link", { name: "Open the run" }).click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.getByTestId("run-progress").first()).toBeVisible();
  await expect(page.getByTestId("run-progress").first()).not.toHaveText("Not started");
});

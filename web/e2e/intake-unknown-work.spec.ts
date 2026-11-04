import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { login } from "./helpers";

/*
 * Walk 2 problem 19: on the Before drafting page, an answer that says the thing is unknown
 * and finding it out is part of this work becomes a requirement, never a blocker. The
 * "unknown-work" mock scenario is "before-drafting" with its critical Blockers question still
 * asked of approver@example.com, so it holds the draft.
 *
 * Test cards:
 * - "an unknown that is part of the work": protects=the answer settles the question and the
 *   page lists it as a requirement with the answer's words; fails_when=it waits for review,
 *   still holds the draft, or no requirement is shown; no_claim=the real engine's reading.
 * - "a bare unknown": protects=a plain "Unknown." still holds the draft (it waits for
 *   review); fails_when=it is taken for planned work; no_claim=other answer paths.
 */

const BLOCKERS = "What could stop this from shipping at all?";
const HONEST = "Nobody knows yet. Finding out what could stop it is part of this work.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "unknown-work");
    localStorage.setItem("po-interview-follow-up", "off");
  });
});

const thread = (page: Page) => page.getByTestId("intake-thread");
const bubble = (page: Page, prompt: string): Locator => thread(page).getByTestId("question").filter({ hasText: prompt });

async function openIntake(page: Page) {
  await login(page, "approver@example.com");
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(thread(page)).toBeVisible();
}

/** The Before drafting panel: the inspector on a desktop, its sheet on a phone. */
async function gate(page: Page, phone: boolean): Promise<Locator> {
  if (!phone) return page.getByTestId("intake-inspector").filter({ visible: true }).getByTestId("ready-to-draft");
  await page.getByTestId("intake-readiness").getByRole("button", { name: "Show details" }).click();
  return page.getByTestId("intake-sheet").getByTestId("ready-to-draft");
}

async function closeSheet(page: Page, phone: boolean) {
  if (phone) await page.getByTestId("intake-sheet").getByRole("button", { name: /^Close/ }).click();
}

async function answerBlockers(page: Page, text: string) {
  const q = bubble(page, BLOCKERS);
  await q.getByRole("button", { name: "Answer", exact: true }).click();
  const form = q.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill(text);
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(q.getByTestId("answer")).toContainText(text);
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";

  test(`${where}: an unknown that is part of the work becomes a requirement, not a blocker`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await openIntake(page);
    let panel = await gate(page, phone);
    await expect(panel).toContainText("1 critical question holds the draft");
    await expect(panel.getByTestId("blocking-gap")).toHaveCount(1);
    await expect(panel.getByTestId("unknown-work")).toHaveCount(0);
    await closeSheet(page, phone);

    await answerBlockers(page, HONEST);
    // Not a claim to review: the question is settled, and nothing holds the draft.
    await expect(bubble(page, BLOCKERS)).not.toContainText("Waiting for review");
    await expect(page.getByTestId("draft-reason")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Draft with Oracle" })).toBeEnabled();

    panel = await gate(page, phone);
    await expect(panel.getByTestId("blocking-gap")).toHaveCount(0);
    const work = panel.getByTestId("unknown-work");
    await expect(work).toContainText("Not known yet. Finding out is part of this work, so the PRD makes it a requirement, not a blocker:");
    await expect(work.getByTestId("work-item")).toHaveCount(1);
    await expect(work.getByTestId("work-item")).toContainText("Find out what could stop this shipping");
    await expect(work.getByTestId("work-item")).toContainText(`From the answer: “${HONEST}”`);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });

  test(`${where}: a bare "unknown" still holds the draft`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await openIntake(page);
    await answerBlockers(page, "Unknown.");
    // A real answer below the owner role waits for review (B4), and holds the draft.
    await expect(bubble(page, BLOCKERS)).toContainText("Waiting for review");
    const panel = await gate(page, phone);
    await expect(panel.getByTestId("blocking-gap")).toHaveCount(1);
    await expect(panel.getByTestId("unknown-work")).toHaveCount(0);
  });
}

import { expect, test, type Locator, type Page } from "@playwright/test";

import { login, openSection, openTab } from "./helpers";

/*
 * C2 Questions to people: every open question reaches a named person, who answers it from
 * the Inbox. The "questions" mock scenario is the default company plus an "Oracle asks"
 * question on an intake with no PRD (asked of admin), an "Approver asks" question on a PRD
 * section (asked of admin) and a question delegated to approver@example.com.
 *
 * Test cards:
 * - "answer from the Inbox": protects=answering in one place; fails_when=the row only links
 *   away or the badge does not drop; no_claim=the real API.
 * - "the other paths": protects=I don't know, Defer and Ask someone each settle the row, and a
 *   delegated question reaches the delegate; fails_when=the row stays open or the delegate's
 *   Inbox lacks it; no_claim=notifications.
 * - "ask a teammate on a section": protects=the asker sees the answer on the section;
 *   fails_when=the Feedback tab shows no question or no answer; no_claim=other subjects.
 * - "Home": protects=Home's Needs you draws the same row and Answer; fails_when=Home has no
 *   Answer; no_claim=Home's other rows.
 * - "phone": protects=answering on a 390 px screen; fails_when=the sheet lacks a path or the
 *   page scrolls sideways; no_claim=other phone layouts.
 */

const CLINIC = "Which clinics join the waitlist first?";
const TIERS = "Which plan tiers get hard caps?";
const METRIC = "Which metric shows repeat checkout got faster?";
const REFUND = "Same-day cancellation refund?";
const DELEGATED = "Who signs off the refund rule?";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", "questions");
  });
});

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const badge = (page: Page) => page.getByTestId("nav-inbox-badge");

function questionRow(page: Page, text: string): Locator {
  return page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]").filter({ hasText: text });
}

async function signOut(page: Page) {
  await page.getByTestId("user-menu").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function openInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
}

test("answer from the Inbox: Oracle asks, Answer in place, the badge drops, then Done", async ({ page }) => {
  await login(page);
  await openInbox(page);
  const row = questionRow(page, CLINIC);
  await expect(row).toContainText("Oracle asks");
  await expect(row).toContainText("Before drafting · Clinic waitlist");
  await expect(questionRow(page, TIERS)).toContainText("Approver asks");
  await expect(questionRow(page, TIERS)).toContainText("Checkout redesign PRD · 7. Success metrics");
  await expect(badge(page)).toHaveText("12");

  await row.getByRole("button", { name: "Answer" }).click();
  const form = page.getByTestId("answer-question");
  await expect(form).toContainText(CLINIC);
  await expect(form).toContainText("Why Oracle asks");
  for (const name of ["Send answer", "I don't know", "Defer", "Ask someone", "Research this"]) {
    await expect(form.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await form.getByLabel("Your answer").fill("The two downtown clinics, in November.");
  await form.getByRole("button", { name: "Send answer" }).click();

  // In place until the tab changes; the badge counts it no more.
  await expect(row).toContainText("Answered ✓");
  await expect(page.getByTestId("answer-question")).toHaveCount(0);
  await expect(badge(page)).toHaveText("11");
  await expect(page.getByText("11 waiting")).toBeVisible();

  await tab(page, "Done").click();
  await expect(questionRow(page, CLINIC)).toContainText("Answered ✓");
  await tab(page, "New").click();
  await expect(questionRow(page, CLINIC)).toHaveCount(0);
});

test("the other paths: I don't know, Defer and Ask someone leave Open; the delegate sees it", async ({ page }) => {
  await login(page);
  await openInbox(page);
  await tab(page, "Open").click();
  await tab(page, "New").click();

  await questionRow(page, METRIC).getByRole("button", { name: "Answer" }).click();
  await page.getByTestId("answer-question").getByRole("button", { name: "I don't know" }).click();
  await expect(questionRow(page, METRIC)).toContainText("I don't know ✓");

  await questionRow(page, REFUND).getByRole("button", { name: "Answer" }).click();
  await page.getByTestId("answer-question").getByRole("button", { name: "Defer" }).click();
  await expect(questionRow(page, REFUND)).toContainText("Deferred ✓");

  await questionRow(page, TIERS).getByRole("button", { name: "Answer" }).click();
  const form = page.getByTestId("answer-question");
  await form.getByRole("button", { name: /^Ask someone/ }).click();
  await form.getByLabel("Find a person").fill("appr");
  await form.getByRole("option", { name: /Approver/ }).click();
  await expect(questionRow(page, TIERS)).toContainText("Asked Approver ✓");
  await expect(badge(page)).toHaveText("9");

  // Neither under New nor under Open any more: all three are Done.
  for (const name of ["New", "Open"]) {
    await tab(page, name).click();
    for (const text of [METRIC, REFUND, TIERS]) await expect(questionRow(page, text)).toHaveCount(0);
  }
  await tab(page, "Done").click();
  for (const text of [METRIC, REFUND, TIERS]) await expect(questionRow(page, text)).toHaveCount(1);

  // The delegate's Inbox has it, and the question delegated to them before.
  await signOut(page);
  await login(page, "approver@example.com");
  await openInbox(page);
  await expect(questionRow(page, TIERS)).toContainText("Approver asks");
  await expect(questionRow(page, DELEGATED)).toHaveCount(1);
});

test("ask a teammate on a section: Waiting on them, then their answer on the Feedback tab", async ({ page }) => {
  const question = "Do pilots keep their saved addresses after the trial?";
  const reply = "Yes, for 90 days after the trial ends.";
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  const s = await openSection(page, "metrics");
  await s.getByRole("button", { name: "Actions for 7. Success metrics" }).click();
  await page.getByRole("menuitem", { name: /Ask a teammate/ }).click();
  const ask = page.getByTestId("ask-teammate");
  await ask.getByLabel("Find a person").fill("comm");
  await ask.getByRole("option", { name: /Commenter/ }).click();
  await ask.getByLabel("Question").fill(question);
  await ask.getByLabel("Why (optional)").fill("The rollout plan depends on it");
  await ask.getByRole("button", { name: "Ask" }).click();
  await expect(ask).toContainText("Asked Commenter");

  await openTab(page, "Feedback");
  const asked = page.getByTestId("section-questions").filter({ visible: true }).getByTestId("section-question").filter({ hasText: question });
  await expect(asked).toContainText("Waiting on Commenter");

  await signOut(page);
  await login(page, "commenter@example.com");
  await openInbox(page);
  const row = questionRow(page, question);
  await expect(row).toContainText("Admin asks");
  await row.getByRole("button", { name: "Answer" }).click();
  await page.getByTestId("answer-question").getByLabel("Your answer").fill(reply);
  await page.getByTestId("answer-question").getByRole("button", { name: "Send answer" }).click();
  await expect(row).toContainText("Answered ✓");

  await signOut(page);
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "metrics");
  await openTab(page, "Feedback");
  const answered = page.getByTestId("section-questions").filter({ visible: true }).getByTestId("section-question").filter({ hasText: question });
  await expect(answered).toContainText(reply);
  await expect(answered).toContainText("Commenter");
  await expect(answered).not.toContainText("Waiting on");
});

test("Home: Needs you shows the same question row, answered in place", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  const row = page.getByTestId("home-needs-table").locator("tr[data-row]").filter({ hasText: CLINIC });
  await expect(row).toContainText("Oracle asks");
  await expect(row).toContainText("Before drafting · Clinic waitlist");
  await row.getByRole("button", { name: "Answer" }).click();
  const form = page.getByTestId("answer-question");
  await form.getByLabel("Your answer").fill("The two downtown clinics.");
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(row).toContainText("Answered ✓");
  await expect(badge(page)).toHaveText("11");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("at 390 px Answer opens a sheet with the five paths and no sideways scroll", async ({ page }) => {
    await login(page);
    await openInbox(page);
    await questionRow(page, CLINIC).getByRole("button", { name: "Answer" }).click();
    const sheet = page.getByTestId("answer-sheet");
    await expect(sheet).toBeVisible();
    for (const name of ["Send answer", "I don't know", "Defer", "Ask someone", "Research this"]) {
      await expect(sheet.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await sheet.getByLabel("Your answer").fill("Downtown first.");
    await sheet.getByRole("button", { name: "Send answer" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(questionRow(page, CLINIC)).toContainText("Answered ✓");
  });
});

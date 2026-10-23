import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { MOCK_CLOSING, MOCK_FOLLOW_UP, MOCK_GUIDE, MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { login } from "./helpers";

/*
 * C3 customer interviews, lane 1 (#152, criteria 12, 13, 14, 16 and 18), driven through the UI
 * as a person would, on the mock API (./lib/api/mock/interviews.ts). The fixture's link
 * `/i/i-mock-token` invites Ana Lima of Example Co to four questions.
 *
 * The mock lives in one browser context's localStorage and each test gets a fresh context, so
 * each test starts from a freshly seeded fixture; "another browser" is this context with its
 * cookies cleared (a new context would reseed the mock).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const LINK = `/i/${MOCK_INTERVIEW_TOKEN}`;
const DISCLOSURE = "You're talking with an AI assistant working for Example Co's product team. What you write goes to that team.";
const THANKS = "Thank you. Your answers went to Example Co's product team.";
const ANSWERS = {
  first: "Last Tuesday our accountant spent the whole morning paying twelve suppliers one by one.",
  short: "We use bank transfers.",
  followUp: "Each Friday I export the invoices and type every transfer into the bank site by hand.",
  last: "In September a typo sent a payment to the wrong supplier and it took two weeks to recover.",
};

const input = (page: Page) => page.getByTestId("interview-input");
const progress = (page: Page) => page.getByTestId("interview-progress");
const lastOracle = (page: Page) => page.getByTestId("msg-oracle").last().getByTestId("msg-body");

async function answer(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("msg-customer").filter({ hasText: text })).toBeVisible();
  await expect(page.getByTestId("interview-typing")).toHaveCount(0);
}

/**
 * The customer's whole interview on the fixture's link: three questions answered (the short
 * answer gets one follow-up, answered), one skipped, then Send my answers. `midway` runs
 * after the first answer.
 */
async function completeInterview(page: Page, midway?: () => Promise<void>) {
  await page.goto(LINK);
  await expect(page.getByTestId("interview-company")).toHaveText("Example Co");
  await expect(page.getByTestId("interview-disclosure")).toHaveText(DISCLOSURE);
  await expect(page.getByRole("heading", { name: "Hi Ana Lima" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(lastOracle(page)).toContainText(MOCK_GUIDE[0].prompt);
  await expect(progress(page)).toHaveText("1 of 4");

  await answer(page, ANSWERS.first);
  await expect(lastOracle(page)).toContainText(MOCK_GUIDE[1].prompt);
  await expect(progress(page)).toHaveText("2 of 4");
  await midway?.();

  // Thin answer: one follow-up on the same question, then the next question.
  await answer(page, ANSWERS.short);
  await expect(lastOracle(page)).toHaveText(MOCK_FOLLOW_UP);
  await expect(progress(page)).toHaveText("2 of 4");
  await answer(page, ANSWERS.followUp);
  await expect(lastOracle(page)).toContainText(MOCK_GUIDE[2].prompt);
  await expect(page.getByTestId("msg-oracle").filter({ hasText: MOCK_FOLLOW_UP })).toHaveCount(1);

  await page.getByRole("button", { name: "Skip this question" }).click();
  await expect(lastOracle(page)).toContainText(MOCK_GUIDE[3].prompt);
  await expect(progress(page)).toHaveText("4 of 4");

  await answer(page, ANSWERS.last);
  await expect(lastOracle(page)).toHaveText(MOCK_CLOSING);
  await page.getByRole("button", { name: "Send my answers" }).click();
  await expect(page.getByTestId("interview-thanks")).toHaveText(THANKS);
}

/** The link opened from a browser without this one's interview cookie, then the cookie restored. */
async function openElsewhere(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  await context.clearCookies();
  const other = await context.newPage();
  await other.goto(LINK);
  const text = (await other.getByTestId("interview-refused").textContent()) ?? "";
  await other.close();
  await context.addCookies(cookies);
  return text;
}

test("criterion 12: a commenter drafts questions, edits them and creates the link", async ({ page }) => {
  // protects=criterion 12 (Requests → Interview a customer → name → Draft questions shows
  // Oracle's four questions; a deleted and an edited question are what is saved; Create link
  // shows the link once, "Works once · expires … PDT" (#447: the Company time zone); the Interviews tab lists it as Invited);
  // fails_when=the button is missing for a commenter, the guide never arrives, an edit or a
  // delete is lost, or the interview is not Invited; no_claim=the real model's questions and
  // the API's token hashing (api/tests/test_interviews*.py).
  await login(page, "commenter@example.com");
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByRole("button", { name: "Interview a customer" }).click();

  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await dialog.getByLabel("Customer name").fill("Sam Okafor");
  await dialog.getByLabel("Company (optional)").fill("Example Co");
  await dialog.getByRole("button", { name: "A topic" }).click();
  await dialog.getByLabel("Topic in your words").fill("Paying suppliers");
  await dialog.getByRole("button", { name: "Next" }).click();

  const guide = page.getByRole("dialog", { name: "Draft questions" });
  await expect(guide.getByTestId("guide-question")).toHaveCount(4);
  for (const [i, g] of MOCK_GUIDE.entries()) await expect(guide.getByLabel(`Question ${i + 1}`, { exact: true })).toHaveValue(g.prompt);
  await guide.getByRole("button", { name: "Delete question 4" }).click();
  await expect(guide.getByTestId("guide-question")).toHaveCount(3);
  const edited = "Tell me about the last time you paid a supplier. What happened?";
  await guide.getByLabel("Question 1", { exact: true }).fill(edited);
  await guide.getByRole("button", { name: "Create link" }).click();

  const created = page.getByRole("dialog", { name: "Link created" });
  await expect(created.getByLabel("Interview link")).toHaveValue(/^https?:\/\/[^/]+\/i\/i-[0-9a-f]+$/);
  await expect(created.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(created.getByTestId("interview-link-terms")).toHaveText(/^Works once · expires .+ (P[DS]T|GMT[+-]\d+)$/);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toHaveCount(0);

  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/requests\/interviews$/);
  const row = page.getByTestId("interview-row").filter({ hasText: "Sam Okafor" });
  await expect(row.getByTestId("interview-status")).toHaveText("Invited");
  await row.click();
  await expect(page).toHaveURL(/\/requests\/interviews\/[^/]+$/);
  const saved = page.getByTestId("interview-guide");
  await expect(saved.getByRole("listitem")).toHaveCount(3);
  await expect(saved).toContainText(edited);
  await expect(saved).not.toContainText(MOCK_GUIDE[3].prompt);
  // Shown once: the interview's page never shows the link again.
  await expect(page.getByText(/\/i\/i-[0-9a-f]+/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Withdraw link" })).toBeVisible();
});

test("customer completes an interview", async ({ page, context }) => {
  // protects=criterion 13 (no sign-in: the disclosure line and Start; one follow-up on a thin
  // answer, Skip this question, Send my answers, the thank-you; the link works in one browser
  // only and not at all once finished); fails_when=the disclosure is missing or reworded, a
  // second follow-up is asked, Skip or Finish fail, the page sends the visitor to sign-in, or
  // a second browser can continue or reopen the link; no_claim=the real model, the API's
  // HttpOnly cookie and the load-balancer path rule (ops check).
  await completeInterview(page, async () => {
    expect(await openElsewhere(context)).toBe("This link has already been used. Ask the team that sent it for a new one.");
  });
  await expect(page).toHaveURL(new RegExp(`${LINK}$`));
  await expect(page.getByTestId("user-menu")).toHaveCount(0);

  await context.clearCookies();
  await page.goto(LINK);
  await expect(page.getByTestId("interview-refused")).toContainText("This link has already been used");
});

test("criterion 14: the finished interview and its requests, as a member", async ({ page }) => {
  // protects=criterion 14 (after the customer finishes, the interview is Finished with its
  // transcript and snapshot, and Requests' New tab holds its requests marked Unverified with
  // channel Interview); fails_when=the status, a transcript line, the snapshot or a request is
  // missing, or a request reads as verified or from another channel; no_claim=the real snapshot
  // job's quality and its quote filter (api/tests/test_interviews*.py).
  await completeInterview(page);
  await login(page, "commenter@example.com");
  await page.goto("/requests/interviews");
  const row = page.getByTestId("interview-row").filter({ hasText: "Ana Lima" });
  await expect(row.getByTestId("interview-status")).toHaveText("Finished");
  await row.click();

  await expect(page.getByTestId("interview-status")).toHaveText("Finished");
  const transcript = page.getByTestId("interview-transcript");
  for (const text of Object.values(ANSWERS)) await expect(transcript).toContainText(text);
  await expect(transcript).toContainText(MOCK_FOLLOW_UP);
  await expect(transcript).toContainText(`Skipped: ${MOCK_GUIDE[2].prompt}`);
  const snapshot = page.getByTestId("interview-snapshot");
  await expect(snapshot).toContainText("Quick facts");
  await expect(snapshot).toContainText("Ana Lima at Example Co answered 3 of 4 questions");
  await expect(snapshot.getByTestId("snapshot-need")).toHaveCount(3);
  await expect(page.getByTestId("interview-requests").getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Withdraw link" })).toHaveCount(0);

  await page.getByTestId("requests-tab-new").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/requests\/new$/);
  const fromInterview = page.getByTestId("request-row").filter({ hasText: "Ana Lima (Example Co)" });
  await expect(fromInterview).toHaveCount(3);
  for (const r of await fromInterview.all()) {
    await expect(r.getByTestId("request-unverified")).toHaveText("Unverified");
    await expect(r).toContainText("Interview");
  }
  await expect(fromInterview.filter({ hasText: "Last Tuesday our accountant spent the whole morning" })).toHaveCount(1);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const scheme of ["light", "dark"] as const) {
    test(`criterion 16: the customer page at 390 px (${scheme})`, async ({ page }) => {
      // protects=criterion 16 (phone first: no sideways scroll, the input a sticky footer that
      // stays in view as the conversation grows; light and dark); fails_when=the page scrolls
      // sideways or the input scrolls out of view; no_claim=a real phone's on-screen keyboard.
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(LINK);
      await page.getByRole("button", { name: "Start" }).click();
      for (let i = 0; i < 4; i++) await answer(page, `${ANSWERS.first} Then it happened again, ${i + 1} times over.`);
      await expect(lastOracle(page)).toHaveText(MOCK_CLOSING);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // The conversation is taller than the screen; the input still sits at its bottom.
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(input(page)).toBeInViewport();
      const footer = await page.getByTestId("interview-footer").boundingBox();
      expect(footer).not.toBeNull();
      expect(Math.abs(footer!.y + footer!.height - 844)).toBeLessThanOrEqual(1);
      await expect(page.getByTestId("phone-header")).toHaveCount(0);
    });
  }
});

test("criterion 18: other pages still require sign-in", async ({ page }) => {
  // protects=criterion 18 (only /i/ is open without sign-in); fails_when=Requests or the
  // Interviews tab render for a visitor who has not signed in; no_claim=the real proxy.
  for (const path of ["/requests", "/requests/interviews"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("viewers do not interview customers", async ({ page }) => {
  // protects=the commenter-and-up rule for Interview a customer; fails_when=a viewer is offered
  // the button; no_claim=the API's 403 (api/tests/test_interviews*.py).
  await login(page, "viewer@example.com");
  await page.goto("/requests");
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
  await expect(page.getByRole("button", { name: "Interview a customer" })).toHaveCount(0);
});

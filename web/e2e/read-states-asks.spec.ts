import { expect, test, type Page } from "./test";

import { MOCK_CLOSING, MOCK_FOLLOW_UP, MOCK_GUIDE, MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { login, signOut } from "./helpers";

/*
 * #1586: a read that could not ask is never drawn as "none". Each case is checked both ways on
 * invented data: answered first, then the same read failing, said as a failure (with its reason)
 * and not as the answer "none".
 */

const failGets = (page: Page, path: string) => page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);
const toasts = (page: Page) => page.getByTestId("toasts");

test("Home: PRDs you started whose goals could not be read say so, never a PRD for no goal", async ({ page }) => {
  await login(page);
  await page.goto("/simple");
  const simple = page.getByTestId("simple-page");
  await simple.getByRole("button", { name: "New PRD" }).click();
  const s = page.getByTestId("np-sheet");
  await s.getByLabel("Name").fill("Shared packing lists");
  await s.getByLabel("The problem").fill("Families packing for a trip keep separate lists, so they pack the same things twice.");
  await s.getByLabel("Who has it").fill("Families of three or more who travel together");
  await s.getByRole("group", { name: "The goals it helps" }).getByRole("button", { name: "Activation" }).click();
  await s.getByRole("button", { name: "Next" }).click();
  const question = s.getByTestId("np-question");
  await expect(question.getByText("Question 1 of 6")).toBeVisible();
  await question.getByRole("textbox").fill("A list everyone on the trip can edit.");
  await question.getByRole("button", { name: "Next question" }).click();
  await expect(question.getByText("Question 2 of 6")).toBeVisible();
  await question.getByRole("button", { name: "I don't know" }).click();
  await expect(question.getByText("Question 3 of 6")).toBeVisible();
  await s.getByRole("button", { name: "Draft with what I gave" }).click();
  await expect(s).toBeHidden();

  const card = simple.getByTestId("np-started");
  await expect(card.getByText("1 of 6 questions answered. The draft is for Activation.")).toBeVisible();
  const failed = simple.getByTestId("load-error").filter({ hasText: "Could not load the PRDs you started." });
  await expect(failed).toHaveCount(0);

  await failGets(page, "/v1/baseline/entities?type=goal");
  await page.reload();
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  await expect(simple.getByText("1 of 6 questions answered.")).toHaveCount(0);
});

test("Home: an out-of-date suggestion whose proposals could not be read says so, never a bare refusal", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
  const sheet = page.getByTestId("decision-sheet");
  const d10 = () => page.getByRole("region", { name: "Outside meetings", exact: true }).getByTestId("decision-row").filter({ hasText: /^D-10 / });

  // An approver suggests a change to D-10; its decider edits D-10 first.
  await login(page, "approver@example.com");
  await page.goto("/simple/decisions");
  await d10().getByTestId("decision-open").click();
  await sheet.getByRole("button", { name: "Suggest a change" }).click();
  await sheet.getByRole("textbox", { name: "Title", exact: true }).fill("Keep the free plan's six-seat limit");
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(toasts(page).getByText("Sent to Avery Stone to decide")).toBeVisible();
  await signOut(page);
  await login(page);
  await page.goto("/simple/decisions");
  await d10().getByTestId("decision-open").click();
  await sheet.getByRole("button", { name: "Edit" }).click();
  await sheet.getByRole("textbox", { name: "Title", exact: true }).fill("Keep the free plan's seven-seat limit");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);

  // Answered: Accept opens the decision's sheet saying why.
  await page.goto("/simple");
  const item = page.getByTestId("home-proposal").filter({ hasText: "D-10" }).first();
  const accept = item.getByRole("button", { name: "Accept", exact: true });
  await accept.scrollIntoViewIfNeeded();
  await accept.click();
  await expect(sheet.getByRole("alert")).toHaveText("Not accepted: this decision changed since the suggestion was made. Here it is as it is now.");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Failed: the proposals read fails, and the toast says so; no sheet, no bare refusal.
  await failGets(page, "/v1/simple/changes?status=proposed");
  await accept.click();
  await expect(toasts(page).getByText("Mock failure")).toBeVisible();
  await expect(toasts(page).getByText(/outdated/i)).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
});

test("Interview: requests that could not be read say so, never a list of untitled requests", async ({ page }) => {
  // The fixture's customer finishes the interview (as interviews.spec.ts does).
  const last = () => page.getByTestId("msg-oracle").last().getByTestId("msg-body");
  const answer = async (text: string) => {
    await page.getByTestId("interview-input").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("msg-customer").filter({ hasText: text })).toBeVisible();
    await expect(page.getByTestId("interview-typing")).toHaveCount(0);
  };
  await page.goto(`/i/${MOCK_INTERVIEW_TOKEN}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(last()).toContainText(MOCK_GUIDE[0].prompt);
  await answer("Last Tuesday our bookkeeper spent the whole morning paying twelve suppliers one by one.");
  await expect(last()).toContainText(MOCK_GUIDE[1].prompt);
  await answer("We use bank transfers.");
  await expect(last()).toHaveText(MOCK_FOLLOW_UP);
  await answer("Each Friday I export the invoices and type every transfer into the bank site by hand.");
  await expect(last()).toContainText(MOCK_GUIDE[2].prompt);
  await page.getByRole("button", { name: "Skip this question" }).click();
  await expect(last()).toContainText(MOCK_GUIDE[3].prompt);
  await answer("In March a typo sent a payment to the wrong supplier and it took two weeks to recover.");
  await expect(last()).toHaveText(MOCK_CLOSING);
  await page.getByTestId("interview-footer").getByRole("button", { name: "Finish interview" }).click();
  await page.getByRole("alertdialog", { name: "Finish interview" }).getByRole("button", { name: "Finish interview" }).click();
  await expect(page.getByTestId("interview-thanks")).toBeVisible();

  await login(page, "commenter@example.com");
  await page.goto("/requests/interviews");
  await page.getByTestId("interview-row").filter({ hasText: "Ana Lima" }).click();
  const panel = page.getByTestId("interview-requests");
  const first = panel.getByRole("link").first();
  await expect(first).not.toHaveText("Request");
  await expect(panel.getByTestId("load-error")).toHaveCount(0);
  const rid = new URL((await first.getAttribute("href"))!, "http://example.com").searchParams.get("request")!;

  await failGets(page, `/v1/requests/${rid}`);
  await page.reload();
  const failed = page.getByTestId("interview-requests").getByTestId("load-error");
  await expect(failed).toContainText("Could not load the requests.");
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  await expect(page.getByTestId("interview-requests").getByRole("link", { name: "Request", exact: true })).toHaveCount(0);
});

test("Draft with Oracle: a Ground Truth status that could not be read again says so, not only a reason-less notice", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved delivery notes");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their delivery notes at every checkout.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  const reuse = sheet.getByRole("radio", { name: /^Use the current Ground Truth/ });

  // Answered: the Ground Truth goes stale after the sheet opened; Estimate says why it is rebuilt.
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(reuse).toBeChecked();
  await page.evaluate(() => localStorage.setItem("po-mock-scenario", "baseline-stale"));
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet).toContainText("The last Ground Truth review was approved 41 days ago: Oracle rebuilds it first.");
  await expect(sheet.getByRole("alert").filter({ hasText: "Mock failure" })).toHaveCount(0);

  // Failed: the same, with the status read failing: the failure shows.
  await page.evaluate(() => localStorage.removeItem("po-mock-scenario"));
  await page.reload();
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(reuse).toBeChecked();
  await page.evaluate(() => localStorage.setItem("po-mock-scenario", "baseline-stale"));
  await failGets(page, "/v1/baseline/review-status");
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByRole("alert").filter({ hasText: "Mock failure" })).toBeVisible();
  await expect(sheet).not.toContainText("41 days ago");
});

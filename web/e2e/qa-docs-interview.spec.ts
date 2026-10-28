import { expect, test, type Page } from "./test";

import { MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";

/*
 * QA pass 1, docs lane, the customer's interview page /i/<token> (no sign-in), on the mock API.
 *
 * qa-docs-18: one Send; ending the interview is its own button, "Finish interview", and it asks
 * first. qa-docs-69: the first question names its topic; the company name in the header lines up
 * with the conversation's column on desktop and on a phone.
 */

const LINK = `/i/${MOCK_INTERVIEW_TOKEN}`;

async function start(page: Page) {
  await page.goto(LINK);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("interview-input")).toBeVisible();
}

test("qa-docs-18: one Send, and Finish interview asks before it ends the interview", async ({ page }) => {
  await start(page);
  const footer = page.getByTestId("interview-footer");
  // One button sends; no second "Send …" that quietly finishes.
  await expect(footer.getByRole("button", { name: /^Send/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send my answers" })).toHaveCount(0);

  await page.getByTestId("interview-input").fill("Last Tuesday our accountant paid twelve suppliers one by one, all morning.");
  await footer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("interview-progress")).toHaveText("2 of 4");

  // Finish asks first; Back keeps the conversation going.
  await footer.getByRole("button", { name: "Finish interview" }).click();
  const ask = page.getByRole("alertdialog", { name: "Finish interview" });
  await expect(ask).toContainText("this link stops working");
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("interview-thanks")).toHaveCount(0);
  await expect(page.getByTestId("interview-input")).toBeVisible();

  await footer.getByRole("button", { name: "Finish interview" }).click();
  await page.getByRole("alertdialog", { name: "Finish interview" }).getByRole("button", { name: "Finish interview" }).click();
  await expect(page.getByTestId("interview-thanks")).toHaveText("Thank you. Your answers went to Example Co's product team.");
});

/** The header's company name and the first message start at the same x. */
async function expectAligned(page: Page) {
  const head = await page.getByTestId("interview-company").boundingBox();
  const body = await page.getByTestId("interview-disclosure").boundingBox();
  const first = await page.getByTestId("msg-oracle").first().boundingBox();
  expect(head && body && first).toBeTruthy();
  expect(Math.abs(head!.x - body!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(head!.x - first!.x)).toBeLessThanOrEqual(1);
}

test("qa-docs-69: the first question names its topic and the header lines up with the column (desktop)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const first = page.getByTestId("msg-oracle").first().getByTestId("msg-body");
  await expect(first).toContainText("paying suppliers");
  await expect(first).not.toContainText("ran into this");
  await expectAligned(page);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-69: the header lines up with the column on a phone", async ({ page }) => {
    await start(page);
    await expect(page.getByTestId("msg-oracle").first()).toContainText("paying suppliers");
    await expectAligned(page);
  });
});

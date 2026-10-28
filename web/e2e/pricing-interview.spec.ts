import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/*
 * H9 Pricing input (#516): Interview a customer gains a Pricing choice whose guide is six fixed
 * questions at once, with no guide job, driven through the UI as a person would, on the mock API
 * (./lib/api/mock/interviews.ts). Each test gets a fresh browser context, so a freshly seeded mock.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const FIRST = "At what price would this be so cheap you would doubt its quality?";
const SIXTH = "Who approves a purchase like this, and from which budget?";

test("an approver creates a pricing interview and sees the six preset questions at once", async ({ page }) => {
  // protects=H9 (Requests → Interview a customer → Pricing → Next shows the six fixed pricing
  // questions straight away, question 1 the too-cheap price and question 6 the budget owner,
  // editable and linkable as today; the Interviews tab lists it); fails_when=the Pricing choice
  // is missing, the create body loses the preset (Oracle's four drafted questions or a drafting
  // state appear instead), the guide is not the preset's six, or an edit is not saved;
  // no_claim=the API's preset column, its 409 on redraft and the snapshot's price read-back
  // (api/tests/test_interviews*.py).
  await login(page, "approver@example.com");
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByRole("button", { name: "Interview a customer" }).click();

  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await dialog.getByLabel("Customer name").fill("Avery Quinn");
  await dialog.getByLabel("Company (optional)").fill("Northwind Example");
  await dialog.getByRole("button", { name: "A topic" }).click();
  await dialog.getByLabel("Topic in your words").fill("Pricing the supplier payments add-on");
  await dialog.getByRole("button", { name: "Use the pricing question set", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use the pricing question set", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByTestId("interview-questions-hint")).toContainText("Six fixed questions");
  await dialog.getByRole("button", { name: "Next" }).click();

  const guide = page.getByRole("dialog", { name: "Pricing questions" });
  await expect(guide.getByTestId("guide-question")).toHaveCount(6);
  await expect(guide.getByTestId("guide-drafting")).toHaveCount(0);
  await expect(guide.getByLabel("Question 1", { exact: true })).toHaveValue(FIRST);
  await expect(guide.getByLabel("Question 6", { exact: true })).toHaveValue(SIXTH);
  await expect(guide.getByTestId("guide-pricing-note")).toBeVisible();
  await expect(guide.getByRole("button", { name: "Draft again" })).toHaveCount(0);

  // A member edits the preset guide as today.
  const edited = "Who signs off on a purchase like this at Northwind Example, and from which budget?";
  await guide.getByLabel("Question 6", { exact: true }).fill(edited);
  await guide.getByRole("button", { name: "Save" }).click();
  await expect(guide.getByTestId("guide-saved")).toBeVisible();
  await expect(guide.getByLabel("Question 6", { exact: true })).toHaveValue(edited);
  await expect(guide.getByLabel("Question 1", { exact: true })).toHaveValue(FIRST);

  await guide.getByRole("button", { name: "Create link" }).click();
  const created = page.getByRole("dialog", { name: "Link created" });
  await expect(created.getByLabel("Interview link")).toHaveValue(/^https?:\/\/[^/]+\/i\/i-[0-9a-f]+$/);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(created).toHaveCount(0);

  await page.getByTestId("requests-tab-interviews").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/requests\/interviews$/);
  const row = page.getByTestId("interview-row").filter({ hasText: "Avery Quinn" });
  await expect(row.getByTestId("interview-status")).toHaveText("Invited");
});

test("a topic interview without Pricing still has Oracle draft its questions", async ({ page }) => {
  // protects=the default stays Oracle drafting (H9 must not make every interview a pricing one);
  // fails_when=the Pricing choice is on by default, or a plain interview shows the pricing
  // questions; no_claim=the real model's questions.
  await login(page, "approver@example.com");
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Interview a customer" }).click();

  const dialog = page.getByRole("dialog", { name: "Interview a customer" });
  await expect(dialog.getByRole("button", { name: "Oracle drafts them" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Customer name").fill("Avery Quinn");
  await dialog.getByRole("button", { name: "A topic" }).click();
  await dialog.getByLabel("Topic in your words").fill("Paying suppliers");
  await dialog.getByRole("button", { name: "Next" }).click();

  const guide = page.getByRole("dialog", { name: "Draft questions" });
  await expect(guide.getByTestId("guide-question")).toHaveCount(4);
  await expect(guide.getByTestId("guide-pricing-note")).toHaveCount(0);
  await expect(guide.getByLabel("Question 1", { exact: true })).not.toHaveValue(FIRST);
});

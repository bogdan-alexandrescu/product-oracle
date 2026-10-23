import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Document review setup in the UI (#342): the Review settings sheet (decider, mandatory
 * reviewers, required sections, re-review on change), each section's owner, reviewers and
 * due date, and feedback campaigns asked for and closed, all from the document page.
 */

const DOC = "/documents/checkout-redesign";

async function asRole(page: Page, role: "approver" | "commenter" | "viewer") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

test("an owner sets the decider, mandatory reviewers, required sections and re-review, and they stay set", async ({ page }) => {
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await expect(sheet).toContainText("Default policy");

  await sheet.getByRole("button", { name: "Choose the decider" }).click();
  await sheet.getByRole("option", { name: /approver@example\.com/ }).click();
  await expect(sheet.getByTestId("decider")).toContainText("Approver");

  await sheet.getByRole("button", { name: "Add a mandatory reviewer" }).click();
  // Only approvers and owners can approve: a commenter is not offered.
  await expect(sheet.getByRole("option", { name: /commenter@example\.com/ })).toHaveCount(0);
  await sheet.getByRole("option", { name: /admin@example\.com/ }).click();
  await expect(sheet.getByTestId("mandatory-reviewers")).toContainText("Admin");

  await sheet.getByRole("checkbox", { name: "2. Problem" }).check();
  await sheet.getByRole("checkbox", { name: /Ask for re-review/ }).uncheck();
  await sheet.getByRole("button", { name: "Save review settings" }).click();
  await expect(sheet).toHaveCount(0);

  // Reopened (and after a reload), the document's own policy shows what was saved.
  await page.reload();
  await page.getByRole("button", { name: "Review settings" }).click();
  await expect(sheet).toContainText("Set for this document");
  await expect(sheet.getByTestId("decider")).toContainText("Approver");
  await expect(sheet.getByTestId("mandatory-reviewers")).toContainText("Admin");
  await expect(sheet.getByRole("checkbox", { name: "2. Problem" })).toBeChecked();
  await expect(sheet.getByRole("checkbox", { name: /Ask for re-review/ })).not.toBeChecked();

  // A decider can be cleared again.
  await sheet.getByRole("button", { name: "Remove Approver" }).click();
  await sheet.getByRole("button", { name: "Save review settings" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "Review settings", exact: true }).click();
  await expect(sheet.getByTestId("decider")).toContainText("Any approver");
});

test("an approver sets a section's owner, reviewers and due date in place", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  const panel = page.getByTestId("section-assignments");
  // Seeded: goal-trace is owned by the signed-in member, due Oct 24.
  const seeded = panel.locator('[data-section-key="goal-trace"]');
  await expect(seeded).toContainText("Owner Admin");
  await expect(seeded).toContainText("Due Oct 24");

  const row = panel.locator('[data-section-key="problem"]');
  await expect(row).toContainText("No owner");
  await row.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" }).click();
  await row.getByRole("button", { name: "Choose the owner" }).click();
  await row.getByRole("option", { name: /commenter@example\.com/ }).click();
  await row.getByRole("button", { name: "Add a reviewer" }).click();
  await row.getByRole("option", { name: /approver@example\.com/ }).click();
  await row.getByLabel("Due date").fill("2026-11-02");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Owner Commenter");
  await expect(row).toContainText("Approver");
  await expect(row).toContainText("Due Nov 2");

  await page.reload();
  await expect(panel.locator('[data-section-key="problem"]')).toContainText("Owner Commenter");
  await expect(panel.locator('[data-section-key="problem"]')).toContainText("Due Nov 2");
});

test("an approver asks for feedback, then closes and reopens the campaign", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  const panel = page.getByTestId("campaigns");
  await expect(panel).toContainText("Company-wide feedback");

  await panel.getByRole("button", { name: "Ask for feedback" }).click();
  await panel.getByLabel("Title").fill("Pilot clinic read-through");
  await panel.getByLabel("Message (optional)").fill("Read the scope and say what is missing.");
  await panel.getByRole("button", { name: "Send" }).click();
  const row = panel.getByRole("listitem").filter({ hasText: "Pilot clinic read-through" });
  await expect(row).toContainText("Open");
  await expect(row).toContainText("v2");

  await row.getByRole("button", { name: "Close Pilot clinic read-through" }).click();
  await expect(row).toContainText("Closed");
  await row.getByRole("button", { name: "Reopen Pilot clinic read-through" }).click();
  await expect(row).toContainText("Open");
});

test("a viewer sees every review control disabled, with the reason", async ({ page }) => {
  await asRole(page, "viewer");
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await expect(sheet.getByTestId("review-reason")).toHaveText("Only an owner can change review settings.");
  await expect(sheet.getByRole("button", { name: "Save review settings" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Choose the decider" })).toBeDisabled();
  await expect(sheet.getByRole("checkbox", { name: "2. Problem" })).toBeDisabled();
  await sheet.getByRole("button", { name: "Close Review settings" }).click();

  const sections = page.getByTestId("section-assignments");
  await expect(sections.getByTestId("review-reason")).toHaveText("Only an approver or owner can assign sections.");
  await expect(sections.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" })).toBeDisabled();
  const campaigns = page.getByTestId("campaigns");
  await expect(campaigns.getByTestId("review-reason")).toHaveText("Only an approver or owner can ask for feedback.");
  await expect(campaigns.getByRole("button", { name: "Ask for feedback" })).toBeDisabled();
  await expect(campaigns.getByRole("button", { name: "Close Company-wide feedback" })).toBeDisabled();
});

test("an approver can assign sections but not change the review settings", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await expect(sheet.getByTestId("review-reason")).toHaveText("Only an owner can change review settings.");
  await expect(sheet.getByRole("button", { name: "Save review settings" })).toBeDisabled();
});

test("phone (390 px): the sheet and both panels fit, and an owner saves from the sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto(DOC);
  await expect(page.getByTestId("section-assignments")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Review settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Review settings" });
  await sheet.getByRole("checkbox", { name: "4. Scope" }).check();
  const save = sheet.getByRole("button", { name: "Save review settings" });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await save.click();
  await expect(sheet).toHaveCount(0);
  const row = page.getByTestId("section-assignments").locator('[data-section-key="scope"]');
  await expect(row).toContainText("Required");
});

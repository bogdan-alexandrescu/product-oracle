import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 4, docs-share lane, review group: the Review settings sheet (Escape in a picker,
 * the policy pill explained, Save in view), section due dates and the feedback campaigns on
 * a PRD's overview (past dates refused, overdue marked, the number asked, one button
 * style), the Versions table and details (one state meaning, one date format), no layout
 * shift when a sheet opens, and the audience preview dimmed in dark mode. All on the mock
 * layer, driven as a person would; the mock clock is pinned at Oct 22, 2026.
 */

const PRD = "/documents/checkout-redesign";

test.use({ viewport: { width: 1440, height: 900 } });

async function openSettings(page: Page) {
  await login(page);
  await page.goto(PRD);
  await page.getByRole("button", { name: "Review settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Review settings" });
}

test("qa4-docs-share-1: Escape in the reviewer picker closes the picker only; the sheet and its picks stay", async ({ page }) => {
  const sheet = await openSettings(page);
  await sheet.getByRole("button", { name: "Choose the decider" }).click();
  await sheet.getByRole("option", { name: /approver@example\.com/ }).click();
  await expect(sheet.getByTestId("decider")).toContainText("Approver");
  await sheet.getByRole("checkbox", { name: "2. Problem" }).check();

  const add = sheet.getByRole("button", { name: "Add a mandatory reviewer" });
  await add.click();
  await expect(sheet.getByTestId("person-picker")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(sheet.getByTestId("person-picker")).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(add).toBeFocused();
  await expect(sheet.getByTestId("decider")).toContainText("Approver");
  await expect(sheet.getByRole("checkbox", { name: "2. Problem" })).toBeChecked();

  // A second Escape, with no picker open, closes the sheet as before.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("qa4-docs-share-33: the policy pill says what it means and Save stays in view", async ({ page }) => {
  const sheet = await openSettings(page);
  await expect(sheet).toContainText("Default policy");
  await expect(sheet.getByTestId("policy-source-hint")).toHaveText(/^Nothing is set for this document yet/);
  await expect(sheet.getByRole("button", { name: "Save review settings" })).toBeInViewport();
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeInViewport();
});

test("qa4-docs-share-12: Ask for feedback refuses a due date in the past", async ({ page }) => {
  await login(page);
  await page.goto(PRD);
  const panel = page.getByTestId("campaigns");
  await panel.getByRole("button", { name: "Ask for feedback" }).click();
  await panel.getByLabel("Title").fill("Example past read-through");
  await expect(panel.getByLabel("Due date (optional)")).toHaveAttribute("min", "2026-10-22");
  await panel.getByLabel("Due date (optional)").fill("2026-09-01");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel).toContainText("Pick today or a later day for the due date.");
  await expect(panel.getByRole("listitem").filter({ hasText: "Example past read-through" })).toHaveCount(0);

  // A day ahead is taken.
  await panel.getByLabel("Due date (optional)").fill("2026-11-02");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("listitem").filter({ hasText: "Example past read-through" })).toContainText("due Nov 2");
});

test("qa4-docs-share-38: a new campaign counts the people asked, not 0 of 0", async ({ page }) => {
  await login(page);
  await page.goto(PRD);
  const panel = page.getByTestId("campaigns");
  await panel.getByRole("button", { name: "Ask for feedback" }).click();
  await panel.getByLabel("Title").fill("Example team read-through");
  await panel.getByRole("button", { name: "Send" }).click();
  const row = panel.getByRole("listitem").filter({ hasText: "Example team read-through" });
  await expect(row).toContainText(/0 of [1-9]\d* took part/);
  await expect(row).not.toContainText("0 of 0 took part");
});

test("qa4-docs-share-36: an open campaign past its due date is marked Overdue", async ({ page }) => {
  await page.clock.setSystemTime(new Date("2026-10-31T19:00:00Z"));
  await login(page);
  await page.goto(PRD);
  const row = page.getByTestId("campaigns").getByRole("listitem").filter({ hasText: "Company-wide feedback" });
  await expect(row).toContainText("Overdue Oct 26");
  await expect(row).not.toContainText("due Oct 26");
});

test("qa4-docs-share-37: the cards' equal actions share one button style", async ({ page }) => {
  await login(page);
  await page.goto(PRD);
  const campaigns = page.getByTestId("campaigns");
  await expect(campaigns.getByRole("button", { name: "Ask for feedback" })).toHaveAttribute("data-variant", "secondary");
  await expect(campaigns.getByRole("button", { name: "End campaign Company-wide feedback" })).toHaveAttribute("data-variant", "secondary");
  const sections = page.getByTestId("section-assignments");
  await expect(sections.getByRole("button", { name: /^Edit owner and reviewers of/ }).first()).toHaveAttribute("data-variant", "secondary");
  await expect(sections.getByTestId("unassigned-sections").getByRole("button")).toHaveAttribute("data-variant", "secondary");
});

test("qa4-docs-share-13, qa4-docs-share-34: the fold says it shows the sections; a past section due date is refused", async ({ page }) => {
  await login(page);
  await page.goto(PRD);
  const panel = page.getByTestId("section-assignments");
  const fold = panel.getByTestId("unassigned-sections");
  await expect(fold).toContainText(/more sections? with no owner/);
  const show = fold.getByRole("button", { name: /^Show \d+ sections? to assign$/ });
  await show.click();
  await expect(fold).toContainText(/with no owner, listed above/);
  await expect(fold).not.toContainText("more section");
  await expect(fold.getByRole("button", { name: "Hide" })).toBeVisible();

  const row = panel.locator('[data-section-key="problem"]');
  await row.getByRole("button", { name: "Edit owner and reviewers of 2. Problem" }).click();
  await row.getByLabel("Due date").fill("2026-10-01");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Pick today or a later day for the due date.");
  await expect(row.getByLabel("Due date")).toBeVisible();
});

test("qa4-docs-share-15, qa4-docs-share-17: Versions say Approved and Latest the same way, with one date format", async ({ page }) => {
  await login(page);
  await page.goto("/documents/usage-alerts");
  const row = page.getByTestId("versions-table").getByRole("row").filter({ has: page.getByRole("link", { name: "Version 1" }) });
  await expect(row).toContainText("Approved");
  await expect(row).toContainText("Latest");
  // Approved is written as Imported is: the day and the time.
  await expect(page.getByTestId("version-inspector").getByTestId("version-approved")).toHaveText(/^Oct 3, \d{1,2}:\d{2} [AP]M/);
});

test("qa4-docs-share-19: opening a sheet does not shift the header sideways", async ({ page }) => {
  await login(page);
  await page.goto(PRD);
  await expect(page.locator("html")).toHaveCSS("scrollbar-gutter", "stable");
  const button = page.getByRole("button", { name: "Review settings", exact: true });
  const before = await button.boundingBox();
  await button.click();
  await expect(page.getByRole("dialog", { name: "Review settings" })).toBeVisible();
  const after = await button.boundingBox();
  expect(after?.x).toBe(before?.x);
});

test("qa4-docs-share-58: in dark mode the audience preview is dimmed", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap");
  const frame = page.getByTestId("audience-view").locator("iframe");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveCSS("filter", "brightness(0.8)");
});

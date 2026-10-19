import { expect, test, type Page } from "@playwright/test";

import { login, section } from "./helpers";

/** The review panel's tab, in the visible version view. */
async function openTab(page: Page, name: string | RegExp) {
  await page.getByRole("tab", { name }).filter({ visible: true }).click();
}

function feedbackItem(page: Page, text: string) {
  return page.getByTestId("feedback-item").filter({ visible: true, hasText: text });
}

test("jobs panel: status, account, cost, and a clear no-account failure that can be retried", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces");
  const panel = page.getByTestId("jobs-panel");
  const review = panel.getByTestId("llm-job").filter({ hasText: "Review comments" });
  await expect(review).toHaveAttribute("data-status", "succeeded");
  await expect(review.getByTestId("job-account")).toHaveText("personal");
  await expect(review.getByTestId("job-cost")).toHaveText("$0.03");
  await expect(review).toContainText("3 feedback items handled · 1 pushback");

  const reports = panel.getByTestId("llm-job").filter({ hasText: "Reporting" });
  await expect(reports).toHaveAttribute("data-status", "failed");
  await expect(reports.getByTestId("job-error")).toContainText("No Claude account can take this call");
  await expect(reports.getByTestId("job-error")).toContainText("Every Claude account is paused");

  await reports.getByRole("button", { name: "Retry" }).click();
  await expect(reports).toHaveAttribute("data-status", "succeeded");
  await expect(reports.getByTestId("job-account")).toHaveText("personal");
});

test("suggestion cards: classification, duplicates, edit and accept, and a pushback the approver overrides", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await openTab(page, "Feedback");

  const demand = feedbackItem(page, "how many teams asked");
  const card = demand.getByTestId("suggestion");
  await expect(card).toContainText("Change request");
  await expect(card).toContainText("Proposed text for #problem");
  await expect(card.getByTestId("suggestion-text")).toContainText("Seven in ten sales calls");
  // O1c: the proposed body carries no citation markers.
  await expect(card.getByTestId("suggestion-text")).not.toContainText("[c:");

  await expect(feedbackItem(page, "quantify the demand").getByTestId("suggestion")).toContainText("Duplicate of an earlier item");

  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Proposed section text").fill("Seven in ten sales calls with teams asked for shared editing this quarter.");
  await card.getByRole("button", { name: "Save edit" }).click();
  await expect(card.getByTestId("suggestion-text")).toHaveText("Seven in ten sales calls with teams asked for shared editing this quarter.");
  await expect(card).toContainText("(edited)");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toContainText("Accepted");
  await expect(card).toContainText("use “Refine section” on #problem");

  // Pushback: reasoning and sources; keeping the call needs a reason.
  const custom = feedbackItem(page, "custom roles").getByTestId("suggestion");
  const pushback = custom.getByTestId("pushback");
  await expect(pushback).toContainText("Oracle pushes back");
  await expect(pushback).toContainText("Confirmed goal: Team adoption");
  await expect(pushback.getByRole("link", { name: "Roles research notes" })).toHaveAttribute("href", /roles-research/);
  await custom.getByRole("button", { name: "Keep my call" }).click();
  const accept = custom.getByRole("button", { name: "Accept anyway" });
  await expect(accept).toBeDisabled();
  await custom.getByLabel(/Why keep your call/).fill("Two design partners need a billing-only role.");
  await accept.click();
  await expect(custom).toContainText("Kept the call: Two design partners need a billing-only role.");
});

test("take Oracle's advice: the suggestion is dismissed and the feedback declined", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await openTab(page, "Feedback");
  const item = feedbackItem(page, "custom roles");
  await item.getByRole("button", { name: "Take the advice" }).click();
  await expect(item.getByTestId("suggestion")).toContainText("Dismissed");
  await expect(item).toContainText("Declined");
  await expect(item).toContainText("Resolution: Custom roles in the first release work against the goal");
});

test("refine a section from an accepted suggestion: diff preview, accept, next version with resolutions", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await openTab(page, "Feedback");
  await feedbackItem(page, "how many teams asked").getByRole("button", { name: "Accept" }).click();
  await expect(feedbackItem(page, "how many teams asked").getByTestId("suggestion")).toContainText("Accepted");

  const problem = section(page, "problem");
  await problem.getByRole("button", { name: "Refine section 1. Problem" }).click();
  const refine = problem.getByTestId("refine-panel");
  await expect(refine.getByRole("checkbox")).toBeChecked();
  await refine.getByRole("button", { name: "Refine", exact: true }).click();
  const preview = refine.getByTestId("refine-preview");
  await expect(preview.locator("ins").first()).toContainText("Seven in ten sales calls");
  await preview.getByRole("button", { name: "Accept as next version" }).click();

  await expect(page).toHaveURL(/\/documents\/team-workspaces\/v\/3/);
  const revised = section(page, "problem");
  await expect(revised).toContainText("Seven in ten sales calls");
  // Section ids are kept; the other sections are untouched.
  await expect(section(page, "roles")).toContainText("Three fixed roles");

  await openTab(page, "Feedback");
  await expect(feedbackItem(page, "how many teams asked")).toContainText("addressed in v3");
  await expect(feedbackItem(page, "quantify the demand")).toContainText("addressed in v3");
  await expect(feedbackItem(page, "how many teams asked").getByTestId("suggestion")).toContainText("Applied");

  // The new version's reports were queued and written.
  await openTab(page, "Reports");
  const reports = page.getByTestId("reports-panel").filter({ visible: true });
  await expect(reports.getByRole("region", { name: "Resolution report" })).toContainText("addressed in this version");
  await reports.getByRole("tab", { name: "What changed since v2" }).click();
  await expect(reports.getByRole("region", { name: "What changed" })).toContainText("1. Problem");
});

test("refine from an approver's instruction alone, editing before accepting", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  const users = section(page, "users");
  await users.getByRole("button", { name: /^Refine section/ }).click();
  const refine = users.getByTestId("refine-panel");
  await expect(refine).toContainText("No accepted suggestions on this section");
  await refine.getByLabel("Instruction (optional)").fill("Name the first-time buyer segment explicitly.");
  await refine.getByRole("button", { name: "Refine", exact: true }).click();
  await refine.getByRole("button", { name: "Edit first" }).click();
  await refine.getByLabel("Your edit of the section body").fill("First-time buyers on mobile are the segment that matters most.");
  await refine.getByRole("button", { name: "Accept as next version" }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/3/);
  await expect(section(page, "users")).toContainText("First-time buyers on mobile are the segment that matters most.");
});

test("locked sections offer no refinement", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  const scope = section(page, "scope");
  await expect(scope.getByRole("button", { name: /^Refine section/ })).toBeVisible();
  await scope.getByRole("group", { name: "Verdict for 3. Scope" }).getByRole("button", { name: "Approve" }).click();
  await scope.getByRole("button", { name: /Save: Approved/ }).click();
  await expect(scope.getByTestId("verdict-state")).toContainText("Locked");
  await expect(scope.getByRole("button", { name: /^Refine section/ })).toHaveCount(0);
});

test("reports on a version: write, read both tabs, export", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await openTab(page, "Reports");
  const reports = page.getByTestId("reports-panel").filter({ visible: true });
  await expect(reports).toContainText("No reports yet.");
  await reports.getByRole("button", { name: "Write reports" }).click();
  const resolution = reports.getByRole("region", { name: "Resolution report" });
  await expect(resolution).toContainText("4 of 4 feedback items were addressed in this version.");
  await expect(resolution).toContainText("Handled in version 2: Added the September funnel numbers");

  await reports.getByRole("tab", { name: "What changed since v1" }).click();
  const changes = reports.getByRole("region", { name: "What changed" });
  await expect(changes).toContainText("5.3 Saved addresses");
  await expect(reports.getByTestId("new-sources")).toContainText("Q3 support ticket export");

  const download = page.waitForEvent("download");
  await reports.getByRole("button", { name: "Export reports MD" }).click();
  expect((await download).suggestedFilename()).toBe("checkout-redesign-v2-reports.md");
});

for (const email of ["viewer@example.com", "commenter@example.com"]) {
  test(`roles: ${email.split("@")[0]}s read suggestions and jobs but cannot act`, async ({ page }) => {
    await login(page, email);
    await page.goto("/documents/team-workspaces/v/2");
    await expect(section(page, "problem")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Refine section/ })).toHaveCount(0);
    await openTab(page, "Feedback");
    const card = feedbackItem(page, "how many teams asked").getByTestId("suggestion");
    await expect(card).toContainText("Proposed text for #problem");
    await expect(card.getByRole("button")).toHaveCount(0);
    await openTab(page, "Jobs");
    const jobs = page.getByTestId("jobs-panel").filter({ visible: true });
    await expect(jobs.getByTestId("llm-job").first()).toBeVisible();
    // No action buttons; the (i) tip is not an action.
    await expect(jobs.locator('button:not([data-testid="info-tip"])')).toHaveCount(0);
    await expect(jobs.getByTestId("llm-job-settings").getByRole("checkbox").first()).toBeDisabled();
  });
}

test("an owner turns a job kind off for a document", async ({ page }) => {
  await login(page);
  await page.goto("/documents/checkout-redesign");
  const settings = page.getByTestId("llm-job-settings");
  const review = settings.getByLabel("Review comments");
  await expect(review).toBeChecked();
  await review.uncheck();
  await expect(review).not.toBeChecked();
  await page.getByTestId("jobs-panel").getByRole("button", { name: "Handle new feedback" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "turned off" })).toHaveText(
    "Review comments is turned off for this document (409)",
  );
  await page.reload();
  await expect(page.getByTestId("llm-job-settings").getByLabel("Review comments")).not.toBeChecked();
});

test("a new comment queues review comments, and Oracle's suggestion appears on it", async ({ page }) => {
  await login(page);
  await page.goto("/documents/team-workspaces/v/2");
  await expect(section(page, "scope")).toBeVisible();
  await page.evaluate(() => {
    const body = [...document.querySelectorAll<HTMLElement>('[data-section-body="scope"]')].find((el) => el.checkVisibility())!;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const at = node.data.indexOf("One invoice per workspace");
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "One invoice per workspace".length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return;
      }
    }
  });
  await page.getByRole("button", { name: /^Comment/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Split the invoice by project for agencies.");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();

  await openTab(page, "Feedback");
  const card = feedbackItem(page, "Split the invoice by project").getByTestId("suggestion");
  await expect(card).toContainText("Proposed text for #scope");
  await openTab(page, "Jobs");
  await expect(
    page.getByTestId("jobs-panel").filter({ visible: true }).getByTestId("llm-job").first(),
  ).toContainText("1 feedback item handled");
});

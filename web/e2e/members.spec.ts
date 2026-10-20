import { expect, test, type Page } from "@playwright/test";

import { feedbackState, login, section, selectText, openSection, showAll } from "./helpers";

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });

test("members: an owner changes a role, and the last owner is protected", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByTestId("member-row")).toHaveCount(4);
  await expect(memberRow(page, "admin@example.com")).toContainText("(you)");

  const viewer = page.getByLabel("Role for viewer@example.com");
  await expect(viewer).toHaveValue("viewer");
  await viewer.selectOption("commenter");
  await expect(viewer).toHaveValue("commenter");
  await page.reload();
  await expect(page.getByLabel("Role for viewer@example.com")).toHaveValue("commenter");

  // The only owner cannot step down: the API refuses and the selector snaps back.
  const self = page.getByLabel("Role for admin@example.com");
  await self.selectOption("approver");
  await expect(page.getByRole("alert").filter({ hasText: "last owner" })).toBeVisible();
  await expect(self).toHaveValue("owner");
});

test("members: invite someone, then revoke the invite", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const invites = page.getByTestId("invite-row");
  await expect(invites).toHaveCount(1);
  // Initials come from the email's local part, never from its domain.
  const rows = page.getByTestId("member-row");
  await expect(rows.filter({ hasText: "admin@example.com" }).getByRole("img")).toHaveText("AD");
  await expect(rows.filter({ hasText: "approver@example.com" }).getByRole("img")).toHaveText("AP");
  await expect(invites.first()).toContainText("new.hire@example.com");

  // The header's Invite takes you to the form; the form's own button sends it.
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.getByLabel("Email").fill("Pat@Example.com");
  await page.getByLabel("Role", { exact: true }).selectOption("approver");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(invites).toHaveCount(2);
  await expect(invites.first()).toContainText("pat@example.com");
  await expect(invites.first()).toContainText("Approver");
  await expect(page.getByLabel("Email")).toHaveValue("");

  // An existing member cannot be invited.
  await page.getByLabel("Email").fill("viewer@example.com");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already a member" })).toBeVisible();

  await page.getByRole("button", { name: "Revoke invite for pat@example.com" }).click();
  await expect(invites).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("invite-row")).toHaveCount(1);
  await expect(page.getByText("pat@example.com")).toHaveCount(0);
});

test("members: non-owners see a note instead of the member list", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("role-note")).toContainText("Only owners");
  await expect(page.getByTestId("member-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
});

test("roles: a viewer reads and exports but has no comment, verdict or approve controls", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("role-note")).toContainText("read-only access (viewer)");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toHaveCount(0);
  await expect(section(page, "problem").getByTestId("verdict-state")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await expect(page.getByTestId("publish-link")).toHaveCount(0);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export MD" })).toBeEnabled();

  // Selecting text offers no comment button; existing threads have no reply or resolve.
  await openSection(page, "s-5-3");
  await selectText(page, "s-5-3", "Choosing a card fills the form");
  await page.waitForTimeout(200);
  await expect(page.getByRole("button", { name: /^Comment/ })).toHaveCount(0);
  const thread = page.locator('[data-testid="feedback-item"][data-kind="comment"]').filter({ visible: true }).first();
  await expect(thread.getByTestId("comment")).toBeVisible();
  await expect(thread.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await expect(thread.getByRole("button", { name: "Resolve" })).toHaveCount(0);
});

test("roles: a commenter comments and resolves their own thread, not others'", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("role-note")).toContainText("need the approver role");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await expect(page.getByTestId("publish-link")).toHaveCount(0);

  // Someone else's thread: reply yes, resolve no.
  await showAll(page);
  const theirs = page.locator('[data-testid="feedback-item"][data-kind="comment"]').filter({ visible: true }).first();
  await expect(theirs.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(theirs.getByRole("button", { name: "Resolve" })).toHaveCount(0);

  await openSection(page, "scope");
  await selectText(page, "scope", "the order review page");
  await page.getByRole("button", { name: /^Comment/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Which month is this from?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();
  const mine = page.getByTestId("feedback-item").filter({ visible: true, hasText: "Which month is this from?" });
  await expect(mine).toBeVisible();
  await mine.getByRole("button", { name: "Resolve" }).click();
  // Done: it stays in view, in its new state, until the filter changes.
  await expect(mine.getByTestId("feedback-state-chip")).toHaveText("Done");
  await expect(mine.getByRole("button", { name: "Reopen" })).toBeVisible();
  await feedbackState(page, "Done");
  await feedbackState(page, "Open");
  await expect(mine).toHaveCount(0);
});

test("roles: an approver sets verdicts and publishes a ready PRD, but cannot manage members", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toBeVisible();
  await expect(page.getByTestId("role-note")).toHaveCount(0);
  await showAll(page);
  await expect(
    page.locator('[data-testid="feedback-item"][data-kind="comment"]').filter({ visible: true }).first().getByRole("button", { name: "Resolve" }),
  ).toBeVisible();
  // checkout-redesign carries a critical blocker: Publish opens the screen, which refuses.
  await page.getByTestId("doc-header").getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/publish$/);
  await expect(page.getByTestId("publish-button")).toBeDisabled();
  await expect(page.getByTestId("block-row").first()).toBeVisible();
  // A ready PRD publishes.
  await page.goto("/documents/visit-reminders/publish");
  await page.getByTestId("publish-button").click();
  await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
});

test("roles: a role change shows up on the reviewer's next page load", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Role for viewer@example.com").selectOption("approver");
  await expect(page.getByLabel("Role for viewer@example.com")).toHaveValue("approver");
  await page.getByTestId("user-menu").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await login(page, "viewer@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toBeVisible();
});

import { expect, test, type Page } from "./test";

import { feedbackState, login, section, selectText, openSection, showAll, signOut } from "./helpers";

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });

test("members: an owner changes a role, and the last owner is protected", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  // Four active members and one removed one (kept: history keeps the name).
  await expect(page.getByTestId("member-row")).toHaveCount(5);
  await expect(memberRow(page, "admin@example.com")).toContainText("(you)");

  const viewer = page.getByLabel("Role for viewer@example.com");
  await expect(viewer).toHaveValue("viewer");
  await viewer.selectOption("commenter");
  await expect(viewer).toHaveValue("commenter");
  await page.reload();
  await expect(page.getByLabel("Role for viewer@example.com")).toHaveValue("commenter");

  // The only owner cannot step down: their role control is unavailable and says why.
  const self = page.getByRole("button", { name: "Role for admin@example.com" });
  await expect(self).toHaveAttribute("aria-disabled", "true");
  await self.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "only owner" })).toBeVisible();
});

test("members: invite someone, copy the link, then revoke the invite", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const invites = page.getByTestId("invite-row");
  // A5: the seeded open invite and an expired one.
  await expect(invites).toHaveCount(2);
  await expect(invites.first()).toContainText("new.hire@example.com");

  await page.getByLabel("Email").fill("Pat@Example.com");
  await page.getByLabel("Role", { exact: true }).selectOption("approver");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(invites).toHaveCount(3);
  await expect(invites.first()).toContainText("pat@example.com");
  await expect(invites.first()).toContainText("Approver");
  await expect(page.getByLabel("Email")).toHaveValue("");

  // An existing member cannot be invited.
  await page.getByLabel("Email").fill("viewer@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already a member" })).toBeVisible();

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy link for pat@example.com" }).click();
  await expect(invites.first()).toContainText("Copied");

  // Revoked: the row keeps its place with the outcome and Undo for a moment, then leaves.
  // The clock holds while the test looks, so a loaded machine cannot let the moment pass
  // unseen; it steps only to let the revoke's request through.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.getByRole("button", { name: "Revoke invite for pat@example.com" }).click();
  const acted = invites.first().getByTestId("acted");
  await expect(async () => {
    if (!(await acted.count())) await page.clock.runFor(100);
    await expect(acted).toContainText("Revoked", { timeout: 100 });
  }).toPass();
  await page.clock.resume();
  await expect(invites).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId("invite-row")).toHaveCount(2);
  await expect(page.getByText("pat@example.com")).toHaveCount(0);
});

test("members: undo brings a revoked invite back", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const row = page.getByTestId("invite-row").filter({ hasText: "new.hire@example.com" });
  const emailed = await row.getByTestId("invite-email").textContent();
  await page.getByRole("button", { name: "Revoke invite for new.hire@example.com" }).click();
  await row.getByRole("button", { name: "Undo" }).click();
  await expect(row.getByRole("button", { name: "Revoke invite for new.hire@example.com" })).toBeVisible();
  // Undo invites them again: the row shows the new invite's email once it is made.
  await expect(row.getByTestId("invite-email")).not.toHaveText(emailed ?? "");
  await page.reload();
  await expect(page.getByTestId("invite-row").filter({ hasText: "new.hire@example.com" })).toHaveCount(1);
});

// A5 (#203): the note became the read-only people list (AC 33 is in members-people.spec.ts).
test("members: non-owners see the read-only list", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("people-readonly").getByTestId("person-row").filter({ hasText: "approver@example.com" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-members")).toBeVisible();
  await expect(page.getByTestId("member-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
});

test("roles: a viewer reads and exports but has no comment, verdict or approve controls", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toHaveCount(0);
  await expect(section(page, "problem").getByTestId("verdict-state")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await expect(page.getByTestId("publish-link")).toHaveCount(0);
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export Markdown (.md)" })).toBeEnabled();

  // Selecting text offers no comment button; existing threads have no reply or resolve.
  await openSection(page, "s-5-3");
  await selectText(page, "s-5-3", "Choosing a card fills the form");
  await page.waitForTimeout(200);
  await expect(page.getByRole("button", { name: /^Comment(\s+c)?$/ })).toHaveCount(0);
  const thread = page.locator('[data-testid="feedback-item"][data-kind="comment"]').filter({ visible: true }).first();
  await expect(thread.getByTestId("comment")).toBeVisible();
  await expect(thread.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await expect(thread.getByRole("button", { name: "Resolve" })).toHaveCount(0);
});

test("roles: a commenter comments and resolves their own thread, not others'", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("view-only")).toHaveCount(0);
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
  await page.getByRole("button", { name: /^Comment(\s+c)?$/ }).click();
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await dialog.getByLabel("Comment").fill("Which month is this from?");
  await dialog.getByLabel("Comment").press("Control+Enter");
  await expect(dialog).toBeHidden();
  const mine = page.getByTestId("feedback-item").filter({ visible: true, hasText: "Which month is this from?" });
  await expect(mine).toBeVisible();
  await mine.getByRole("button", { name: "Resolve" }).click();
  // Resolved: it leaves the Open list; Done shows it, with Reopen.
  await expect(mine).toHaveCount(0);
  await feedbackState(page, "Done");
  await expect(mine.getByTestId("feedback-state-chip")).toHaveText("Done");
  await expect(mine.getByRole("button", { name: "Reopen" })).toBeVisible();
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
  await signOut(page);

  await login(page, "viewer@example.com");
  await page.goto("/documents/checkout-redesign/v/2");
  await openSection(page, "problem");
  await expect(section(page, "problem").getByRole("group", { name: /Verdict for/ })).toBeVisible();
});

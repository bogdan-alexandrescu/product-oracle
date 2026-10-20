import { expect, test, type Page } from "@playwright/test";

import { ADMIN, login, signOut } from "./helpers";

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const tokenRow = (page: Page, name: string) => page.getByTestId("token-row").filter({ hasText: name });

test("members: remove asks in an in-app dialog, then restore lets them sign in again", async ({ page }) => {
  let nativeDialog = false;
  page.on("dialog", () => (nativeDialog = true));
  await login(page);
  await page.goto("/settings/members");
  const row = memberRow(page, "commenter@example.com");
  await expect(row).toHaveAttribute("data-status", "active");

  await page.getByRole("button", { name: "Remove commenter@example.com" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this member?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("commenter@example.com");
  for (const line of ["can't sign in", "connections and sources stop", "go back to the Inbox", "History keeps their name", "An owner can restore them"]) {
    await expect(dialog.getByRole("list", { name: "What happens" })).toContainText(line);
  }
  // Cancel leaves everything as it was.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveAttribute("data-status", "active");

  await page.getByRole("button", { name: "Remove commenter@example.com" }).click();
  await dialog.getByRole("button", { name: "Remove member" }).click();
  await expect(dialog).toBeHidden();
  // Disabled, not deleted: the row stays in place with its outcome, then offers Restore.
  await expect(row.getByTestId("acted")).toContainText("Removed");
  await expect(row).toHaveAttribute("data-status", "disabled");
  await expect(row).toContainText(/Removed \w+ \d+/);
  await expect(page.getByTestId("member-row")).toHaveCount(5);
  await expect(row.getByRole("button", { name: "Restore commenter@example.com" })).toBeVisible();
  expect(nativeDialog).toBe(false);

  // A removed member cannot sign in.
  await signOut(page);
  await page.getByLabel("Email").fill("commenter@example.com");
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);

  await login(page);
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Restore commenter@example.com" }).click();
  await expect(memberRow(page, "commenter@example.com")).toHaveAttribute("data-status", "active");
  await expect(page.getByLabel("Role for commenter@example.com")).toBeEnabled();
});

test("members: removing revokes the member's tokens, and Undo restores them right away", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const row = memberRow(page, "approver@example.com");
  await expect(row.getByTestId("open-tokens")).toHaveText("1");
  await page.getByRole("button", { name: "Remove approver@example.com" }).click();
  await page.getByRole("dialog", { name: "Remove this member?" }).getByRole("button", { name: "Remove member" }).click();
  // Undo sits where Remove was, for about a second.
  await row.getByRole("button", { name: "Undo" }).click();
  await expect(row).toHaveAttribute("data-status", "active");
  await expect(row.getByTestId("open-tokens")).toHaveText("0");

  // Their token stays revoked (a restore brings back sign-in only).
  await page.goto("/settings/api-tokens");
  await expect(tokenRow(page, "laptop cli")).toContainText("Revoked");
});

test("members: you cannot remove yourself or the last owner, and the control says why", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const remove = memberRow(page, "admin@example.com").getByRole("button", { name: "Remove admin@example.com" });
  await expect(remove).toHaveAttribute("aria-disabled", "true");
  await remove.hover();
  await expect(page.getByRole("tooltip").filter({ hasText: "can't remove yourself" })).toBeVisible();
  await expect(page.getByRole("tooltip").filter({ hasText: "only owner" })).toBeVisible();
  await remove.click({ force: true });
  await expect(page.getByRole("dialog", { name: "Remove this member?" })).toBeHidden();

  // With a second owner you are no longer the last one, but still cannot remove yourself.
  await page.getByLabel("Role for approver@example.com").selectOption("owner");
  await expect(page.getByLabel("Role for admin@example.com")).toBeEnabled();
  await remove.hover();
  const tip = page.getByRole("tooltip").filter({ hasText: "can't remove yourself" });
  await expect(tip).toBeVisible();
  await expect(tip).not.toContainText("only owner");
});

test("api tokens: every kind, filter by kind and member, revoke with confirm", async ({ page }) => {
  await login(page);
  await page.goto("/settings/api-tokens");
  await expect(page.getByRole("heading", { level: 1, name: "API tokens" })).toBeVisible();
  const rows = page.getByTestId("token-row");
  await expect(rows).toHaveCount(8);
  for (const kind of ["personal", "service", "run", "mcp_client"]) {
    await expect(page.locator(`[data-testid="token-row"][data-kind="${kind}"]`).first()).toBeVisible();
  }
  await expect(tokenRow(page, "agent-track")).toContainText("admin@example.com");
  await expect(tokenRow(page, "ci-export")).toContainText("No one (company)");
  await expect(tokenRow(page, "release script")).toContainText("Revoked");

  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Run" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Run · baseline to prd");
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: "All" }).click();
  await page.getByLabel("Member").selectOption({ label: "approver@example.com" });
  await expect(rows).toHaveCount(1);
  await expect(page).toHaveURL(/member=/);
  await page.getByLabel("Member").selectOption({ label: "Everyone" });
  await expect(rows).toHaveCount(8);

  await page.getByRole("button", { name: "Revoke agent-track" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke this token?" });
  await expect(dialog).toContainText("agent-track · admin@example.com");
  await expect(dialog).toContainText("spend approvals and checkpoint decisions stand");
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(tokenRow(page, "agent-track").getByTestId("acted")).toContainText("Revoked");
  await expect(tokenRow(page, "agent-track")).toContainText(/Revoked \w+ \d+/);
  await page.reload();
  await expect(tokenRow(page, "agent-track")).toContainText("Revoked");
  await expect(page.getByRole("button", { name: "Revoke agent-track" })).toHaveCount(0);
});

test("api tokens: owners only", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/settings/api-tokens");
  await expect(page.getByTestId("role-note")).toContainText("Only owners");
  await expect(page.getByTestId("token-row")).toHaveCount(0);
});

test("my account: from the user menu; a personal token's secret is shown once", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("link", { name: "My account" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
  const details = page.getByRole("complementary", { name: "My account" });
  await expect(details).toContainText("viewer@example.com");
  await expect(details).toContainText("Viewer");
  await expect(details).toContainText("Password");

  await page.getByLabel("Name").fill("laptop script");
  await page.getByRole("button", { name: "Create token" }).click();
  const secret = page.getByTestId("new-token-secret");
  await expect(secret).toHaveText(/^po_/);
  await expect(page.getByTestId("new-token")).toContainText("Shown once");
  await expect(page.getByTestId("my-token-row").filter({ hasText: "laptop script" })).toContainText("oracle:read");
  const value = await secret.textContent();

  // Gone once dismissed, and never shown again after a reload.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("new-token")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("my-token-row").filter({ hasText: "laptop script" })).toBeVisible();
  await expect(page.getByText(value!)).toHaveCount(0);

  await page.getByRole("button", { name: "Revoke laptop script" }).click();
  await page.getByRole("dialog", { name: "Revoke this token?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("my-token-row").filter({ hasText: "laptop script" })).toContainText("Revoked");
});

test("my account: revoke an MCP client", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const row = page.getByTestId("my-client-row").filter({ hasText: "Claude Desktop" });
  await expect(row).toContainText("Active");
  await expect(page.getByTestId("my-client-row").filter({ hasText: "Old notebook agent" })).toContainText("Revoked");
  await page.getByRole("button", { name: "Revoke Claude Desktop" }).click();
  await page.getByRole("dialog", { name: "Revoke this MCP client?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");
});

test("my account: change password", async ({ page }) => {
  // Built at runtime: no password-shaped literal in the source.
  const wrong = Array(4).fill("wrong").join(" ");
  const fresh = Array(4).fill("longer").join(" ");
  await login(page, "approver@example.com");
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Change password" });
  await form.getByLabel("Current password").fill(wrong);
  await form.getByLabel(/^New password ·/).fill(fresh);
  await form.getByLabel("New password again").fill(fresh);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("alert")).toContainText("not correct");

  await form.getByLabel("Current password").fill(ADMIN.password);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form.getByRole("status")).toContainText("Password changed");

  await signOut(page);
  await page.getByLabel("Email").fill("approver@example.com");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(fresh);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
});

test("my account: sign out everywhere ends the session and every MCP client", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  await page.getByTestId("sign-out-everywhere").click();
  const dialog = page.getByRole("dialog", { name: "Sign out of every device?" });
  await expect(dialog).toContainText("this one too");
  await expect(dialog).toContainText("Your MCP client loses");
  await expect(dialog).toContainText("personal API tokens keep working");
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);

  await login(page);
  await page.goto("/account");
  await expect(page.getByTestId("my-client-row").filter({ hasText: "Claude Desktop" })).toContainText("Revoked");
  await expect(page.getByTestId("my-token-row").filter({ hasText: "agent-track" })).toContainText("Active");
});

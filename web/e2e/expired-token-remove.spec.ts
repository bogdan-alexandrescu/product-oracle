import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * qa4-settings-39: Settings › API tokens removes an expired API token, after the app's own
 * confirm dialog; an active or revoked one offers no Remove. Desktop and phone, on the mock.
 */

const tokenRow = (page: Page, name: string) => page.getByTestId("token-row").filter({ hasText: name });

for (const [where, viewport] of [
  ["desktop", { width: 1366, height: 820 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(where, () => {
    test.use({ viewport });

    test(`qa4-settings-39: an owner removes an expired token (${where})`, async ({ page }) => {
      // A browser confirm would fail the test: the app asks with its own dialog.
      page.on("dialog", (d) => {
        throw new Error(`Browser dialog: ${d.message()}`);
      });
      await login(page);
      await page.goto("/settings/api-tokens");
      await expect(page.getByRole("heading", { level: 1, name: "API tokens" })).toBeVisible();

      const expired = tokenRow(page, "staging sync");
      await expect(expired).toContainText("Expired");
      await expect(page.getByTestId("expired-count")).toHaveText("1 expired");
      // Only an expired token has Remove; an active one has Revoke, a revoked one neither.
      await expect(page.getByRole("button", { name: "Revoke staging sync" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Remove laptop cli" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Revoke laptop cli" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove release script" })).toHaveCount(0);

      // Cancel keeps it.
      await page.getByRole("button", { name: "Remove staging sync" }).click();
      const dialog = page.getByRole("dialog", { name: "Remove this expired token?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("staging sync · admin@example.com");
      await expect(dialog).toContainText("It stopped working Sep 29, 2026");
      await expect(dialog).toContainText("Approvals and decisions made with it keep its name.");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(expired).toBeVisible();

      await page.getByRole("button", { name: "Remove staging sync" }).click();
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(expired).toContainText("Removed");
      await expect(expired).toHaveCount(0);
      await expect(page.getByTestId("expired-count")).toHaveCount(0);
      await expect(tokenRow(page, "laptop cli")).toBeVisible();

      // Gone for good: after a reload, and from its member's My account.
      await page.reload();
      await expect(tokenRow(page, "agent-track")).toBeVisible();
      await expect(tokenRow(page, "staging sync")).toHaveCount(0);
      await page.goto("/account");
      await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
      await expect(page.getByText("agent-track").first()).toBeVisible();
      await expect(page.getByText("staging sync")).toHaveCount(0);
    });
  });
}

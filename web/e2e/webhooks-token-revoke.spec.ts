import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * I1 (owner decision 2026-10-26): revoking a user-less API token on Settings › API tokens
 * pauses the webhooks it created, as a disabled member's pause; Settings › Webhooks says why
 * in words, and every owner's Inbox gets a row naming the webhook, with Resume and Take over.
 * The "webhooks-token" scenario seeds one active webhook the service token ci-export made.
 */
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openSettings(page: Page, tab: "nav-webhooks" | "nav-api-tokens") {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId(tab).click();
}

test("webhooks: revoking the API token that made a webhook pauses it, says why, and asks every owner in the Inbox", async ({ page }) => {
  await scenario(page, "webhooks-token");
  await login(page);
  await openSettings(page, "nav-webhooks");
  const row = page.getByTestId("webhook-row").filter({ hasText: "CI export hook" });
  await expect(row).toContainText("ci-export");
  await expect(row).toContainText("Active");

  await openSettings(page, "nav-api-tokens");
  await page.getByRole("button", { name: "Revoke ci-export" }).click();
  await page.getByRole("dialog", { name: "Revoke this token?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("token-row").filter({ hasText: "ci-export" })).toContainText("Revoked");

  await openSettings(page, "nav-webhooks");
  await expect(row).toContainText("Paused: API token revoked");
  await row.click();
  await expect(page.getByTestId("webhook-inspector")).toContainText("Paused: API token revoked");

  await page.goto("/inbox");
  const inbox = page.getByTestId("inbox-webhooks").getByRole("row").filter({ hasText: "Webhook CI export hook paused: its API token was revoked" });
  await expect(inbox).toHaveCount(1);
  await expect(inbox.getByRole("button", { name: "Take over" })).toBeVisible();
  await inbox.getByRole("button", { name: "Resume" }).click();
  await expect(inbox).toHaveCount(0);

  await openSettings(page, "nav-webhooks");
  await expect(row).toContainText("Active");
});

test("webhooks: Take over in the Inbox makes the revoked token's webhook the owner's", async ({ page }) => {
  await scenario(page, "webhooks-token");
  await login(page);
  await openSettings(page, "nav-api-tokens");
  await page.getByRole("button", { name: "Revoke ci-export" }).click();
  await page.getByRole("dialog", { name: "Revoke this token?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("token-row").filter({ hasText: "ci-export" })).toContainText("Revoked");

  await page.goto("/inbox");
  const inbox = page.getByTestId("inbox-webhooks").getByRole("row").filter({ hasText: "Webhook CI export hook paused: its API token was revoked" });
  await inbox.getByRole("button", { name: "Take over" }).click();
  await expect(inbox).toHaveCount(0);

  await openSettings(page, "nav-webhooks");
  const row = page.getByTestId("webhook-row").filter({ hasText: "CI export hook" });
  await expect(row).toContainText("Admin");
  await expect(row).toContainText("Paused");
});

import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA fixes on Settings › API tokens (qa-settings-35 to -37), driven through the UI on the mock
 * layer: the page says where each kind of token is made, a revoked token shows no expiry,
 * scopes read in one style, and a role turned away is pointed at its own tokens.
 */

const tokenRow = (page: Page, name: string) => page.getByTestId("token-row").filter({ hasText: name });

async function openTokens(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-api-tokens").click();
  await expect(page).toHaveURL(/\/settings\/api-tokens$/);
  await expect(page.getByRole("heading", { level: 1, name: "API tokens" })).toBeVisible();
}

test("qa-settings-35: the page says where each kind of token is made, with a link to My account", async ({ page }) => {
  await openTokens(page);
  const where = page.getByTestId("tokens-made-where");
  await expect(where).toContainText("Personal: each member makes their own on My account › Personal API tokens");
  await expect(where).toContainText("Run: Oracle makes one for each run's agents");
  await expect(where).toContainText("MCP client:");
  await expect(where).toContainText("Service: Oracle has no way to make one");
  await where.getByRole("link", { name: "My account › Personal API tokens" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
});

test("qa-settings-36: a revoked token shows no expiry, and a service token's role is a chip", async ({ page }) => {
  await openTokens(page);
  const revoked = tokenRow(page, "release script");
  await expect(revoked).toContainText("Revoked");
  await expect(revoked.getByTestId("token-expiry")).toHaveText("—");
  // Not revoked: the expiry still shows.
  await expect(tokenRow(page, "laptop cli").getByTestId("token-expiry")).toHaveText(/^Expires /);

  const service = tokenRow(page, "ci-export");
  await expect(service.getByTestId("token-scopes")).toHaveText("Viewer role");
  await expect(service.getByTestId("token-scopes").locator("[data-kind]")).toHaveCount(1);
  await expect(service).not.toContainText("acts as viewer");
});

for (const who of ["viewer@example.com", "commenter@example.com"]) {
  test(`qa-settings-37: a ${who.split("@")[0]} reaching API tokens is sent to their own tokens`, async ({ page }) => {
    await login(page, who);
    await page.goto("/settings/api-tokens");
    const gate = page.getByTestId("not-for-role");
    await expect(gate).toContainText("Not available for your role");
    await expect(gate).toContainText("Your own API tokens are on My account.");
    await expect(gate.getByRole("link", { name: "Open Settings" })).toHaveCount(0);
    await gate.getByRole("link", { name: "Open My account" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
  });
}

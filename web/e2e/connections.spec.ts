import { expect, test, type Page } from "./test";

import { login } from "./helpers";

async function openConnections(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-connections").click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

test("connections: a card per data provider, and Claude is not one of them", async ({ page }) => {
  await openConnections(page);
  for (const key of ["github", "slack", "notion", "fireflies", "google"]) {
    await expect(page.getByTestId(`connection-card-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId("connection-card-claude")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Claude accounts" }).first()).toBeVisible();

  // OAuth only where a client is configured (GitHub and Google in mock mode).
  await expect(page.getByTestId("connection-card-github").getByRole("button", { name: "Connect with GitHub" })).toBeVisible();
  await expect(page.getByTestId("connection-card-slack").getByRole("button", { name: /^Connect with/ })).toHaveCount(0);
  await expect(page.getByTestId("connection-card-slack")).toContainText("never direct messages");
});

test("connections: paste a token, reconnect, and sign in with OAuth", async ({ page }) => {
  await openConnections(page);
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("bad-token");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByRole("alert")).toContainText("Slack rejected the token");

  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByLabel("Label (optional)").fill("Team Slack");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack).toContainText("Team Slack");
  await slack.getByRole("button", { name: "Reconnect" }).click();
  await expect(slack.getByText("Connected")).toBeVisible();

  await page.getByTestId("connection-card-github").getByRole("button", { name: "Connect with GitHub" }).click();
  await expect(page).toHaveURL(/connected=github/);
  await expect(page.getByRole("status")).toContainText("GitHub is connected.");
  const github = page.getByTestId("connection-card-github");
  await expect(github).toContainText("example-user");
  await expect(github).toContainText("signed in");
  await expect(github).toContainText("Scopes: read:user, repo");
});

test("connections: an OAuth error from the callback is shown", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections?provider=google&error=access_denied");
  await expect(page.getByRole("alert").first()).toContainText("Google Docs: access_denied");
});

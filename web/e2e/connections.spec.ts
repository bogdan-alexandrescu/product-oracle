import { expect, test, type Page } from "@playwright/test";

import { PLAN_PREFIX } from "../lib/api/mock/connections";

import { login } from "./helpers";

async function openConnections(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-connections").click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
}

test("connections: a card per provider, Claude plan explains setup-token", async ({ page }) => {
  await openConnections(page);
  for (const key of ["claude", "github", "slack", "notion", "fireflies", "google"]) {
    await expect(page.getByTestId(`connection-card-${key}`)).toBeVisible();
  }
  const claude = page.getByTestId("connection-card-claude");
  await expect(claude).toContainText("claude setup-token");
  await expect(page.getByTestId("claude-plan-status")).toContainText("No Claude plan");

  // OAuth only where a client is configured (GitHub and Google in mock mode).
  await expect(page.getByTestId("connection-card-github").getByRole("button", { name: "Connect with GitHub" })).toBeVisible();
  await expect(page.getByTestId("connection-card-slack").getByRole("button", { name: /^Connect with/ })).toHaveCount(0);
  await expect(page.getByTestId("connection-card-slack")).toContainText("never direct messages");
});

test("connections: paste a Claude plan token, make it the company default, disconnect", async ({ page }) => {
  await openConnections(page);
  const claude = page.getByTestId("connection-card-claude");

  // A token that is not a Claude credential is refused with the reason.
  await claude.getByLabel("Token from claude setup-token").fill("not-a-claude-token");
  await claude.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(claude.getByRole("alert")).toContainText("Not a Claude credential");

  await claude.getByLabel("Token from claude setup-token").fill(`${PLAN_PREFIX}01-example-abcd`);
  await claude.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(claude).toContainText("Claude plan (setup-token …abcd)");
  await expect(claude.getByText("Connected")).toBeVisible();
  await expect(page.getByTestId("claude-plan-status")).toContainText("run on your own plan");
  // The token itself is never shown back.
  await expect(page.locator("body")).not.toContainText(`${PLAN_PREFIX}01-example`);

  // Owners can offer their plan to users without their own.
  const makeDefault = claude.getByLabel("Use as the default plan for users without their own");
  await expect(makeDefault).not.toBeChecked();
  await makeDefault.check();
  await expect(makeDefault).toBeChecked();
  // Disabled while saving; enabled again once the setting is stored.
  await expect(makeDefault).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("connection-card-claude").getByLabel("Use as the default plan for users without their own")).toBeChecked();

  await page.getByTestId("connection-card-claude").getByRole("button", { name: "Disconnect" }).click();
  await page.getByTestId("connection-card-claude").getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByTestId("connection-card-claude")).toContainText("Not connected.");
  await expect(page.getByTestId("claude-plan-status")).toContainText("No Claude plan");
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

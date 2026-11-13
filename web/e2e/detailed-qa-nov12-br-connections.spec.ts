import { expect, test } from "./test";

import { disconnectAll, login } from "./helpers";

/**
 * Visual QA, Nov 12 (detailed-b #9), on the default mock company (invented data only).
 *
 * protects = GitHub and Google Docs each have one entry, as Slack and Notion do: "Connect" with no
 * account, "Add another account" with some, opening a choice of signing in or pasting a token; the
 * entry hides while the choice or the token form is open; fails_when = "Connect with GitHub" or
 * "Connect with Google Docs" shows, or the entry stays beside the open form.
 */

test.use({ viewport: { width: 1440, height: 900 } });

test("#9: GitHub's one entry opens a choice of signing in or a token", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections");
  const github = page.getByTestId("connection-card-github");
  await expect(github.getByRole("button", { name: /^Connect with/ })).toHaveCount(0);
  await disconnectAll(page, "github");
  await expect(github.getByRole("button", { name: /^Connect with/ })).toHaveCount(0);
  await expect(github.getByRole("button", { name: "Paste a token" })).toHaveCount(0);

  // A token: the choice, then the form, with no entry beside it.
  await github.getByRole("button", { name: "Connect", exact: true }).click();
  const choice = github.getByRole("group", { name: "Add a GitHub account" });
  await expect(choice.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
  await choice.getByRole("button", { name: "Paste a token" }).click();
  await expect(github.getByLabel("Token", { exact: true })).toBeVisible();
  await expect(github.getByRole("button", { name: "Sign in with GitHub" })).toHaveCount(0);
  await expect(github.getByRole("button", { name: "Connect", exact: true })).toHaveCount(1);
  await github.getByRole("button", { name: "Cancel" }).click();
  await expect(github.getByLabel("Token", { exact: true })).toHaveCount(0);

  // Signing in from the choice connects the account; the entry then adds another.
  await github.getByRole("button", { name: "Connect", exact: true }).click();
  await github.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/connected=github/);
  await expect(github).toContainText("Connected by signing in");
  await expect(github.getByRole("button", { name: /^Connect/ })).toHaveCount(0);
  await expect(github.getByRole("button", { name: "Add another account" })).toBeVisible();
});

test("#9: Google Docs' Add another account opens the same choice, and Cancel closes it", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections");
  const google = page.getByTestId("connection-card-google");
  await expect(google.getByRole("button", { name: /^Connect with/ })).toHaveCount(0);
  await google.getByRole("button", { name: "Add another account" }).click();
  const choice = google.getByRole("group", { name: "Add a Google Docs account" });
  await expect(choice.getByRole("button", { name: "Sign in with Google Docs" })).toBeVisible();
  await expect(choice.getByRole("button", { name: "Paste a token" })).toBeVisible();
  await expect(google.getByRole("button", { name: "Add another account" })).toHaveCount(0);
  await choice.getByRole("button", { name: "Cancel" }).click();
  await expect(choice).toHaveCount(0);
  await expect(google.getByRole("button", { name: "Add another account" })).toBeVisible();
});

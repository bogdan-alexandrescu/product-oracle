import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * Pass F F-60 (owner, Nov 5): the Sources page and the Connections page read one list of
 * connections, as the API does. What one page connects or disconnects shows on the other.
 */

async function sourceAccounts(page: Page, kind: string): Promise<string[]> {
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption({ label: kind });
  const connection = form.getByLabel("Connection");
  await expect(connection).toBeVisible();
  return connection.locator("option").allTextContents();
}

test("F-60: Connections lists the Slack, Fireflies and Google accounts the Sources page offers", async ({ page }) => {
  // fails_when=the Connections page shows Slack, Fireflies or Google as not connected while Sources offers them.
  await login(page);
  expect(await sourceAccounts(page, "Slack")).toEqual(["Example Co chat", "Partner workspace"]);
  await page.goto("/settings/connections");
  const slack = page.getByTestId("connection-card-slack");
  await expect(slack.getByRole("listitem")).toHaveText([/Example Co chat/, /Partner workspace/]);
  await expect(page.getByTestId("connection-card-fireflies").getByRole("listitem")).toHaveText([/pat@example\.com/]);
  const google = page.getByTestId("connection-card-google");
  await expect(google.getByRole("listitem")).toHaveText([/pat@example\.com/, /old-drive@example\.com/]);
  await expect(google.getByRole("button", { name: "Reconnect to choose files" })).toHaveCount(1);
});

test("F-60: connect Slack on Connections, see it on Sources", async ({ page }) => {
  // fails_when=the new Slack account is not on Connections beside the two Sources offers, or not on Sources.
  await login(page);
  await page.goto("/settings/connections");
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-5678");
  await slack.getByLabel("Label (optional)").fill("Design team chat");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByRole("listitem")).toHaveText([/Example Co chat/, /Partner workspace/, /Design team chat/]);
  expect(await sourceAccounts(page, "Slack")).toEqual(["Example Co chat", "Partner workspace", "Design team chat"]);
});

test("F-60: disconnect on Connections, gone from Sources", async ({ page }) => {
  // fails_when=a Slack or Google account disconnected on Connections is still offered on Sources.
  await login(page);
  await page.goto("/settings/connections");
  const partner = page.getByTestId("connection-card-slack").getByRole("listitem").filter({ hasText: "Partner workspace" });
  await partner.getByRole("button", { name: "Disconnect" }).click();
  await partner.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByTestId("connection-card-slack").getByRole("listitem")).toHaveText([/Example Co chat/]);
  const old = page.getByTestId("connection-card-google").getByRole("listitem").filter({ hasText: "old-drive@example.com" });
  await old.getByRole("button", { name: "Disconnect" }).click();
  await old.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(page.getByTestId("connection-card-google").getByRole("listitem")).toHaveText([/pat@example\.com/]);

  expect(await sourceAccounts(page, "Slack")).toEqual(["Example Co chat"]);
  expect(await sourceAccounts(page, "Google Docs")).toEqual(["pat@example.com"]);
});

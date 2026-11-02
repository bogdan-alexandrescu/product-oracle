import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * trainag-mock-fixes review: a connection is the person's own, as the API's Connection.user_id
 * (list_for_user, get_own): one member's Slack is not another's, and another member who
 * connects and disconnects the same Slack account leaves the first one's connection alone.
 */

async function slackCard(page: Page, email: string) {
  await login(page, email);
  await page.goto("/settings/connections");
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  return page.getByTestId("connection-card-slack");
}

test("connections: each person's own; disconnecting yours leaves another's", async ({ page }) => {
  let slack = await slackCard(page, "admin@example.com");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByLabel("Label (optional)").fill("Avery's Slack");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack).toContainText("Avery's Slack");
  await signOut(page);

  slack = await slackCard(page, "approver@example.com");
  await expect(slack).toContainText("Not connected");
  await expect(slack).not.toContainText("Avery's Slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-5678");
  await slack.getByLabel("Label (optional)").fill("Priya's Slack");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack).toContainText("Priya's Slack");
  await slack.getByRole("button", { name: "Disconnect" }).click();
  await slack.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(slack).toContainText("Not connected");
  await signOut(page);

  slack = await slackCard(page, "admin@example.com");
  await expect(slack).toContainText("Avery's Slack");
  await expect(slack).not.toContainText("Priya's Slack");
});

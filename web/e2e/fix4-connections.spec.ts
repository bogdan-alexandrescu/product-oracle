import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA fixes on Settings › Connections (qa-settings-21, -22), driven through the UI on the mock
 * layer: the Slack card reads the same Slack status the Notifications page reads.
 */

async function openSettings(page: Page, nav: "connections" | "notifications") {
  const from = page.url();
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  // Next keeps the Settings page just left mounted, hidden: a tab is picked once the rail's
  // Settings has landed, never from the strip of the page going away.
  await expect(page).not.toHaveURL(from);
  await page.getByRole("navigation", { name: "Settings" }).filter({ visible: true }).getByTestId(`nav-${nav}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${nav}`));
}

const companySlack = (page: Page) =>
  page.getByTestId("connection-card-slack").filter({ visible: true }).getByTestId("company-slack");

test("qa-settings-21: Connections and Notifications agree on whether Oracle's Slack app is connected", async ({ page }) => {
  await login(page);
  await openSettings(page, "connections");
  await expect(companySlack(page)).toContainText("Oracle's Slack app");
  await expect(companySlack(page)).toContainText("Not installed");
  await expect(companySlack(page).getByRole("link", { name: "Notifications" })).toBeVisible();

  await openSettings(page, "notifications");
  const card = page.getByTestId("slack-notifications");
  await card.getByRole("button", { name: "Connect Oracle to Slack" }).click();
  await expect(page.getByText("Slack is connected for notifications.")).toBeVisible();
  await expect(card.getByTestId("slack-connected")).toHaveText("Connected to Example Co as @Product Oracle");

  await openSettings(page, "connections");
  await expect(companySlack(page)).toContainText("Installed for notifications");
  await expect(companySlack(page)).toContainText("Example Co");
  await expect(companySlack(page)).not.toContainText("Not installed");
  // Its words never say "connected", so the person's own connection's chip stays the only one.
  await expect(companySlack(page)).not.toContainText(/connected/i);
  // The person's own Slack is a separate thing, and says so.
  await expect(companySlack(page)).toContainText("Your own Slack account, below");
  await expect(page.getByTestId("connection-card-slack").filter({ visible: true })).toContainText("Not connected");
});

test("qa-settings-22: Paste a token is a secondary button, not plain text", async ({ page }) => {
  await login(page);
  await openSettings(page, "connections");
  const paste = page.getByTestId("connection-card-slack").getByRole("button", { name: "Paste a token" });
  await expect(paste).toHaveAttribute("data-variant", "secondary");
});

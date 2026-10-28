import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/** #242 (A5): an invite reaches the person, and the Members page says what happened. */

const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function invite(page: Page, email: string, role = "approver") {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
}

test("invite: Oracle emails the invite and grants access, and the page says so", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await invite(page, "pat@example.com");

  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to pat@example.com");
  const row = inviteRow(page, "pat@example.com");
  await expect(row.getByTestId("invite-access")).toHaveText(/^Access granted \w{3} \d{1,2}$/);
  await expect(row.getByTestId("invite-email")).toContainText("Sent");
  // The Copy link button says what it does.
  await expect(row.getByRole("button", { name: "Copy link for pat@example.com" })).toHaveText("Copy link");
  await page.reload();
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-email")).toContainText("Sent");
});

test("invite: with no sender, the page gives the link to send and copies it", async ({ page }) => {
  await scenario(page, "mail-off");
  await login(page);
  await page.goto("/settings/members");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await invite(page, "pat@example.com");

  const outcome = page.getByTestId("invite-outcome");
  await expect(outcome).toContainText("Oracle didn't email this invite. Send them this link:");
  const origin = new URL(page.url()).origin;
  await expect(outcome.getByTestId("invite-link")).toHaveText(`${origin}/`);
  await outcome.getByRole("button", { name: "Copy sign-in link" }).click();
  await expect(outcome.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/`);
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-email")).toHaveText("Not sent");
});

test("invite: access not granted yet, and Retry grants it", async ({ page }) => {
  await scenario(page, "iap-pending");
  await login(page);
  await page.goto("/settings/members");
  await invite(page, "pat@example.com");

  const row = inviteRow(page, "pat@example.com");
  await expect(row.getByTestId("invite-access")).toHaveText("Access not granted yet");
  await row.getByRole("button", { name: "Retry access for pat@example.com" }).click();
  await expect(row.getByTestId("invite-access")).toHaveText(/^Access granted \w{3} \d{1,2}$/);
  await expect(row.getByRole("button", { name: "Retry access for pat@example.com" })).toHaveCount(0);
  await page.reload();
  await expect(inviteRow(page, "pat@example.com").getByTestId("invite-access")).toHaveText(/^Access granted \w{3} \d{1,2}$/);
});

test("invite: a failed email offers Resend, which sends it", async ({ page }) => {
  await scenario(page, "mail-fails");
  await login(page);
  await page.goto("/settings/members");
  await invite(page, "pat@example.com");

  await expect(page.getByTestId("invite-outcome")).toContainText("Oracle didn't email this invite. Send them this link:");
  const row = inviteRow(page, "pat@example.com");
  await expect(row.getByTestId("invite-email")).toHaveText("Failed");
  await row.getByRole("button", { name: "Resend invitation to pat@example.com" }).click();
  await expect(row.getByTestId("invite-email")).toContainText("Sent");
});

test("invite: an address outside the company's domains is refused under the field", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await invite(page, "pat@example.org");

  const form = page.getByRole("form", { name: "Invite" });
  await expect(form.getByRole("alert")).toContainText("pat@example.org is outside the company's email domains (example.com)");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  await expect(inviteRow(page, "pat@example.org")).toHaveCount(0);
  await expect(page.getByTestId("invite-outcome")).toHaveCount(0);
});

test("remove: Google access not removed yet shows on the member until it is", async ({ page }) => {
  await scenario(page, "iap-revoke-fails");
  await login(page);
  await page.goto("/settings/members");
  const row = page.getByTestId("member-row").filter({ hasText: "commenter@example.com" });
  await expect(row.getByTestId("member-access")).toHaveCount(0);

  await page.getByRole("button", { name: "Remove commenter@example.com" }).click();
  await page.getByRole("dialog", { name: "Remove Commenter?" }).getByRole("button", { name: "Remove member" }).click();
  await expect(row).toHaveAttribute("data-status", "disabled");
  await expect(row.getByTestId("member-access")).toHaveText("Access not removed yet");
  await page.reload();
  await expect(row.getByTestId("member-access")).toHaveText("Access not removed yet");

  // Restored: they need the access again, so nothing is owed on it.
  await row.getByRole("button", { name: "Restore commenter@example.com" }).click();
  await expect(row).toHaveAttribute("data-status", "active");
  await expect(row.getByTestId("member-access")).toHaveCount(0);
});

test("resend: a sent invite email waits a minute before it is sent again", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await invite(page, "pat@example.com");
  const row = inviteRow(page, "pat@example.com");
  await expect(row.getByTestId("invite-email")).toContainText("Sent");
  await row.getByRole("button", { name: "Resend invitation to pat@example.com" }).click();
  await expect(page.getByText(/resend it in \d+ seconds/)).toBeVisible();
  await expect(row.getByTestId("invite-email")).toContainText("Sent");
});

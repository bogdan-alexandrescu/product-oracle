import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/** #330: an invite's row says when access was last tried and why, and a plus address is warned of. */

const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

/** "Oct 22, 9:05 AM PDT": the company's time zone (the mock company's is America/Los_Angeles). */
const pacific = (at: Date) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" })
    .format(at)
    .replace(/ at /, ", ");

const PLUS_REASON = "oracle-api-be: Google returned 400 (bad request): User pat+tag@example.com does not exist.";

test("invite: a plus address is warned of, and can still be sent", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await page.getByLabel("Email").fill("pat+tag@example.com");
  await expect(form.getByTestId("plus-address-warning")).toHaveText(
    "Google sign-in treats this as pat@example.com; IAP access can't be granted to it.",
  );
  await page.getByLabel("Email").fill("pat@example.com");
  await expect(form.getByTestId("plus-address-warning")).toHaveCount(0);

  await page.getByLabel("Email").fill("pat+tag@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(inviteRow(page, "pat+tag@example.com")).toBeVisible();
  await expect(form.getByTestId("plus-address-warning")).toHaveCount(0);
});

test("invite: the row says when access was last tried and Google's reason; Retry updates them in place", async ({ page }) => {
  await scenario(page, "iap-pending");
  await login(page);
  const first = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60 * 60_000);
  const second = new Date(first.getTime() + 15 * 60_000);
  await page.clock.setFixedTime(first);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("pat+tag@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();

  const row = inviteRow(page, "pat+tag@example.com");
  await expect(row.getByTestId("invite-access")).toHaveText("Access not granted yet");
  const access = row.getByTestId("invite-access-detail");
  // As text, not only on hover.
  await expect(access).toHaveText(`Last tried ${pacific(first)} · ${PLUS_REASON}`);
  await expect(access).toBeVisible();

  await page.clock.setFixedTime(second);
  const retry = row.getByRole("button", { name: "Retry access for pat+tag@example.com" });
  await retry.click();
  await expect(retry).toHaveText("Retrying…");
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText("Retry");
  await expect(access).toHaveText(`Last tried ${pacific(second)} · ${PLUS_REASON}`);
  await expect(row.getByTestId("invite-access")).toHaveText("Access not granted yet");

  // The email went: its chip says so, and the row's one status line speaks only of the access.
  await expect(row.getByTestId("invite-email")).toContainText("Sent");
  await expect(row.getByTestId("invite-email-detail")).toHaveCount(0);
  await expect(row.getByTestId("invite-detail")).toHaveCount(1);
});

test("invite: Retry that grants access says so with the time", async ({ page }) => {
  await scenario(page, "iap-pending");
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("pat@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();

  const row = inviteRow(page, "pat@example.com");
  const access = row.getByTestId("invite-access-detail");
  await expect(access).toContainText("oracle-api-be: Google returned 403 (permission denied)");
  await row.getByRole("button", { name: "Retry access for pat@example.com" }).click();
  await expect(row.getByTestId("invite-access")).toHaveText("Access granted");
  // Granted: nothing is left to say on the status line; the chip's title has the time.
  await expect(access).toHaveCount(0);
  await expect(row.getByTestId("invite-access")).toHaveAttribute("title", /^Access granted \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M P[DS]T$/);
});

test("invite: a failed email's reason is text on the row", async ({ page }) => {
  await scenario(page, "mail-fails");
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("pat@example.com");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();

  const row = inviteRow(page, "pat@example.com");
  await expect(row.getByTestId("invite-email")).toHaveText("Failed");
  await expect(row.getByTestId("invite-email-detail")).toHaveText(/^Last tried .+ · the Gmail API answered 503$/);
});

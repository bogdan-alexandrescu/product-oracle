import { expect, test, type Page } from "./test";

import { MOCK_CONSENT } from "../app/oauth/consent/mock";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 4 fixes on My account, Settings › Autonomy, the MCP consent screen and /access,
 * on the mock layer, driven through the UI as a person would.
 */

const asRole = (page: Page, role: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_ROLE_KEY, role]);
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);
const autonomyRow = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) =>
  autonomyRow(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

async function openAutonomy(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
}

test("qa4-settings-19: for an owner, the Slack pings note links to Settings › Notifications", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const note = page.getByTestId("slack-pings").getByTestId("slack-pings-off");
  const link = note.getByRole("link", { name: "Settings › Notifications" });
  await expect(link).toHaveAttribute("href", "/settings/notifications");
  await link.click();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
});

test("qa4-settings-38: a viewer is told what Write allows a personal token", async ({ page }) => {
  await asRole(page, "viewer");
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByTestId("write-scope-note")).toHaveText(
    "Your role can't comment on or change documents, so Write only lets a token post in discussions and change your own settings.",
  );
});

test("qa4-settings-38: an owner sees no Write note on the token form", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const form = page.getByRole("form", { name: "Create a token" });
  await expect(form.getByRole("button", { name: "Create token" })).toBeVisible();
  await expect(form.getByTestId("write-scope-note")).toHaveCount(0);
});

test("qa4-settings-39: an expired personal token says Expired once", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const expired = page.getByTestId("my-token-row").filter({ hasText: "staging sync" });
  await expect(expired.locator('[data-state="expired"]')).toHaveText("Expired");
  await expect(expired.getByTestId("token-expiry")).toHaveText("Sep 29, 2026");
  await expect(expired.getByText(/Expired/)).toHaveCount(1);
});

test("qa4-settings-40: the consent screen names the client in its title and as the return place", async ({ page }) => {
  await login(page);
  await page.goto("/oauth/consent?request=mock-handle");
  await expect(page.getByRole("heading", { name: `Let ${MOCK_CONSENT.client_name} use Product Oracle?` })).toBeVisible();
  await expect(page.getByRole("heading", { name: /MCP client/ })).toHaveCount(0);
  await expect(page.getByTestId("consent-return")).toHaveText(`${MOCK_CONSENT.client_name} on this computer`);
});

test("qa4-settings-44: Lowest confidence is a percent and a value out of range can't be saved", async ({ page }) => {
  await openAutonomy(page);
  await step(page, "requests", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Triage requests" });
  const field = sheet.getByLabel("Lowest confidence (%)");
  const save = sheet.getByRole("button", { name: "Save" });
  await sheet.getByLabel("Why").fill("Duplicates pile up faster than we can merge them");
  await field.fill("0.9");
  await expect(sheet.getByTestId("autonomy-limit-error")).toHaveText("Enter a number from 80 to 100 %.");
  await expect(save).toBeDisabled();
  await field.fill("150");
  await expect(save).toBeDisabled();
  await field.fill("95");
  await expect(sheet.getByTestId("autonomy-limit-error")).toHaveCount(0);
  await save.click();
  await expect(sheet).toBeHidden();
  await expect(autonomyRow(page, "requests").getByTestId("autonomy-limits")).toHaveText("at 95% confidence or more");
});

test("qa4-settings-45: a locked step says why in text, and the change sheet marks Why as required", async ({ page }) => {
  await openAutonomy(page);
  const locked = autonomyRow(page, "vision").getByTestId("autonomy-locked");
  await expect(locked).toBeVisible();
  await expect(locked).toHaveText("Recommend and Act stay with people: the vision itself.");
  await expect(step(page, "vision", "Act")).toHaveAccessibleDescription("Recommend and Act stay with people: the vision itself.");

  await step(page, "priorities", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  const why = sheet.getByLabel("Why (required)");
  await expect(why).toHaveAttribute("aria-required", "true");
  await expect(sheet.getByTestId("autonomy-why-hint")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
  await why.fill("Small moves are fine");
  await expect(sheet.getByTestId("autonomy-why-hint")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("qa4-settings-46: while waiting, Send note stays off until there is a note", async ({ page }) => {
  await scenario(page, "access-pending");
  await page.goto("/access");
  const send = page.getByRole("button", { name: "Send note" });
  await expect(send).toBeDisabled();
  await page.getByLabel("Add a note for the owner (optional)").fill("   ");
  await expect(send).toBeDisabled();
  await page.getByLabel("Add a note for the owner (optional)").fill("I run support for the clinics team.");
  await send.click();
  await expect(page.getByRole("button", { name: "Sent" })).toBeVisible();
});

import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";

/*
 * Fix round 2, the shell: sign-in, /access, the Settings shell and the intake's Start drafting.
 * protects: a withdrawn or expired invite is refused in words at sign-in (qa-onboarding-14,
 *   qa-onboarding-45); /access dates an expired invite in the past (qa-onboarding-34,
 *   qa-settings-44); signed out, Settings sends to sign-in and back (qa-settings-1); the 13
 *   Settings tabs share one row at 1440 and 1366 px (qa-settings-11); on a phone the header
 *   names the Settings page and a select picks it (qa-settings-40, qa-settings-41); Start
 *   drafting says why it waits (qa-onboarding-17).
 * fails_when: sign-in says "Invalid email or password." for a refused invite, /access says an
 *   expired invite expires after today, Settings sits on Loading signed out, a tab drops to a
 *   second row, the phone header says "Settings", or the reason is missing.
 * no_claim: the API's Google sign-in (api/tests), other widths.
 */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function signInAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("sign-in: an invite the owner revoked is refused in words, naming who to ask", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Email").fill("vi.viewer@example.com");
  await page.getByLabel("Role", { exact: true }).selectOption("viewer");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to vi.viewer@example.com");
  await page.getByRole("button", { name: "Revoke invite for vi.viewer@example.com" }).click();
  // The revoke is made at once (Undo would invite again): after a reload the row is gone.
  await expect(page.getByRole("button", { name: "Revoke invite for vi.viewer@example.com" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("invite-row").filter({ hasText: "vi.viewer@example.com" })).toHaveCount(0);
  await signOut(page);

  await signInAs(page, "vi.viewer@example.com");
  const alert = page.getByRole("alert").filter({ hasText: /\S/ });
  await expect(alert).toHaveText("Your invite was withdrawn. Ask Admin to invite you again.");
  await expect(page.getByText("Invalid email or password.")).toHaveCount(0);
  await expect(page).toHaveURL(/\/login/);
});

test("sign-in: an expired invite is refused in words, with its date", async ({ page }) => {
  await signInAs(page, "old.invite@example.com");
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText("Your invite expired on Oct 4. Ask Admin to resend it.");
  await expect(page).toHaveURL(/\/login/);
});

test("sign-in: a wrong password still says so", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("old.invite@example.com");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveText("Invalid email or password.");
});

test("access: an expired invite's date is in the past", async ({ page }) => {
  await scenario(page, "access-expired");
  await page.goto("/login");
  await expect(page).toHaveURL(/\/access$/);
  await expect(page.getByTestId("access-body")).toHaveText("It expired on Oct 19. Ask the person who invited you to resend it.");
});

test("settings signed out: on to sign-in, and back to the page after", async ({ page }) => {
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fmembers$/);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
});

for (const width of [1440, 1366]) {
  test(`settings at ${width} px: every tab on one row`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.goto("/settings/members");
    const links = page.getByTestId("settings-nav").getByRole("link");
    await expect(links).toHaveCount(13);
    await expect(links.last()).toHaveText("Trash");
    const tops = new Set<number>();
    for (const link of await links.all()) tops.add(Math.round((await link.boundingBox())!.y));
    expect([...tops]).toHaveLength(1);
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("settings: the header names the page and a select picks another", async ({ page }) => {
    await login(page);
    await page.goto("/settings/connections");
    await expect(page.getByTestId("phone-title")).toHaveText("Connections");
    await expect(page.getByText(/^\d+ connected$/).first()).toBeVisible();
    const picker = page.getByRole("combobox", { name: "Settings page" });
    await expect(picker.locator("option")).toHaveCount(13);
    await expect(picker.locator("option:checked")).toHaveText("Connections");
    // No cut strip with chevrons on a phone.
    await expect(page.getByTestId("settings-nav").getByTestId("strip-more-right")).toBeHidden();
    await picker.selectOption({ label: "Trash" });
    await expect(page).toHaveURL(/\/settings\/trash$/);
    await expect(page.getByTestId("phone-title")).toHaveText("Trash");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

test("intake: Start drafting says it waits for the estimate", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await page.getByRole("link", { name: "New PRD" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
  await page
    .getByRole("textbox", { name: "What problem does it solve?" })
    .fill("Returning buyers retype their address at every checkout. Saved addresses would make repeat checkout faster.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await expect(sheet.getByRole("button", { name: "Start drafting" })).toBeDisabled();
  await expect(sheet.getByTestId("draft-start-reason")).toHaveText("Estimate the cost first.");
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toBeVisible();
  await expect(sheet.getByTestId("draft-start-reason")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Start drafting" })).toBeEnabled();
});

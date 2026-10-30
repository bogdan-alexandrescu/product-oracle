import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * The fix4 onboarding findings on Settings › Members, walked through on a new company (the
 * mock's "empty" scenario) as its owner would: invite someone, see a refusal, resend, and
 * leave with an invite half written. Mock-backed, through the UI only.
 */

const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
});

test("qa-onboarding-8 / qa-onboarding-38 / qa-onboarding-37 / qa-onboarding-18: a new company's first invites", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await expect(page.getByText("Members · invite")).toHaveCount(0);

  await form.getByLabel("Email").fill("gone@example.com");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to gone@example.com");
  const row = inviteRow(page, "gone@example.com");
  // qa-onboarding-38: not "Access granted" before they accepted.
  await expect(row.getByTestId("invite-access")).toHaveText("Google sign-in ready");

  // qa-onboarding-8: the refusal alone shows.
  await form.getByLabel("Email").fill("outside@gmail.com");
  await form.getByRole("button", { name: "Send invite" }).click();
  await expect(form.getByRole("alert")).toContainText("outside the company's email domains");
  await expect(page.getByTestId("invite-outcome")).toHaveCount(0);
  await expect(page.getByText("Invite sent to gone@example.com")).toHaveCount(0);

  // qa-onboarding-37: a Resend right away says on the row why it waits; a minute on, it goes.
  await form.getByLabel("Email").fill("");
  await row.getByRole("button", { name: "Resend invitation to gone@example.com" }).click();
  await expect(row.getByTestId("invite-resent")).toContainText("under a minute ago");
  await page.clock.fastForward("01:05");
  await row.getByRole("button", { name: "Resend invitation to gone@example.com" }).click();
  await expect(row.getByTestId("invite-resent")).toHaveText("Resent just now");
});

test("qa-onboarding-36: a half-written invite asks before Home drops it", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("pat@example.com");
  await form.getByLabel("Message (optional)").fill("Welcome to Oracle");
  const home = page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-home");
  await home.click();
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings\/members/);
  await expect(form.getByLabel("Email")).toHaveValue("pat@example.com");

  await home.click();
  await page.getByRole("alertdialog", { name: "Discard your changes?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/home$/);

  // Nothing typed: Home goes at once.
  await page.goto("/settings/members");
  await expect(form).toBeVisible();
  await home.click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("alertdialog", { name: "Discard your changes?" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-onboarding-31: Engineering lead boxes are big enough to tap; a member who never signed in says so", async ({ page }) => {
    await login(page);
    await page.goto("/settings/members");
    const commenter = page.getByTestId("member-row").filter({ hasText: "commenter@example.com" });
    const box = await commenter.locator('input[aria-label="Engineering lead: commenter@example.com"]:visible').boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(24);
    expect((await commenter.getByTestId("member-open").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("member-row").filter({ hasText: "viewer@example.com" }).getByTestId("never-signed-in")).toHaveText("Never signed in");
  });
});

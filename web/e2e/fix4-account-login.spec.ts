import { expect, test, type Locator } from "./test";

import { MOCK_CONSENT } from "../app/oauth/consent/mock";
import { ADMIN, login } from "./helpers";

/*
 * Fix round 4: My account, sign-in and the MCP consent screen.
 * protects: /account's password problems each sit under their own field, and the disabled
 *   Change password reads as disabled (a dashed outline), not as an enabled secondary button
 *   (qa-settings-38); on a phone, My account lights the bar's More, as Settings does
 *   (qa-settings-39); /oauth/consent without a client request offers a way to Oracle
 *   (qa-settings-40); the consent card speaks plainly and calls a loopback return address
 *   "an app on this computer", the address only in a title (qa-settings-41); a removed member
 *   with their right password is told an owner removed them and whom to ask, a wrong password
 *   still says only "Invalid email or password." (qa-settings-42).
 * fails_when: the two messages run together beside the button, the disabled button has a solid
 *   outline, no bar tab is lit on /account, the consent error is a dead end, the card shows
 *   127.0.0.1:33418 or the old jargon, or a removed member hears the generic refusal.
 * no_claim: the API's own words for these (api/tests/test_auth.py, api/tests/test_oauth.py);
 *   a Google sign-in button: the API has no Google sign-in route of its own (Google IAP signs
 *   people in in front of the app, and /login then sends them on).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const box = async (l: Locator) => (await l.boundingBox())!;

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-settings-38: each password problem sits under its field; the disabled button reads as disabled", async ({ page }) => {
    await login(page);
    await page.goto("/account");
    const form = page.getByRole("form", { name: "Change password" });
    const fresh = form.getByLabel(/^New password ·/);
    const again = form.getByLabel("New password again");
    const button = form.getByRole("button", { name: "Change password" });
    await form.getByLabel("Current password").fill(ADMIN.password);
    await fresh.fill("short");
    await again.fill("different");

    const short = form.getByTestId("password-short");
    const mismatch = form.getByTestId("password-mismatch");
    await expect(short).toHaveText("At least 12 characters");
    await expect(mismatch).toHaveText("The two new passwords differ");
    await expect(fresh).toHaveAccessibleDescription("At least 12 characters");
    await expect(again).toHaveAccessibleDescription("The two new passwords differ");
    // Each under its own field, left-aligned with it; the button on its own row below.
    for (const [message, field] of [
      [short, fresh],
      [mismatch, again],
    ] as const) {
      const m = await box(message);
      const f = await box(field);
      expect(m.y).toBeGreaterThanOrEqual(f.y + f.height - 1);
      expect(Math.abs(m.x - f.x)).toBeLessThanOrEqual(2);
    }
    const b = await box(button);
    expect(b.y).toBeGreaterThan((await box(short)).y + (await box(short)).height - 1);

    // Disabled: a dashed outline; enabled: none (the accent fill).
    await expect(button).toBeDisabled();
    expect(await button.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    await fresh.fill("a-long-enough-password");
    await again.fill("a-long-enough-password");
    await expect(short).toHaveCount(0);
    await expect(mismatch).toHaveCount(0);
    await expect(button).toBeEnabled();
    expect(await button.evaluate((el) => getComputedStyle(el).borderTopStyle)).not.toBe("dashed");
  });

  test("qa-settings-40: consent without a client request offers Go to Oracle", async ({ page }) => {
    await login(page);
    await page.goto("/oauth/consent");
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Start again from your MCP client");
    const out = page.getByRole("link", { name: "Go to Oracle" });
    await expect(out).toHaveAttribute("href", "/");
    await out.click();
    await expect(page).not.toHaveURL(/\/oauth\//);
    await expect(page.getByTestId("signed-in-as")).toHaveText(ADMIN.email);
  });

  test("qa-settings-41: the consent card speaks plainly and calls a loopback address the client on this computer", async ({ page }) => {
    await login(page);
    await page.goto("/oauth/consent?request=mock-handle");
    const consent = page.getByTestId("consent");
    await expect(consent).toContainText(`${MOCK_CONSENT.client_name} wants to use Product Oracle as you.`);
    await expect(consent).toContainText(
      "See what you can see: the baseline, documents, runs and your sources. It also sees the names of all Notion pages shared with Product Oracle, even ones not added as a source.",
    );
    await expect(consent).toContainText("Make the changes you are allowed to: propose, comment, approve and edit.");
    await expect(consent).not.toContainText("including pages in no source");
    const back = page.getByTestId("consent-return");
    await expect(back).toHaveText(`${MOCK_CONSENT.client_name} on this computer`);
    await expect(back).toHaveAttribute("title", new URL(MOCK_CONSENT.redirect_uri).host);
    await expect(consent).not.toContainText("127.0.0.1");
  });

  test("qa-settings-42: a removed member is told an owner removed them and whom to ask", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("former.pm@example.com");
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = page.getByRole("alert").filter({ hasText: /\S/ });
    await expect(alert).toHaveText("An owner removed you from this Oracle. Ask Admin to restore you.");
    await expect(page).toHaveURL(/\/login/);

    // A wrong password says no more than for anyone else.
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alert).toHaveText("Invalid email or password.");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-settings-39: My account lights the bar's More, as Settings does", async ({ page }) => {
    await login(page);
    const more = page.getByTestId("tab-bar").getByTestId("tab-more");
    await expect(more).not.toHaveClass(/bg-rail-active/);
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
    await expect(more).toHaveClass(/bg-rail-active/);
    // qa4-shell-22: More is the one current tab there, for screen readers too.
    await expect(page.getByTestId("tab-bar").locator('[aria-current="page"]')).toHaveCount(1);
    await expect(more).toHaveAttribute("aria-current", "page");
    await page.goto("/settings/members");
    await expect(more).toHaveClass(/bg-rail-active/);
  });
});

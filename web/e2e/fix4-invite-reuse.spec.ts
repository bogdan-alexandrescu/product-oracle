import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";

/*
 * Fix round 4, an invite used again after it was accepted (qa-onboarding-39), on the seeded
 * company and on a new one (the 'empty' scenario).
 * protects: an owner invites someone on Settings › Members and copies the sign-in link; the
 *   invitee's first sign-in takes the invite (welcomed once); signing in again, or opening the
 *   copied link again, signs them in as that same member with no second welcome; the owner's
 *   invite row, and its Copy link, are gone, and the person is one member with the invite's role.
 * fails_when: a second sign-in or the old link is refused, makes a second member, welcomes
 *   them again, or the owner still sees the invite with Copy link.
 * no_claim: the API's Google (IAP) sign-in (api/tests/test_iap.py): the mock's sign-in form
 *   stands in for it, as in e2e/welcome.spec.ts.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const welcome = (page: Page) => page.getByTestId("home-welcome").filter({ visible: true });

async function signInAs(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

for (const scenario of ["seeded", "empty"] as const) {
  test(`qa-onboarding-39 (${scenario}): an accepted invite used again signs in as the member, with no second welcome`, async ({ page }) => {
    if (scenario === "empty") await page.addInitScript((key) => localStorage.setItem(key, "empty"), MOCK_SCENARIO_KEY);
    const email = "rae.reuse@example.com";
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    // The owner invites them and copies the sign-in link.
    await login(page);
    await page.goto("/settings/members");
    const form = page.getByRole("form", { name: "Invite" });
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Role", { exact: true }).selectOption("approver");
    await form.getByRole("button", { name: "Send invite", exact: true }).click();
    await expect(page.getByTestId("invite-outcome")).toHaveText(`Invite sent to ${email}`);
    const row = page.getByTestId("invite-row").filter({ hasText: email });
    await row.getByRole("button", { name: `Copy link for ${email}` }).click();
    await expect(row).toContainText("Copied");
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(link).origin).toBe(new URL(page.url()).origin);
    await signOut(page);

    // Accepted: the first sign-in takes the invite and welcomes them once.
    await page.goto("/login");
    await signInAs(page, email);
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("signed-in-as")).toHaveText(email);
    await expect(welcome(page).getByRole("heading", { name: "Welcome to Oracle" })).toBeVisible();
    await welcome(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(welcome(page)).toHaveCount(0);
    // The Dismiss is saved (the mock keeps its data in localStorage) before the page is left.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("po-mock-db-v2")?.includes('"welcome_dismissed":true') ?? false))
      .toBe(true);

    // The copied link again, still signed in: on to their Home, no welcome.
    await page.goto(link);
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await signOut(page);

    // The copied link again, signed out: sign-in, then the same member, no welcome, no refusal.
    await page.goto(link);
    await expect(page).toHaveURL(/\/login/);
    await signInAs(page, email);
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("signed-in-as")).toHaveText(email);
    await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);
    await signOut(page);

    // Signing in again from the sign-in page: the same.
    await signInAs(page, email);
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("signed-in-as")).toHaveText(email);
    await expect(welcome(page)).toHaveCount(0);
    await signOut(page);

    // The owner: the invite and its Copy link are gone; the person is one member, an approver.
    await login(page);
    await page.goto("/settings/members");
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await expect(page.getByTestId("member-row").filter({ hasText: email })).toHaveCount(1);
    await expect(page.getByLabel(`Role for ${email}`)).toHaveValue("approver");
    await expect(page.getByTestId("invite-row").filter({ hasText: email })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Copy link for ${email}` })).toHaveCount(0);
  });
}

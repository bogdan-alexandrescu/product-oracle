import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

/*
 * A5 /access (#203, AC 35-36), on the mock layer: a Google sign-in that is not a member is
 * sent from /login to /access, which says where it stands.
 * protects: someone waiting, declined, with an expired invite, at an invite-only Oracle or
 *   from outside the company's domains reads what happened and what to do, can leave a
 *   note while waiting, and can sign out.
 * fails_when: /login does not send them on, a title or body differs from 3.10, Send note
 *   does not answer "Sent", Sign out is missing, or the page scrolls sideways on a phone.
 * no_claim: the API's states (AC 1-7 in api/tests), Google's own sign-in, the 30-second
 *   poll's timing, and the approved state (it reloads into Oracle at once).
 */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

const CASES: [string, string, string][] = [
  [
    "access-pending",
    "Waiting for an owner",
    "You asked to join Acme's Product Oracle as new.person@example.com. An owner will approve or decline your request. This page updates by itself.",
  ],
  ["access-declined", "An owner declined your request", "If you think this is a mistake, ask an owner to invite new.person@example.com."],
  ["access-expired", "Your invite expired", "It expired on Oct 30. Ask the person who invited you to resend it."],
  ["access-invite-only", "This Oracle is invite only", "Ask an owner to invite new.person@example.com."],
  ["access-outside", "Use your work account", "new.person@example.com isn't from this company's email domains, so it can't join this Oracle."],
];

for (const [name, title, body] of CASES) {
  test(`access: ${name} shows "${title}" and Sign out`, async ({ page }) => {
    await scenario(page, name);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/access$/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByTestId("access-body")).toHaveText(body);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Outside the app shell, like /login.
    await expect(page.getByRole("navigation", { name: "Oracle" })).toHaveCount(0);
  });
}

test("access: while pending, Send note answers Sent", async ({ page }) => {
  await scenario(page, "access-pending");
  await page.goto("/access");
  await page.getByLabel("Add a note for the owner (optional)").fill("I run support for the clinics team.");
  await page.getByRole("button", { name: "Send note" }).click();
  await expect(page.getByRole("button", { name: "Sent" })).toBeVisible();
  await expect(page.getByText("Signed in with the wrong Google account?")).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("access at 390 px has no side scroll", async ({ page }) => {
    await scenario(page, "access-pending");
    await page.goto("/access");
    await expect(page.getByRole("button", { name: "Send note" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

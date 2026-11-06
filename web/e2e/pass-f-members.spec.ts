import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass F, Members, invites and access (on the mock layer).
 * protects: F-15 the engineering lead row says "None yet" and its (i) stays on a phone's
 *   screen; F-16 "Lapses for good" names documents and sections; F-22 a failed invite email
 *   says why in words; F-30/F-50 the page's explanations sit behind (i)s and an address
 *   outside the company domains gets a short refusal with Add domain; F-47 a failed access
 *   check offers Retry and Sign out; F-48 a removed member's revoke that failed shows on
 *   their row and is retried there; F-49 the count tiles lead to what they count; F-52 the
 *   People table shows whole emails, "Engineering lead", and no Remove on your own row;
 *   F-53 the Remove dialog's subtitle wraps; F-54 "Invite sent" goes away.
 * no_claim: the API's refusal text (api/tests/test_invites.py) and approval titles
 *   (api/tests/test_member_impact.py).
 */

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name]);

async function openMembers(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-members").click();
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByTestId("member-row").first()).toBeVisible();
}

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });

test.describe("pass-f members", () => {
  test("F-15: no engineering lead reads None yet; at 390 the (i) stays on the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto("/settings/members");
    const lead = page.getByTestId("roles-engineering-lead");
    await expect(lead.getByTestId("engineering-lead-none")).toHaveText("None yet");
    const tip = lead.getByRole("button", { name: /engineering lead/i });
    await tip.scrollIntoViewIfNeeded();
    const box = await tip.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    await tip.click();
    await expect(page.getByText(/Pick who carries engineering checks/).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("F-16 F-53: the Remove dialog names documents and sections, and its subtitle wraps", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openMembers(page);
    await memberRow(page, "approver@example.com").getByRole("button", { name: "Remove approver@example.com" }).click();
    const dialog = page.getByTestId("remove-dialog");
    const subject = dialog.getByTestId("confirm-subject");
    await expect(subject).toHaveText("approver@example.com · Approver");
    expect(await subject.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole("button", { name: "See them" }).click();
    const list = dialog.getByTestId("member-approvals");
    await expect(list.getByRole("link", { name: "Usage alerts v4" }).first()).toBeVisible();
    await expect(list).toContainText("Problem");
    await expect(list).not.toContainText("#problem");
    await expect(list).not.toContainText("usage-alerts v4");
  });

  test("F-22: a failed invite email says the mail service was down", async ({ page }) => {
    await scenario(page, "mail-fails");
    await login(page);
    await openMembers(page);
    await page.getByLabel("Email").fill("pat@example.com");
    await page.getByRole("button", { name: "Send invite", exact: true }).click();
    const row = page.getByTestId("invite-row").filter({ hasText: "pat@example.com" });
    await expect(row.getByTestId("invite-email-detail")).toHaveText(/^Last tried .+ · the mail service was down$/);
    await expect(row).not.toContainText("503");
  });

  test("F-30 F-50: explanations sit behind (i)s; an outside address gets a short refusal and Add domain", async ({ page }) => {
    await login(page);
    await openMembers(page);
    const main = page.getByRole("main");
    for (const text of [
      "Who may sign in from Google",
      "signs in without an invite waits",
      "The role an approved request starts with",
      "Reads documents, versions",
    ]) {
      await expect(main.getByText(text, { exact: false }).filter({ visible: true })).toHaveCount(0);
    }
    await page.getByLabel("Email").fill("x@other.org");
    await page.getByRole("button", { name: "Send invite", exact: true }).click();
    const form = page.getByRole("form", { name: "Invite" });
    await expect(form.getByRole("alert")).toContainText("x@other.org is not in the company domains");
    await form.getByRole("button", { name: "Add domain" }).click();
    await expect(page.getByLabel("Add a domain")).toHaveValue("other.org");
    await expect(page.getByLabel("Add a domain")).toBeFocused();
  });

  test("F-30: a viewer's role note is one short line", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.goto("/settings/members");
    const note = page.getByTestId("role-note");
    await expect(note).toContainText("Your role is Viewer");
    await expect(note.getByText("Owners manage members and sign-in.").filter({ visible: true })).toHaveCount(0);
  });

  test("F-47: a failed access check offers Retry and Sign out", async ({ page }) => {
    await scenario(page, "access-pending");
    await page.goto("/login");
    await expect(page).toHaveURL(/\/access$/);
    await page.evaluate(() => localStorage.setItem("po-mock-fail", "/v1/auth/access"));
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Can't check your access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Waiting for an owner" })).toBeVisible();
  });

  test("F-48: a removed member's failed revoke shows on their row and Retry clears it", async ({ page }) => {
    await scenario(page, "revoke-failures");
    await login(page);
    await openMembers(page);
    const row = memberRow(page, "former.pm@example.com");
    await row.getByTestId("revoke-badge").click();
    const section = page.getByTestId("revoke-failures");
    await expect(section).toBeInViewport();
    const items = section.getByTestId("revoke-failure");
    await expect(items).toHaveCount(2);
    await items.filter({ hasText: "GitHub" }).getByRole("button", { name: "Retry" }).click();
    await expect(items).toHaveCount(1);
    await items.getByRole("button", { name: "Dismiss" }).click();
    await expect(section).toHaveCount(0);
    await expect(row.getByTestId("revoke-badge")).toHaveCount(0);
  });

  test("F-49: the count tiles filter People and lead to the invites", async ({ page }) => {
    await login(page);
    await openMembers(page);
    await page.getByRole("button", { name: /^Show removed members/ }).click();
    await expect(page.getByTestId("people-filter")).toContainText("Removed only");
    const rows = page.getByTestId("member-row");
    await expect(rows.first()).toBeVisible();
    for (const status of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(status).toBe("disabled");
    await page.getByRole("button", { name: /^Show active members/ }).first().click();
    await expect(page.getByTestId("people-filter")).toContainText("Active only");
    for (const status of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(status).not.toBe("disabled");
    await page.getByTestId("people-filter").getByRole("button", { name: "Show all" }).click();
    await expect(page.getByTestId("people-filter")).toHaveCount(0);
    await page.getByRole("button", { name: /^Show open invites/ }).click();
    await expect(page.getByTestId("open-invites")).toBeInViewport();
  });

  test("F-52: whole emails, Engineering lead, and no Remove on your own row", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await openMembers(page);
    for (const email of await page.getByTestId("member-email").all()) {
      expect(await email.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await expect(page.locator("#engineering-lead")).toHaveText("Engineering lead");
    const me = page.getByTestId("member-row").filter({ has: page.getByText("you", { exact: true }) });
    await expect(me.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    await expect(me).not.toContainText("You can't remove yourself");
  });

  test("F-54: Invite sent goes away once another action starts", async ({ page }) => {
    await login(page);
    await openMembers(page);
    await page.getByLabel("Email").fill("sam.rivera@example.com");
    await page.getByRole("button", { name: "Send invite", exact: true }).click();
    await expect(page.getByTestId("invite-outcome")).toHaveText("Invite sent to sam.rivera@example.com");
    await memberRow(page, "approver@example.com").getByRole("button", { name: "Remove approver@example.com" }).click();
    await expect(page.getByTestId("remove-dialog")).toBeVisible();
    await expect(page.getByTestId("invite-outcome")).toHaveCount(0);
  });
});

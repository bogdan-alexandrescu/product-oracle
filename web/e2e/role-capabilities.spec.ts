import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #370: hide what a role can't do. Settings shows a tab only when the role can read it
 * (GET /v1/me/capabilities, derived from the API's own route roles), its buttons only when
 * the role can use them, and a quiet "View only" on a page the role can read but not change.
 */

const ALL = [
  "nav-members",
  "nav-company",
  "nav-api-tokens",
  "nav-connections",
  "nav-claude-accounts",
  "nav-sources",
  "nav-notifications",
  "nav-templates",
  "nav-themes",
  "nav-autonomy",
];
// Company, API tokens and Notifications read owner-only routes; Members reads the people list
// (A5: everyone sees who is in the company, read-only below owner).
const EVERYONE = ["nav-members", "nav-connections", "nav-claude-accounts", "nav-sources", "nav-templates", "nav-themes", "nav-autonomy"];

const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });

async function openSettings(page: Page, email: string) {
  await login(page, email);
  await rail(page).getByTestId("nav-settings").click();
  await expect(settingsNav(page)).toBeVisible();
}

async function tabsShown(page: Page): Promise<string[]> {
  return settingsNav(page)
    .getByRole("link")
    .evaluateAll((links) => links.map((a) => a.getAttribute("data-testid") ?? "").filter((t) => t.startsWith("nav-")));
}

test("owner: every Settings tab, the owner's buttons, no View only", async ({ page }) => {
  await openSettings(page, "admin@example.com");
  await expect(page).toHaveURL(/\/settings\/members$/);
  expect(await tabsShown(page)).toEqual(ALL);
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toBeVisible();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveCount(0);

  await settingsNav(page).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("button", { name: "+ Add account" })).toBeVisible();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveCount(0);

  await settingsNav(page).getByTestId("nav-autonomy").click();
  await expect(page.getByTestId("autonomy-row-priorities").getByRole("group").getByRole("button").first()).toBeVisible();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveCount(0);
});

for (const role of ["approver", "commenter", "viewer"] as const) {
  test(`${role}: only the tabs the role can read, and no owner buttons`, async ({ page }) => {
    await openSettings(page, `${role}@example.com`);
    // Settings opens on the first tab the role can read.
    await expect(page).toHaveURL(/\/settings\/members$/);
    expect(await tabsShown(page)).toEqual(EVERYONE);

    // Claude accounts: read the pool, no controls, View only.
    await settingsNav(page).getByTestId("nav-claude-accounts").click();
    await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
    await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
    await expect(page.getByRole("button", { name: "+ Add account" })).toHaveCount(0);

    // Autonomy: the levels read as text; no picker, no owner-only note.
    await settingsNav(page).getByTestId("nav-autonomy").click();
    await expect(page.getByTestId("autonomy-row-priorities").getByTestId("autonomy-sentence")).toBeVisible();
    await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
    await expect(page.getByTestId(/^autonomy-row-/).getByRole("group").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("autonomy-owner-only")).toHaveCount(0);

    // Templates and themes: approvers make them; below that, View only and no New button.
    await settingsNav(page).getByTestId("nav-templates").click();
    await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
    if (role === "approver") {
      await expect(page.getByRole("link", { name: "New template" })).toBeVisible();
      await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveCount(0);
    } else {
      await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
      await expect(page.getByRole("link", { name: "New template" })).toHaveCount(0);
    }
    await settingsNav(page).getByTestId("nav-themes").click();
    await expect(page.getByRole("heading", { level: 1, name: "Themes" })).toBeVisible();
    if (role === "approver") await expect(page.getByRole("link", { name: "New theme" })).toBeVisible();
    else await expect(page.getByRole("link", { name: "New theme" })).toHaveCount(0);
  });
}

test("a deep link to a hidden Settings tab says it is not available for the role", async ({ page }) => {
  await login(page, "viewer@example.com");
  for (const path of ["/settings/api-tokens", "/settings/company", "/settings/notifications"]) {
    await page.goto(path);
    await expect(page.getByTestId("not-for-role")).toContainText("Not available for your role");
    await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
  }
  // The way out goes to a tab the role can read.
  await page.getByTestId("not-for-role").getByRole("link", { name: "Open Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/members$/);
});

test("Settings' own address opens the first tab the role can read", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/members$/);
});

test("a template a commenter opens has no edit, archive or restore buttons", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings/templates");
  await page.getByTestId(/^template-row-/).first().click();
  await page.getByRole("link", { name: /Open|View/ }).first().click();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
  await expect(page.getByRole("button", { name: /^(Edit|Save|Archive|Restore)/ })).toHaveCount(0);
});

test("engineering lead: the flag adds no Settings tab; the lead keeps the commenter's", async ({ page }) => {
  // The commenter carries the engineering lead flag in this scenario.
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, "eng-review"]);
  await openSettings(page, "commenter@example.com");
  await expect(page).toHaveURL(/\/settings\/members$/);
  expect(await tabsShown(page)).toEqual(EVERYONE);
  await settingsNav(page).getByTestId("nav-templates").click();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
});

test("when the capabilities cannot be read, Settings says so and Retry reads them again", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.evaluate(() => localStorage.setItem("po-mock-fail", "/v1/me/capabilities"));
  // A fresh load reads the capabilities again, and they fail.
  await page.goto("/settings/templates");
  const failed = page.getByTestId("caps-error").filter({ visible: true }).first();
  await expect(failed).toContainText("Oracle could not read what your role may do.");
  await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("caps-error")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
  await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
});

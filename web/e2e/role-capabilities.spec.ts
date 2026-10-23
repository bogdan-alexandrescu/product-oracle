import { expect, test, type Page } from "@playwright/test";

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
// Members, Company, API tokens and Notifications read owner-only routes.
const EVERYONE = ["nav-connections", "nav-claude-accounts", "nav-sources", "nav-templates", "nav-themes", "nav-autonomy"];

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
  await expect(page.getByTestId("view-only")).toHaveCount(0);

  await settingsNav(page).getByTestId("nav-claude-accounts").click();
  await expect(page.getByRole("button", { name: "+ Add account" })).toBeVisible();
  await expect(page.getByTestId("view-only")).toHaveCount(0);

  await settingsNav(page).getByTestId("nav-autonomy").click();
  await expect(page.getByTestId("autonomy-row-priorities").getByRole("group").getByRole("button").first()).toBeVisible();
  await expect(page.getByTestId("view-only")).toHaveCount(0);
});

for (const role of ["approver", "commenter", "viewer"] as const) {
  test(`${role}: only the tabs the role can read, and no owner buttons`, async ({ page }) => {
    await openSettings(page, `${role}@example.com`);
    // Settings opens on the first tab the role can read.
    await expect(page).toHaveURL(/\/settings\/connections$/);
    expect(await tabsShown(page)).toEqual(EVERYONE);

    // Claude accounts: read the pool, no controls, View only.
    await settingsNav(page).getByTestId("nav-claude-accounts").click();
    await expect(page.getByRole("heading", { level: 1, name: "Claude accounts" })).toBeVisible();
    await expect(page.getByTestId("view-only")).toHaveText("View only");
    await expect(page.getByRole("button", { name: "+ Add account" })).toHaveCount(0);

    // Autonomy: the levels read as text; no picker, no owner-only note.
    await settingsNav(page).getByTestId("nav-autonomy").click();
    await expect(page.getByTestId("autonomy-row-priorities").getByTestId("autonomy-sentence")).toBeVisible();
    await expect(page.getByTestId("view-only")).toHaveText("View only");
    await expect(page.getByTestId(/^autonomy-row-/).getByRole("group").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("autonomy-owner-only")).toHaveCount(0);

    // Templates and themes: approvers make them; below that, View only and no New button.
    await settingsNav(page).getByTestId("nav-templates").click();
    await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
    if (role === "approver") {
      await expect(page.getByRole("link", { name: "New template" })).toBeVisible();
      await expect(page.getByTestId("view-only")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("view-only")).toHaveText("View only");
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
  for (const path of ["/settings/members", "/settings/api-tokens", "/settings/company", "/settings/notifications"]) {
    await page.goto(path);
    await expect(page.getByTestId("not-for-role")).toContainText("Not available for your role");
    await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
  }
  // The way out goes to a tab the role can read.
  await page.getByTestId("not-for-role").getByRole("link", { name: "Open Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

test("Settings' own address opens the first tab the role can read", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

test("a template a commenter opens has no edit, archive or restore buttons", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/settings/templates");
  await page.getByTestId(/^template-row-/).first().click();
  await page.getByRole("link", { name: /Open|View/ }).first().click();
  await expect(page.getByTestId("view-only")).toHaveText("View only");
  await expect(page.getByRole("button", { name: /^(Edit|Save|Archive|Restore)/ })).toHaveCount(0);
});

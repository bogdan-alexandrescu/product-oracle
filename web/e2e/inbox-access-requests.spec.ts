import { expect, test, type Page } from "@playwright/test";

import { login, signOut } from "./helpers";

/*
 * A5 Members and access, part 3 (#203): AC 24, on the mock layer (the API's Inbox group
 * and its count are in api/tests/test_access_requests.py).
 * protects: an owner, or an approver as viewer or commenter, lets a person who asked to join
 *   in, or turns them down, from the Inbox and Home, in place; the rail badge counts the
 *   request and drops by one once it is decided.
 * fails_when: the "Access request" row, its note or its role select is missing; the select
 *   does not start on the company's default role; the outcome is not shown in place; the
 *   badge does not count the request or does not drop; a commenter sees the row.
 * no_claim: the mock stands in for the API; the Members page's panel is in
 *   members-access.spec.ts.
 */

const NEW = "new.person@example.com";
const badge = (page: Page) => page.getByTestId("nav-inbox-badge");
const badgeCount = async (page: Page) => Number((await badge(page).innerText()).replace(/\D+/g, "") || "0");
const requestRow = (page: Page) => page.getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW });

test("inbox: an owner approves an access request, it moves to Done and the badge drops by one", async ({ page }) => {
  // AC 24
  await login(page);
  await page.goto("/inbox");
  const row = requestRow(page);
  await expect(row).toContainText("Access request");
  await expect(row).toContainText(`${NEW} asks to join`);
  await expect(row).toContainText("I lead support and need to read the PRD.");
  // Preset to the company's default role (commenter); an owner may choose any role.
  const role = row.getByLabel(`Role for ${NEW}`);
  await expect(role).toHaveValue("commenter");
  await expect(role.locator("option")).toHaveText(["Viewer", "Commenter", "Approver", "Owner"]);
  const before = await badgeCount(page);

  await row.getByRole("button", { name: "Approve", exact: true }).click();
  // qa-company-7: it leaves Needs you at once for Done, the banner says so.
  await expect(page.getByTestId("inbox-acted")).toContainText(`Approved ${NEW} as Commenter`);
  await expect(badge(page)).toHaveText(String(before - 1));
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Done/ }).click();
  await expect(row).toContainText("Approved as Commenter ✓");
  await expect(row.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  // Approved: the request became an open invite.
  await page.goto("/settings/members");
  await expect(page.getByTestId("invite-row").filter({ hasText: NEW })).toContainText("Commenter");
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-access-requests")).toHaveCount(0);
});

test("inbox: declining an access request moves it to Declined, and Home counts the request too", async ({ page }) => {
  await login(page);
  const home = page.getByTestId("home-needs");
  // Home counts it under Access, with the rest of Needs you.
  await expect(home.getByText("Access 1")).toBeVisible();
  await page.goto("/inbox");
  const row = requestRow(page);
  const before = await badgeCount(page);
  await row.getByRole("button", { name: "Decline", exact: true }).click();
  // qa-company-7: it leaves Needs you at once, for the Declined tab.
  await expect(page.getByTestId("inbox-acted")).toContainText(`Declined ${NEW}`);
  await expect(badge(page)).toHaveText(String(before - 1));
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Declined/ }).click();
  await expect(row).toContainText("Declined");
});

test("inbox: an approver approves as viewer or commenter; a commenter sees no access request", async ({ page }) => {
  await login(page, "approver@example.com");
  await page.goto("/inbox");
  await expect(requestRow(page).getByLabel(`Role for ${NEW}`).locator("option")).toHaveText(["Viewer", "Commenter"]);

  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-access-requests")).toHaveCount(0);
});

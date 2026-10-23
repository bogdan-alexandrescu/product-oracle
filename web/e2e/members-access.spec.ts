import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/*
 * A5 Members and access, on the mock layer (the API's rules are in api/tests/test_access_requests.py).
 * protects: an owner sees who asks to join and approves (with the role they choose) or
 *   declines them in place, with Undo; an approval becomes an open invite with its expiry.
 * fails_when: the panel or its note is missing, the outcome is not shown in place, Undo
 *   does not bring the request back, or the invite does not appear with its role and expiry.
 * no_claim: the mock stands in for the API (AC 1-21 cover it); the Inbox row, the Sign-in
 *   panel and the remaining A5 screens are not built yet.
 */

test("members: an owner approves an access request as viewer and it becomes an invite", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const panel = page.getByTestId("access-requests");
  const row = panel.getByTestId("access-row").filter({ hasText: "new.person@example.com" });
  await expect(row).toContainText("I lead support and need to read the PRD.");

  await row.getByLabel("Role for new.person@example.com").selectOption("viewer");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByTestId("acted")).toContainText("Approved as Viewer");
  await expect(panel).toHaveCount(0);

  const invite = page.getByTestId("invite-row").filter({ hasText: "new.person@example.com" });
  await expect(invite).toContainText("Viewer");
  // #460: in the Company time zone (the mock's is America/Los_Angeles), not the browser's.
  const expires = new Date(Date.now() + 14 * 86_400_000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
  await expect(invite).toContainText(`Expires ${expires}`);

  await page.reload();
  await expect(page.getByTestId("invite-row").filter({ hasText: "new.person@example.com" })).toContainText("Viewer");
  await expect(page.getByTestId("access-requests")).toHaveCount(0);
});

test("members: declining an access request shows Declined, and Undo brings it back", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  const row = page.getByTestId("access-row").filter({ hasText: "new.person@example.com" });
  await row.getByRole("button", { name: "Decline" }).click();
  await expect(row.getByTestId("acted")).toContainText("Declined");
  await row.getByRole("button", { name: "Undo" }).click();
  await expect(row.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(row.getByLabel("Role for new.person@example.com")).toHaveValue("commenter");
});

/*
 * #370 meets A5: Access requests and their Approve, Decline and role choice are drawn only for
 * a role that can use them (can(), from GET /v1/me/capabilities); nobody sees them disabled.
 */
for (const role of ["owner", "approver", "commenter", "viewer"] as const) {
  test(`${role}: Members shows access requests and their controls only to a role that can decide them`, async ({ page }) => {
    await login(page, role === "owner" ? "admin@example.com" : `${role}@example.com`);
    await page.goto("/settings/members");
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    const owner = role === "owner";
    await expect(page.getByTestId("access-requests")).toHaveCount(owner ? 1 : 0);
    const rows = page.getByTestId("access-row");
    await expect(rows.getByRole("button", { name: "Approve", exact: true })).toHaveCount(owner ? 1 : 0);
    await expect(rows.getByRole("button", { name: "Decline", exact: true })).toHaveCount(owner ? 1 : 0);
    await expect(page.getByLabel("Role for new.person@example.com")).toHaveCount(owner ? 1 : 0);
  });
}

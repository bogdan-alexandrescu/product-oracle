import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/*
 * A5 Members and access, on the mock layer (the API's rules are in api/tests/test_access_requests.py).
 * protects: an owner sees who asks to join and approves (with the role they choose) or
 *   declines them in place, with Undo; an approval becomes an open invite with its expiry.
 * fails_when: the panel or its note is missing, the outcome is not shown in place, Undo
 *   does not bring the request back, or the invite does not appear with its role and expiry.
 *   The Sign-in panel (AC 25) says what a sign-in without an invite does and keeps the choice;
 *   its default role is Viewer or Commenter; the deployment's domain is locked; a public mail
 *   domain is refused.
 * no_claim: the mock stands in for the API (AC 1-21 cover it); the Inbox row (AC 24) is not
 *   built yet; the rest of A5 is in members-people.spec.ts and access-page.spec.ts.
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
    // A5: approvers decide requests too, with their own roles (viewer and commenter).
    const decides = role === "owner" || role === "approver";
    await expect(page.getByTestId("access-requests")).toHaveCount(decides ? 1 : 0);
    const rows = page.getByTestId("access-row");
    await expect(rows.getByRole("button", { name: "Approve", exact: true })).toHaveCount(decides ? 1 : 0);
    await expect(rows.getByRole("button", { name: "Decline", exact: true })).toHaveCount(decides ? 1 : 0);
    await expect(page.getByLabel("Role for new.person@example.com")).toHaveCount(decides ? 1 : 0);
  });
}

test("members: the Sign-in panel keeps Join at once, offers Viewer and Commenter, locks the deployment domain", async ({ page }) => {
  // AC 25
  await login(page);
  await page.goto("/settings/members");
  const panel = page.getByTestId("sign-in-rules");
  const line = panel.getByTestId("sign-in-rule-line");
  await expect(line).toHaveText(
    "Someone from these domains who signs in without an invite waits until an owner approves. Requests appear here and in the Inbox.",
  );
  await panel.getByRole("button", { name: "Join at once" }).click();
  await expect(line).toHaveText("Someone from these domains who signs in without an invite joins at once with the default role.");
  await page.reload();
  await expect(page.getByTestId("sign-in-rules").getByTestId("sign-in-rule-line")).toHaveText(
    "Someone from these domains who signs in without an invite joins at once with the default role.",
  );
  await expect(panel.getByRole("button", { name: "Join at once" })).toHaveAttribute("aria-pressed", "true");

  await expect(panel.getByLabel("Default role", { exact: true }).locator("option")).toHaveText(["Viewer", "Commenter"]);
  await expect(panel.getByLabel("Default role", { exact: true })).toHaveValue("commenter");

  const deployed = panel.getByTestId("sign-in-domain").filter({ hasText: "example.com" });
  await expect(deployed).toHaveAttribute("data-from", "deployment");
  await expect(deployed.locator('[title="Set where Oracle is deployed; change it there"]')).toBeVisible();
  await panel.getByRole("button", { name: "Edit domains" }).click();
  await expect(panel).toContainText("Docs in picked Drive folders owned outside these domains are skipped (Settings › Sources).");
  await expect(panel.getByRole("button", { name: "Remove example.com" })).toHaveCount(0);
  await panel.getByLabel("Add a domain").fill("gmail.com");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("gmail.com is a public mail provider");
  await expect(panel.getByTestId("sign-in-domain")).toHaveCount(1);
});

import { expect, test, type Page, mockNow } from "./test";

import { login, signOut } from "./helpers";

/*
 * A5 Members and access, part 2 (#203), on the mock layer (the API's rules are in
 * api/tests: preview parity, hand-over and the registry, AC 13-19).
 * protects: an owner sees what removing or demoting a member ends, lapses and leaves held,
 *   and hands it over in the same step; a removed member's leftovers can be handed over
 *   later; members carry names (the owner's and their own); non-owners read the people list;
 *   an approver invites viewers and commenters only and sees only their own invites.
 * fails_when: a preview group, a responsibility row or its blocks chip is missing; "Hand
 *   everything to" does not fill the rows; a demotion applies without asking, or Cancel
 *   leaves the new role; a name does not show in the People table; a commenter gets role
 *   selects, Remove or the Invite form; an approver is offered Approver or sees others' invites.
 * no_claim: the mock stands in for the API (AC 1-21 cover it); the Inbox access row (AC 24)
 *   is in inbox-access-requests.spec.ts; the Sign-in panel and /access are in
 *   members-access.spec.ts and access-page.spec.ts.
 */

const memberRow = (page: Page, email: string) => page.getByTestId("member-row").filter({ hasText: email });
const inviteRow = (page: Page, email: string) => page.getByTestId("invite-row").filter({ hasText: email });
const chosen = (page: Page, label: string) => page.getByLabel(label, { exact: true }).locator("option:checked");
/** "Nov 6": a date `days` from now in the Company time zone (the mock's is America/Los_Angeles, #460). */
const inDays = (days: number) =>
  new Date(mockNow().getTime() + days * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });

async function openMember(page: Page, email: string) {
  await memberRow(page, email).getByTestId("member-open").click();
  const inspector = page.getByTestId("member-inspector");
  await expect(inspector).toContainText("Members · member");
  return inspector;
}

test("members: removing the approver previews what it ends and hands everything to Admin", async ({ page }) => {
  // AC 30
  await login(page);
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Remove approver@example.com" }).click();
  const dialog = page.getByTestId("remove-dialog");
  await expect(dialog.getByRole("heading", { name: "Remove Approver?" })).toBeVisible();
  await expect(dialog).toContainText("approver@example.com · Approver");

  await expect(dialog.getByTestId("preview-ends")).toContainText("Signs them out everywhere; they can't sign in.");
  await expect(dialog.getByTestId("preview-ends")).toContainText("Revokes 1 personal API token.");
  await expect(dialog.getByTestId("preview-inbox")).toContainText("Goes back to the Inbox");
  await expect(dialog.getByTestId("preview-inbox")).toContainText("1 checkpoint decision not yet delivered: Feature set ·");
  await expect(dialog.getByTestId("preview-lapses")).toContainText("Lapses for good");
  await expect(dialog.getByTestId("preview-lapses")).toContainText("3 section approvals and 1 version approval (Usage alerts v4)");

  const rows = dialog.getByTestId("handover-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Decides document reviews");
  await expect(rows.nth(0)).toContainText("Publishing waits until someone else decides");
  await expect(rows.nth(1)).toContainText("Owns document sections");
  await expect(rows.nth(2)).toContainText("Has open questions to answer");
  for (const label of ["Decides document reviews", "Owns document sections", "Has open questions to answer"]) {
    await expect(chosen(page, `Hand over ${label}`)).toHaveText("Leave as is");
  }
  await expect(dialog).toContainText("History keeps their name. An owner can restore them; revoked tokens and connections stay revoked.");

  // Admin is an owner: every row qualifies.
  await dialog.getByLabel("Hand everything to").selectOption({ label: "Admin" });
  for (const label of ["Decides document reviews", "Owns document sections", "Has open questions to answer"]) {
    await expect(chosen(page, `Hand over ${label}`)).toHaveText("Admin");
  }
  await dialog.getByRole("button", { name: "Remove member" }).click();
  await expect(dialog).toBeHidden();
  await expect(memberRow(page, "approver@example.com")).toHaveAttribute("data-status", "disabled");

  const inspector = await openMember(page, "approver@example.com");
  const held = inspector.getByTestId("member-responsibilities");
  await expect(held).toContainText("Still assigned");
  await expect(held).toContainText("Nothing assigned");
  await expect(held.getByTestId("responsibility-row")).toHaveCount(0);
});

test("members: a removed member's Still assigned sections are handed to the commenter", async ({ page }) => {
  // AC 31
  await login(page);
  await page.goto("/settings/members");
  const inspector = await openMember(page, "former.pm@example.com");
  const held = inspector.getByTestId("member-responsibilities");
  await expect(held).toContainText("Still assigned");
  const sections = held.getByTestId("responsibility-row").filter({ hasText: "Owns document sections" });
  await expect(sections).toContainText("· 2");

  await sections.getByRole("button", { name: "Hand over", exact: true }).click();
  await sections.getByLabel("Hand over Owns document sections").selectOption({ label: "Commenter" });
  await sections.getByRole("button", { name: "Hand over", exact: true }).click();
  await expect(held.getByTestId("responsibility-row").filter({ hasText: "Owns document sections" })).toHaveCount(0);
  // The document policy's decider stays until handed over too.
  await expect(held.getByTestId("responsibility-row").filter({ hasText: "Decides document reviews" })).toHaveCount(1);

  await page.reload();
  const again = await openMember(page, "former.pm@example.com");
  await expect(again.getByTestId("responsibility-row").filter({ hasText: "Owns document sections" })).toHaveCount(0);
});

test("members: demoting the approver asks first, and Cancel keeps Approver; a promotion applies at once", async ({ page }) => {
  // AC 32
  await login(page);
  await page.goto("/settings/members");
  await page.getByLabel("Role for approver@example.com").selectOption("commenter");
  const dialog = page.getByTestId("role-dialog");
  await expect(dialog.getByRole("heading", { name: "Change Approver to Commenter?" })).toBeVisible();
  await expect(dialog.getByTestId("preview-lapses")).toContainText("3 section approvals and 1 version approval");
  await expect(dialog.getByTestId("preview-needs-holder")).toContainText("Decides document reviews needs Approver");
  // Sections and questions need commenter: the approver keeps them as a commenter.
  await expect(dialog.getByTestId("preview-needs-holder")).not.toContainText("Owns document sections");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Role for approver@example.com")).toHaveValue("approver");

  // Again, handing the decider to Admin.
  await page.getByLabel("Role for approver@example.com").selectOption("commenter");
  await dialog.getByLabel("Hand over Decides document reviews").selectOption({ label: "Admin" });
  await dialog.getByRole("button", { name: "Change role" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Role for approver@example.com")).toHaveValue("commenter");

  await page.getByLabel("Role for viewer@example.com").selectOption("commenter");
  await expect(page.getByTestId("role-dialog")).toBeHidden();
  await expect(page.getByLabel("Role for viewer@example.com")).toHaveValue("commenter");
  await page.reload();
  await expect(page.getByLabel("Role for viewer@example.com")).toHaveValue("commenter");
});

test("members: the owner names the approver in the inspector, and a commenter names themself", async ({ page }) => {
  // AC 29
  await login(page);
  await page.goto("/settings/members");
  // The name in bold with the email under it; the viewer has no name, so one made from the email (lib/names).
  await expect(memberRow(page, "approver@example.com").getByTestId("member-open")).toHaveText(/^Approver\s*approver@example\.com$/);
  await expect(memberRow(page, "viewer@example.com").getByTestId("member-open")).toHaveText(/^Viewer\s*viewer@example\.com$/);

  const inspector = await openMember(page, "approver@example.com");
  await expect(inspector).toContainText("Up to 80 characters");
  await expect(inspector).toContainText("Joined");
  await expect(inspector.getByTestId("member-holds")).toContainText(
    "3 section approvals · 1 version approval · 1 checkpoint decision not yet delivered",
  );
  await expect(inspector.getByTestId("member-responsibilities")).toContainText("Decides document reviews");
  await inspector.getByLabel("Name", { exact: true }).fill("Design approver");
  await inspector.getByRole("button", { name: "Save" }).click();
  await expect(inspector.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(memberRow(page, "approver@example.com")).toContainText("Design approver");
  await inspector.getByRole("button", { name: "Back to invites" }).click();
  await expect(page.getByRole("form", { name: "Invite" })).toBeVisible();

  // "Find a person" filters by name or email.
  await page.getByLabel("Find a person").fill("design");
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await page.getByLabel("Find a person").fill("");

  await signOut(page);
  await login(page, "commenter@example.com");
  await page.goto("/account");
  const mine = page.getByRole("form", { name: "Your name" });
  await expect(mine).toContainText("Shown to your teammates instead of your email.");
  await mine.getByLabel("Name", { exact: true }).fill("Casey Commenter");
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine.getByRole("button", { name: "Saved" })).toBeVisible();

  await signOut(page);
  await login(page);
  await page.goto("/settings/members");
  await expect(memberRow(page, "commenter@example.com")).toContainText("Casey Commenter");
});

test("members: a commenter reads the people list, with no role selects, Remove or Invite form", async ({ page }) => {
  // AC 33
  await login(page, "commenter@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("role-note")).toContainText("Your role is commenter. Owners manage members and sign-in.");
  const list = page.getByTestId("people-readonly");
  const rows = list.getByTestId("person-row");
  await expect(rows.filter({ hasText: "approver@example.com" })).toContainText("Approver");
  await expect(rows.filter({ hasText: "admin@example.com" })).toContainText("Owner");
  await expect(rows).toHaveCount(4);
  // The removed member is not listed.
  await expect(rows.filter({ hasText: "former.pm@example.com" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Invite" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite", exact: true })).toHaveCount(0);

  await page.getByLabel("Find a person").fill("approv");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("approver@example.com");
});

test("members: an approver invites viewers and commenters only and sees only their invites", async ({ page }) => {
  // AC 34
  await login(page, "approver@example.com");
  await page.goto("/settings/members");
  await expect(page.getByTestId("role-note")).toContainText(
    "Your role is approver. You can invite viewers and commenters and approve their access requests.",
  );
  const form = page.getByRole("form", { name: "Invite" });
  await expect(form.getByLabel("Role", { exact: true }).locator("option")).toHaveText(["Commenter", "Viewer"]);
  // The owner's invites are not theirs.
  await expect(inviteRow(page, "new.hire@example.com")).toHaveCount(0);
  await form.getByLabel("Email").fill("sam.support@example.com");
  await form.getByLabel("Role", { exact: true }).selectOption("viewer");
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(inviteRow(page, "sam.support@example.com")).toContainText("Viewer");
  await expect(page.getByTestId("invite-row")).toHaveCount(1);

  const request = page.getByTestId("access-row").filter({ hasText: "new.person@example.com" });
  await expect(request.getByLabel("Role for new.person@example.com").locator("option")).toHaveText(["Viewer", "Commenter"]);
  // Read-only people, no member table.
  await expect(page.getByTestId("people-readonly")).toBeVisible();
  await expect(page.getByTestId("member-row")).toHaveCount(0);
});

test("members: an expired invite's Resend gives it 14 more days", async ({ page }) => {
  // AC 27
  await login(page);
  await page.goto("/settings/members");
  const row = inviteRow(page, "old.invite@example.com");
  await expect(row).toContainText("Expired");
  await row.getByRole("button", { name: "Resend invite for old.invite@example.com" }).click();
  await expect(row).toContainText(`Expires ${inDays(14)}`);
  await expect(row).not.toContainText("Expired");
  await page.reload();
  await expect(inviteRow(page, "old.invite@example.com")).toContainText(`Expires ${inDays(14)}`);
});

test("members: inviting outside the company's domains says so and adds no row", async ({ page }) => {
  // AC 28
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill("x@elsewhere.test");
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("outside the company's email domains");
  await expect(inviteRow(page, "x@elsewhere.test")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("members at 390 px: no side scroll on the page or in the remove dialog, whose buttons stay in view", async ({ page }) => {
    // AC 36 (the /access page is not built yet)
    await login(page);
    await page.goto("/settings/members");
    await expect(page.getByTestId("access-requests")).toBeVisible();
    const noSideScroll = async () =>
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await noSideScroll();
    await page.getByRole("button", { name: "Remove approver@example.com" }).click();
    const dialog = page.getByTestId("remove-dialog");
    await expect(dialog.getByTestId("handover-row")).toHaveCount(3);
    await noSideScroll();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await expect(dialog.getByRole("button", { name: "Remove member" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
  });
});

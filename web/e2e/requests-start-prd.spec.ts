import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * C1 Requests, lane 2 (issue #150): Start a PRD from requests. The brief (C4 One New PRD
 * door) shows "Requests behind it"; Continue links them to the brief, and the people who
 * asked see the brief on their request. Driven through the UI of the mock build. Synthetic
 * placeholders only.
 *
 * Test cards:
 * - "Start a PRD from the inspector" (criterion 19): protects=Start a PRD on a qualified
 *   request opens New PRD with that request ticked under "Requests behind it", grouped by
 *   theme, and Continue links it; fails_when=the request is not ticked, another is, the brief
 *   lists none of them, or a member reading the request cannot reach the brief from it;
 *   no_claim=the PRD the run makes (api/tests/test_requests_brief.py).
 * - "Start a PRD from the queue": protects=selecting qualified requests in the queue and
 *   starting one PRD from all of them; fails_when=New requests can be selected, the button
 *   counts wrong, or a selected request is not ticked in the brief; no_claim=a theme's
 *   Start a PRD.
 * - "already behind a brief or a PRD" (#569 review MAJOR 1): protects=a request already
 *   behind a brief, or linked to a PRD, is not offered again (no box in the queue, no Start a
 *   PRD in the inspector, not listed under "Requests behind it"), and the inspector shows the
 *   PRD once; fails_when=such a request can be ticked or started from, or a second brief
 *   could take it over; no_claim=the API's 409 (api/tests/test_requests_brief.py).
 * - "archiving a brief that made no PRD" (#599 re-review MAJOR 1, decided "Release on
 *   archive", 2026-10-25): protects=archiving such a brief releases the requests behind it,
 *   so the queue, the inspector and the next brief offer them again and a new brief takes
 *   them; fails_when=a released request stays hidden, still names the archived brief, or the
 *   new brief cannot take it; no_claim=a brief that made a PRD (it cannot be archived once
 *   converted; api/tests/test_requests_brief.py keeps its links).
 * - "viewers": protects=Start a PRD only for those who can write a brief; fails_when=a viewer
 *   sees the button or the selection boxes; no_claim=the API's role check.
 */

const PROBLEM = "Buyers want a short summary of their orders every week, sent to their inbox.";

const row = (page: Page, title: string) => page.getByTestId("request-row").filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("request-inspector");
const behind = (page: Page) => page.getByRole("group", { name: /Requests behind it/ });

async function openRequests(page: Page) {
  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByTestId("request-row").first()).toBeVisible();
}

async function pick(page: Page, title: string) {
  await row(page, title).getByRole("button", { name: title }).click();
  await expect(inspector(page).getByRole("heading", { name: title })).toBeVisible();
}

test("Start a PRD from the inspector: the brief shows the request behind it, and the request shows the brief", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  await pick(page, "Weekly summary email");
  await inspector(page).getByRole("button", { name: "Start a PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd&requests=[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();

  // Every qualified request, grouped by theme; only the one started from is ticked.
  await expect(behind(page).getByRole("checkbox")).toHaveCount(4);
  await expect(behind(page).getByRole("checkbox", { name: "Weekly summary email" })).toBeChecked();
  await expect(behind(page).getByRole("checkbox", { name: "Invite a whole team at once" })).not.toBeChecked();
  await expect(behind(page).getByTestId("requests-theme").filter({ hasText: "Reporting" })).toContainText("Weekly summary email");
  await expect(behind(page).getByTestId("requests-theme").filter({ hasText: "Team sharing" })).toContainText("Share a board read-only");

  await page.getByRole("textbox", { name: "Title" }).fill("Weekly order summary");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  const brief = page.url();
  const linked = page.getByTestId("intake-requests");
  await expect(linked.getByRole("link")).toHaveText(["Weekly summary email"]);

  // A member reading the request sees the brief it is behind and opens it.
  await signOut(page);
  await login(page, "viewer@example.com");
  await openRequests(page);
  await pick(page, "Weekly summary email");
  const link = inspector(page).getByRole("link", { name: "Weekly order summary" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(brief);
});

test("Start a PRD from the queue: selected qualified requests are ticked in the brief", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  // New requests are not selectable: only qualified ones go into a PRD.
  await expect(row(page, "Dark mode").getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Start a PRD from/ })).toHaveCount(0);
  await row(page, "Invite a whole team at once").getByRole("checkbox", { name: "Select Invite a whole team at once" }).check();
  await row(page, "Share a board read-only").getByRole("checkbox", { name: "Select Share a board read-only" }).check();
  await page.getByRole("button", { name: "Start a PRD from 2 requests" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd&requests=[0-9a-f-]+(,|%2C)[0-9a-f-]+$/);
  await expect(behind(page).getByRole("checkbox", { name: "Invite a whole team at once" })).toBeChecked();
  await expect(behind(page).getByRole("checkbox", { name: "Share a board read-only" })).toBeChecked();
  await expect(behind(page).getByRole("checkbox", { name: "Weekly summary email" })).not.toBeChecked();
  // Unticking one leaves it out.
  await behind(page).getByRole("checkbox", { name: "Share a board read-only" }).uncheck();
  await page.getByRole("textbox", { name: "Title" }).fill("Team invites");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByTestId("intake-requests").getByRole("link")).toHaveText(["Invite a whole team at once"]);
});

test("already behind a brief or a PRD: such requests are not offered in the queue, the inspector or the brief", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  // Brief A takes "Invite a whole team at once".
  await row(page, "Invite a whole team at once").getByRole("checkbox", { name: "Select Invite a whole team at once" }).check();
  await page.getByRole("button", { name: "Start a PRD from 1 request" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Team invites");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByTestId("intake-requests").getByRole("link")).toHaveText(["Invite a whole team at once"]);

  // "Share a board read-only" is linked to a PRD by an approver.
  await openRequests(page);
  await pick(page, "Share a board read-only");
  await inspector(page).getByLabel("PRD").selectOption({ index: 1 });
  await inspector(page).getByRole("button", { name: "Save links" }).click();
  const prd = inspector(page).locator('a[href^="/documents/"]');
  await expect(prd).toBeVisible();

  // Neither can be ticked or started from again.
  await page.reload();
  await expect(page.getByTestId("request-row").first()).toBeVisible();
  await expect(row(page, "Invite a whole team at once").getByRole("checkbox")).toHaveCount(0);
  await expect(row(page, "Share a board read-only").getByRole("checkbox")).toHaveCount(0);
  await expect(row(page, "Weekly summary email").getByRole("checkbox")).toHaveCount(1);
  await pick(page, "Invite a whole team at once");
  await expect(inspector(page).getByRole("link", { name: "Team invites" })).toBeVisible();
  await expect(inspector(page).getByRole("button", { name: "Start a PRD" })).toHaveCount(0);
  await pick(page, "Share a board read-only");
  await expect(inspector(page).getByRole("button", { name: "Start a PRD" })).toHaveCount(0);

  // The brief offers only the requests still free: not those two.
  await pick(page, "Weekly summary email");
  await inspector(page).getByRole("button", { name: "Start a PRD" }).click();
  await expect(behind(page).getByRole("checkbox", { name: "Weekly summary email" })).toBeChecked();
  await expect(behind(page).getByRole("checkbox", { name: "Invite a whole team at once" })).toHaveCount(0);
  await expect(behind(page).getByRole("checkbox", { name: "Share a board read-only" })).toHaveCount(0);
  await expect(behind(page).getByRole("checkbox")).toHaveCount(2);
});

test("archiving a brief that made no PRD releases its requests to the next brief", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  await row(page, "Invite a whole team at once").getByRole("checkbox", { name: "Select Invite a whole team at once" }).check();
  await page.getByRole("button", { name: "Start a PRD from 1 request" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Team invites");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByTestId("intake-requests").getByRole("link")).toHaveText(["Invite a whole team at once"]);

  // The brief is archived before it made a PRD.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("alertdialog", { name: "Archive" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByTestId("intake-status")).toHaveText("Archived");

  // The request is free again: selectable in the queue, Start a PRD in the inspector, no brief.
  await openRequests(page);
  await expect(row(page, "Invite a whole team at once").getByRole("checkbox")).toHaveCount(1);
  await pick(page, "Invite a whole team at once");
  await expect(inspector(page).getByRole("link", { name: "Team invites" })).toHaveCount(0);
  await inspector(page).getByRole("button", { name: "Start a PRD" }).click();
  await expect(behind(page).getByRole("checkbox", { name: "Invite a whole team at once" })).toBeChecked();

  // A new brief takes it.
  await page.getByRole("textbox", { name: "Title" }).fill("Team invites, again");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill(PROBLEM);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(page.getByTestId("intake-requests").getByRole("link")).toHaveText(["Invite a whole team at once"]);
  await openRequests(page);
  await pick(page, "Invite a whole team at once");
  await expect(inspector(page).getByRole("link", { name: "Team invites, again" })).toBeVisible();
});

test("the inspector shows a request's PRD once", async ({ page }) => {
  await login(page, "approver@example.com");
  await openRequests(page);
  await pick(page, "Weekly summary email");
  await inspector(page).getByLabel("PRD").selectOption({ index: 1 });
  await inspector(page).getByRole("button", { name: "Save links" }).click();
  await expect(inspector(page).locator('a[href^="/documents/"]')).toBeVisible();
  await signOut(page);
  await login(page, "viewer@example.com");
  await openRequests(page);
  await pick(page, "Weekly summary email");
  // The PRD shows once, as a link, not again as a "PRD" row under Links.
  await expect(inspector(page).locator('a[href^="/documents/"]')).toHaveCount(1);
  await expect(inspector(page).locator("dt", { hasText: /^PRD$/ })).toHaveCount(1);
});

test("viewers: no Start a PRD and nothing to select", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openRequests(page);
  await expect(row(page, "Weekly summary email").getByRole("checkbox")).toHaveCount(0);
  await pick(page, "Weekly summary email");
  await expect(inspector(page).getByRole("button", { name: "Start a PRD" })).toHaveCount(0);
});

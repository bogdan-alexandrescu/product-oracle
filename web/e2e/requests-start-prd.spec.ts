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

test("viewers: no Start a PRD and nothing to select", async ({ page }) => {
  await login(page, "viewer@example.com");
  await openRequests(page);
  await expect(row(page, "Weekly summary email").getByRole("checkbox")).toHaveCount(0);
  await pick(page, "Weekly summary email");
  await expect(inspector(page).getByRole("button", { name: "Start a PRD" })).toHaveCount(0);
});

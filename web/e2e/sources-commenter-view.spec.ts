import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Owner 2026-11-10 ("No: commenters only see them"): a commenter (and a viewer) sees the sources that
 * need attention and each one's status, on the Inbox, Settings › Sources and Sources, with no Edit or any
 * other change control; an approver or owner keeps Edit.
 * fails_when = a commenter is offered Edit, Pick fewer channels, Share again, Reconnect, Sync now, Pause
 * or Delete on a source, or the owner loses Edit.
 */

const LEGACY = "Legacy all-hands chat";

async function openInbox(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
}

async function openSettingsSources(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page.getByRole("list", { name: "My sources" })).toBeVisible();
}

for (const role of ["commenter", "viewer"] as const) {
  test(`a ${role} sees the sources that need attention with no Edit`, async ({ page }) => {
    await login(page, `${role}@example.com`);

    // Inbox: the list, each source's problem, no action that changes it.
    await openInbox(page);
    const list = page.getByTestId("inbox-sources");
    await expect(list).toContainText(LEGACY);
    await expect(list.getByTestId("source-need-text").filter({ hasText: "Too many channels" })).toBeVisible();
    await expect(list.getByTestId("need-by-role").first()).toHaveText("View only");
    await expect(list.getByRole("link")).toHaveCount(0);
    await expect(list.getByRole("button", { name: /^(Edit|Pick fewer|Share again|Reconnect)/ })).toHaveCount(0);

    // Settings › Sources: the count and the status, no Edit, Sync, Pause or Delete.
    await openSettingsSources(page);
    await expect(page.getByTestId("sources-attention")).toHaveText("3 need attention");
    const row = page.getByRole("listitem", { name: LEGACY });
    await expect(row.locator('[data-kind="warn"]').filter({ hasText: "Needs attention" })).toBeVisible();
    await expect(row.getByRole("button", { name: `Edit ${LEGACY}` })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /^Edit / })).toHaveCount(0);
    for (const name of ["Sync now", "Pause", "Resume"]) {
      await expect(page.getByRole("main").getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await row.getByRole("button", { name: `More actions for ${LEGACY}` }).click();
    await expect(page.getByRole("menuitem", { name: "Coverage" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^Edit / })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Sources: the source's coverage reads, with no Sync now or Edit picks.
    await page.goto("/sources");
    const coverage = page.getByRole("region", { name: "Coverage" });
    await expect(coverage).toHaveAttribute("aria-busy", "false");
    await page.getByTestId("coverage-table").locator("tr[data-row]").filter({ hasText: LEGACY }).click();
    const inspector = page.getByTestId("coverage-inspector");
    await expect(inspector.getByTestId("sync-viewer-note")).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await expect(inspector.getByRole("link", { name: /Edit picks/ })).toHaveCount(0);
  });
}

test("the owner keeps Edit on the sources that need attention", async ({ page }) => {
  await login(page);
  await openInbox(page);
  const list = page.getByTestId("inbox-sources");
  await expect(list.getByRole("link", { name: `Pick fewer channels in ${LEGACY}` })).toBeVisible();
  await expect(list.getByTestId("need-by-role")).toHaveCount(0);

  await openSettingsSources(page);
  const row = page.getByRole("listitem", { name: LEGACY });
  await expect(row.getByRole("button", { name: `Edit ${LEGACY}` })).toBeVisible();
  await expect(row.getByRole("button", { name: "Sync now" })).toBeVisible();
});

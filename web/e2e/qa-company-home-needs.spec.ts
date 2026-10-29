import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on Home's Needs you (Detailed): only the actions a role can take (qa-company-3,
 * qa-shell-1), the same action as the Inbox or one Open (qa-company-10), the approvals chip
 * named for what it counts (qa-shell-6, qa-company-13), count chips that go to the Inbox
 * (qa-company-40), no section key beside the item (qa-company-41), and no stray dash on the
 * "more" line (qa-company-42).
 */

async function openHome(page: Page, role?: "viewer" | "commenter" | "approver") {
  await login(page, role ? `${role}@example.com` : undefined);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
  // qa-company-4: a viewer or commenter may have nothing waiting at all, so only an owner's rows are awaited.
  if (!role || role === "approver")
    await expect(page.getByTestId("home-needs-table").locator("tr[data-row]").first()).toBeVisible();
}

const lines = (page: Page) => page.getByTestId("home-needs-table").locator("tr[data-row]");

test("the approvals chip says Approvals, and the Inbox link opens the Inbox", async ({ page }) => {
  await openHome(page);
  const needs = page.getByTestId("home-needs");
  await expect(needs.getByTestId("home-count-approvals")).toHaveText("Approvals 3");
  await expect(needs.getByText(/^Decisions \d/)).toHaveCount(0);
  // qa-company-5: the counts are plain counts (the Inbox has no view per kind); the Inbox link opens it.
  await needs.getByTestId("home-inbox-link").click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("an overrun is one Open on Home, as the Inbox's run page holds Resume and Cancel run", async ({ page }) => {
  await openHome(page);
  const overrun = lines(page).filter({ hasText: "$14.20 / $9.00" });
  await expect(overrun.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", /^\/runs\//);
  await expect(overrun.getByRole("link", { name: "Decide" })).toHaveCount(0);
  // The cost approval is the Inbox's own Approve.
  await expect(lines(page).filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" })).toBeVisible();
});

test("the more line has no age and no dash; items carry no section key", async ({ page }) => {
  await openHome(page);
  const more = lines(page).filter({ has: page.getByTestId("home-needs-more") });
  await expect(more).toHaveCount(1);
  await expect(more).not.toContainText("–");
  const table = page.getByTestId("home-needs-table");
  await expect(table).not.toContainText(/#s-\d/);
  await expect(table).not.toContainText("–");
});

for (const role of ["viewer", "commenter"] as const) {
  test(`a ${role}'s Needs you offers no Approve, Resume or Accept`, async ({ page }) => {
    await openHome(page, role);
    await page.waitForTimeout(1000);
    const table = page.getByTestId("home-needs-table");
    await expect(table.getByRole("button", { name: /^(Approve|Resume|Cancel run|Accept)\b/ })).toHaveCount(0);
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("an item's text is not cut to a word by a chip", async ({ page }) => {
    await openHome(page);
    const approval = lines(page).filter({ hasText: "$53.00 est." });
    await expect(approval.getByText("Start run", { exact: true })).toBeVisible();
    await expect(approval.getByRole("button", { name: "Approve $53.00" })).toBeVisible();
  });
});

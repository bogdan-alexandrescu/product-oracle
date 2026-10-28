import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on /runs: a row's action shows only to a person who may take it (qa-shell-1),
 * and runs are named by their document and flow, never a slug or a short id (qa-shell-32).
 */

async function openRuns(page: Page, role?: "viewer" | "commenter" | "approver") {
  await login(page, role ? `${role}@example.com` : undefined);
  await page.goto("/runs");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
  await expect(page.getByTestId("run-row")).toHaveCount(5);
}

const run = (page: Page, slug: string) => page.locator(`[data-testid="run-row"][data-document="${slug}"]`);

for (const role of ["viewer", "commenter"] as const) {
  test(`a ${role} sees no Approve, Decide or Resume on the runs list`, async ({ page }) => {
    await openRuns(page, role);
    const table = page.getByTestId("runs-table");
    await expect(run(page, "usage-alerts-v2")).toContainText("Awaiting cost approval");
    await expect(run(page, "team-workspaces")).toContainText("Paused: over budget");
    // Give the inbox (whose checkpoints say who decides) time to answer before counting buttons.
    await page.waitForTimeout(1000);
    await expect(table.getByRole("button", { name: /^(Approve|Decide|Resume|Review|Cancel run)$/ })).toHaveCount(0);
    // Each run still opens from its name.
    await expect(run(page, "team-onboarding").getByRole("link").first()).toHaveAttribute("href", /^\/runs\//);
  });
}

test("an approver is not offered a cost approval, an owner's call", async ({ page }) => {
  await openRuns(page, "approver");
  await expect(run(page, "usage-alerts-v2")).toContainText("Awaiting cost approval");
  await page.waitForTimeout(1000);
  await expect(run(page, "usage-alerts-v2").getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("an owner gets each row's action", async ({ page }) => {
  await openRuns(page);
  await expect(run(page, "usage-alerts-v2").getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(run(page, "team-workspaces").getByRole("button", { name: "Decide" })).toBeVisible();
  await expect(run(page, "team-onboarding").getByRole("button", { name: "Decide" })).toBeVisible();
});

test("runs are named by document and flow, with no slug or short id", async ({ page }) => {
  await openRuns(page);
  const table = page.getByTestId("runs-table");
  await expect(run(page, "team-onboarding").getByRole("link").first()).toHaveText("Team onboarding PRD · Baseline to PRD");
  await expect(run(page, "team-workspaces").getByRole("link").first()).toHaveText("Team workspaces PRD");
  await expect(table).not.toContainText("team-onboarding");
  await expect(table).not.toContainText("usage-alerts-v2");
  await expect(table.getByRole("columnheader", { name: "Run" })).toHaveCount(0);
  await run(page, "team-workspaces").getByTestId("run-status").click();
  const inspector = page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
  await expect(inspector).toContainText("Run · selected");
  await expect(inspector).not.toContainText(/Run [0-9a-f]{4}\b/);
  await expect(inspector.getByRole("heading", { name: "Team workspaces PRD" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a viewer's stacked rows carry no action they cannot take", async ({ page }) => {
    await openRuns(page, "viewer");
    await page.waitForTimeout(1000);
    await expect(page.getByTestId("runs-table").getByRole("button", { name: /^(Approve|Decide)$/ })).toHaveCount(0);
    await expect(run(page, "usage-alerts-v2").locator('td[data-phone="title"]')).toHaveText("Usage alerts v2 PRD · Baseline to PRD");
  });
});

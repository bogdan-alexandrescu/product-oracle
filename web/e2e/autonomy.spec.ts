import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * H11 Autonomy, driven through the UI on the mock layer as an owner would (acceptance 10).
 * Each test's card: protects=...; fails_when=...; no_claim=...
 */

async function openAutonomy(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page).toHaveURL(/\/settings\/autonomy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
}

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) =>
  row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// protects=10a: the five groups, and the vision's locked steps with the "Stays with people" tooltip;
// fails_when=a group is missing, or Recommend/Act on "Draft the vision" can be pressed;
// no_claim=the API's 422 (pytest covers it).
test("autonomy: an owner sees the five groups and the vision locked at Draft", async ({ page }) => {
  await openAutonomy(page);
  await expect(page.getByText("How far Oracle goes on its own. You can change this any time.")).toBeVisible();
  for (const name of ["Knowledge", "Planning", "Documents", "Operating", "Outside the company"]) {
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("autonomy-group-planning").getByTestId("autonomy-row-vision")).toContainText("Draft the vision");
  for (const label of ["Recommend", "Act"]) {
    const locked = step(page, "vision", label);
    await expect(locked).toBeDisabled();
    await expect(locked).toHaveAttribute("title", /^Stays with people: /);
  }
  await expect(step(page, "vision", "Draft")).toHaveAttribute("aria-pressed", "true");
  await expect(step(page, "vision", "Observe")).toBeEnabled();
  const stays = page.getByTestId("autonomy-stays");
  await expect(stays).toContainText("Stays with people");
  await expect(stays.getByRole("listitem")).toHaveCount(6);
  await expect(stays.getByRole("button")).toHaveCount(0);
});

// protects=10b: an owner sets "Order priorities" to Act with a 2-place limit and a reason, and the row
// shows the new limit and the "Takes effect when ..." chip; fails_when=the sheet saves without a reason,
// the limit is not kept, or the chip is missing; no_claim=C9's own reordering.
test("autonomy: an owner sets Order priorities to Act within 2 places, with a reason", async ({ page }) => {
  await openAutonomy(page);
  const priorities = row(page, "priorities");
  await expect(priorities.getByTestId("autonomy-sentence")).toHaveText("Oracle proposes an order; a person saves it.");
  await step(page, "priorities", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Order priorities" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("autonomy-from")).toContainText("Oracle proposes an order; a person saves it.");
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Oracle reorders within one goal");
  await expect(sheet.getByText("Within one goal (fixed)")).toBeVisible();
  const save = sheet.getByRole("button", { name: "Save" });
  await sheet.getByLabel("Most places moved").fill("2");
  await expect(save).toBeDisabled(); // the Why is required
  await sheet.getByLabel("Why").fill("Small moves are fine");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Oracle follows this from now on." })).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(step(page, "priorities", "Act")).toHaveAttribute("aria-pressed", "true");
  await expect(priorities.getByTestId("autonomy-limits")).toHaveText("within one goal, up to 2 places");
  await expect(priorities.getByTestId("autonomy-pending")).toHaveText("Takes effect when C9 Priorities move and pin ships");
  // Kept across a reload.
  await page.reload();
  await expect(row(page, "priorities").getByTestId("autonomy-limits")).toHaveText("within one goal, up to 2 places");
});

// protects=10c: an approver reads the page, View only, with no level picker (#370: hidden, not disabled);
// fails_when=an approver sees a level button or the owner-only note; no_claim=the API's 403 (pytest covers it).
test("autonomy: an approver reads the levels with no controls", async ({ page }) => {
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "approver"] as const);
  await openAutonomy(page);
  await expect(page.getByTestId("view-only")).toHaveText("View only");
  await expect(page.getByTestId("autonomy-owner-only")).toHaveCount(0);
  await expect(row(page, "priorities")).toContainText("Order priorities");
  await expect(page.getByTestId(/^autonomy-row-/).getByRole("group").getByRole("button")).toHaveCount(0);
});

// protects=10d: a seeded "Oracle did" row opens, moves to Done, and the rail badge drops by 1;
// fails_when=Open leaves it counted or the badge does not change; no_claim=any pick acting on its own.
test("autonomy: an Oracle did row in the Inbox opens and the badge drops by one", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "oracle-did"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.goto("/inbox");
  const badge = page.getByTestId("nav-inbox-badge");
  await expect(badge).toHaveText(/^\d+$/);
  const before = Number(await badge.textContent());
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Saved addresses" });
  await expect(did).toContainText("Oracle did");
  await expect(did).toContainText("Moved 'Saved addresses' up 2 within Raise activation");
  await expect(did.getByRole("button", { name: "Undo" })).toBeVisible();
  await did.getByRole("button", { name: "Open" }).click();
  await expect(badge).toHaveText(String(before - 1));
  await page.getByRole("tab", { name: /^Done/ }).click();
  await expect(page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Saved addresses" })).toBeVisible();
  await page.reload();
  await expect(badge).toHaveText(String(before - 1));
});

// protects=10e: at 390 px every row's control stays on one line with no horizontal scroll;
// fails_when=a control wraps or the page scrolls sideways; no_claim=other widths.
test("autonomy: at 390 px every control fits on one line, no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/settings/autonomy");
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  const groups = page.getByTestId(/^autonomy-row-/).getByRole("group");
  await expect(groups).toHaveCount(16); // H7 adds Watch the market
  for (const g of await groups.all()) {
    await g.scrollIntoViewIfNeeded();
    const tops = await g.getByRole("button").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const fits = await g.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
  }
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

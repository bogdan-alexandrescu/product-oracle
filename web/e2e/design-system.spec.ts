import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/** The kit page (/design) is the fixture: its samples carry stable data-testids. */
async function openKit(page: Page) {
  await login(page);
  await page.goto("/design");
  // The kit renders once GET /v1/me says owner; the page is large, so allow a slow first render.
  await expect(page.getByTestId("design-gallery")).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ timeout: 60_000 });

test("/design: an owner sees the kit, and it is not in the navigation", async ({ page }) => {
  await openKit(page);
  await expect(page.getByRole("heading", { name: "Design system (developers)", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
  // Not in the navigation.
  await expect(page.getByRole("navigation", { name: "Oracle" }).locator('a[href="/design"]')).toHaveCount(0);
});

test("/design: the Brand card draws the mark, compact cut, tab icon and wordmark on light, dark and navy", async ({ page }) => {
  await openKit(page);
  for (const ground of ["light", "dark", "navy"]) {
    const g = page.getByTestId(`design-brand-${ground}`);
    await expect(g.getByRole("img", { name: "Full mark, 44 px" }).locator("line")).toHaveCount(4);
    // Under 24 px the compact cut: no ticks.
    await expect(g.getByRole("img", { name: "Compact mark, 16 px" }).locator("line")).toHaveCount(0);
    await expect(g).toContainText("Product Oracle");
  }
});

test("/design: a viewer sees only its title", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/design");
  await expect(page.getByRole("heading", { name: "Design system (developers)", exact: true })).toBeVisible();
  await expect(page.getByTestId("design-gallery")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Theme" })).toHaveCount(0);
});

test("DataTable: click selects, arrow keys, Home and End move the selection and focus, Enter activates", async ({ page }) => {
  await openKit(page);
  const table = page.getByTestId("design-table");
  const rows = table.locator("tr[data-row]");
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);

  // The selected row is the table's one tab stop.
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(rows.nth(1)).toHaveAttribute("tabindex", "-1");

  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(rows.nth(1)).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(2)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");

  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toBeFocused();

  await page.keyboard.press("End");
  await expect(rows.nth(count - 1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(count - 1)).toBeFocused();
  // ArrowDown on the last row stays there.
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(count - 1)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toBeFocused();
  await expect(table.locator('tr[aria-selected="true"]')).toHaveCount(1);

  // The inspector follows the selection.
  await expect(page.getByTestId("design-inspector").getByRole("heading", { level: 2 })).toHaveText("Clinic check-in kiosk");

  await expect(page.getByTestId("design-table-opened")).toHaveText("Enter opens");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("design-table-opened")).toHaveText("Opened Clinic check-in kiosk");

  // Tab reaches the table at the selected row (roving tabindex), right after the header sample's button.
  await page.keyboard.press("End");
  await page.getByTestId("design-page-header").getByRole("button", { name: "Approve r4" }).focus();
  await page.keyboard.press("Tab");
  await expect(rows.nth(count - 1)).toBeFocused();
});

test("InfoTip: focus opens it, Escape closes, click pins it, a click outside closes, hover opens", async ({ page }) => {
  await openKit(page);
  const wrap = page.getByTestId("design-infotip");
  const button = wrap.getByRole("button", { name: "About confidence" });
  const tip = wrap.locator('[role="tooltip"]');

  // Named by aria-describedby, and in the DOM while closed.
  const tipId = await tip.getAttribute("id");
  expect(tipId).toBeTruthy();
  await expect(button).toHaveAttribute("aria-describedby", tipId!);
  await expect(button).toHaveAccessibleDescription(/How sure the Oracle is/);
  await expect(tip).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  // Keyboard focus opens it; Escape closes it.
  await button.focus();
  await expect(tip).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await button.blur();

  // A click pins it open, even once the pointer leaves.
  await button.click();
  await expect(tip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tip).toBeVisible();
  // A click outside closes it.
  await page.getByTestId("design-header").click({ position: { x: 5, y: 5 } });
  await expect(tip).toBeHidden();

  // Hover opens it; leaving closes it.
  await button.hover();
  await expect(tip).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
});

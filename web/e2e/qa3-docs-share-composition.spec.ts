import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 3 (docs lane), the Composition screen of a PRD (qa-docs-41 … 49). The mock leaves
 * saved-carts without a composition (Oracle's recommendation only, Value and cost economics
 * left out because its condition does not hold) and seeds checkout-redesign with revision 1.
 */

const OWNER = "admin@example.com";
const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

async function open(page: Page, email: string, slug = "saved-carts", tab?: string) {
  await login(page, email);
  await page.goto(`/documents/${slug}/composition${tab ? `?tab=${tab}` : ""}`);
  await expect(page.getByRole("heading", { level: 1, name: "Composition" })).toBeVisible();
}

const modules = (page: Page) => page.getByTestId("composition-modules");
const row = (page: Page, key: string) => modules(page).locator(`[data-module="${key}"]`);
const tabs = (page: Page) => page.getByRole("group", { name: "Composition views" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-41: a module its condition left out does not say the document needs it", async ({ page }) => {
    await open(page, VIEWER);
    const value = row(page, "economics.value");
    await expect(value).toContainText("Excluded");
    await expect(value).not.toContainText("This document needs it");
    await expect(value).toContainText("This document doesn't need it");
  });

  test("qa-docs-42: the State pills keep the table's right padding", async ({ page }) => {
    await open(page, VIEWER);
    await expect(row(page, "economics.value")).toBeVisible();
    for (const key of ["economics.value", "decision.executive"]) {
      const cell = row(page, key).locator("td").last();
      const pill = cell.locator("[data-kind]");
      await expect(pill).toBeVisible();
      const c = (await cell.boundingBox())!;
      const p = (await pill.boundingBox())!;
      // The cell's own right padding is 16 px: the pill ends inside it, never at the edge.
      expect(p.x + p.width).toBeLessThanOrEqual(c.x + c.width - 12);
      expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  });

  test("qa-docs-43: what the table shows is a status chip, not a bare label", async ({ page }) => {
    await open(page, VIEWER);
    const source = page.getByTestId("composition-source");
    await expect(source).toHaveText("Recommendation, not in force");
    await expect(source).toHaveAttribute("data-kind", "line");
  });

  test("qa-docs-44: Modules and Catalog say Required and When it applies; the tab is Company policy", async ({ page }) => {
    await open(page, VIEWER);
    const filters = page.getByRole("group", { name: "Filter modules" });
    await expect(filters.getByRole("button", { name: /^Required/ })).toBeVisible();
    await expect(filters).not.toContainText("Mandatory");
    await expect(modules(page)).not.toContainText("Mandatory");
    await expect(row(page, "economics.value")).toContainText("When it applies");
    await expect(tabs(page).getByRole("link", { name: "Company policy", exact: true })).toBeVisible();
    await tabs(page).getByRole("link", { name: "Catalog", exact: true }).click();
    await expect(page.getByTestId("catalog-table").locator('[data-module="economics.value"]')).toContainText("When it applies");
  });

  test("qa-docs-45: the default packs count the packs shown; plain intro; Save waits for a change", async ({ page }) => {
    await open(page, OWNER, "saved-carts", "policy");
    const board = page.getByTestId("policy-board");
    await expect(board).toBeVisible();
    const packs = board.getByRole("region", { name: "Default packs" });
    const chips = packs.locator("button[aria-pressed]");
    const n = await chips.count();
    expect(n).toBeGreaterThan(0);
    await expect(packs).toContainText(`0 of ${n} chosen`);
    await expect(board).not.toContainText("Saving changes no composition in force");
    await expect(board).toContainText("Saving the policy does not change any PRD's modules right away.");
    const save = page.getByRole("button", { name: "Save policy" });
    await expect(save).toBeDisabled();
    // A pack turned on and off again leaves nothing to save.
    await chips.first().click();
    await expect(packs).toContainText(`1 of ${n} chosen`);
    await expect(save).toBeEnabled();
    await chips.first().click();
    await expect(packs).toContainText(`0 of ${n} chosen`);
    await expect(save).toBeDisabled();
  });

  test("qa-docs-46: an empty History says how a revision is made", async ({ page }) => {
    await open(page, VIEWER, "saved-carts", "history");
    await expect(page.getByTestId("history-empty")).toContainText("No revisions yet");
    await expect(page.getByTestId("history-empty")).toContainText("Use these modules");
  });

  test("qa-docs-47: Confirm revision 1 has a primary button, room under Save as, and '+' beside its heading", async ({ page }) => {
    await open(page, APPROVER);
    await page.getByRole("button", { name: "Use these modules" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm revision 1" });
    await dialog.getByLabel("Reason (required)").fill("First composition.");
    const confirm = dialog.getByRole("button", { name: "Confirm revision 1", exact: true });
    await expect(confirm).toHaveAttribute("data-variant", "primary");
    await expect(confirm).toBeEnabled();

    const label = dialog.getByText("Save as", { exact: true });
    const toggle = dialog.getByRole("group", { name: "Save as" });
    const l = (await label.boundingBox())!;
    const t = (await toggle.boundingBox())!;
    expect(l.y + l.height).toBeLessThanOrEqual(t.y);

    const fresh = dialog.locator('li[data-new="1"]');
    await expect(fresh.first()).toBeVisible();
    const count = await fresh.count();
    for (let i = 0; i < count; i++) {
      const plus = (await fresh.nth(i).locator('[aria-label="new"]').boundingBox())!;
      const heading = (await fresh.nth(i).locator("span.font-medium").boundingBox())!;
      // The "+" starts the heading's first line, never a line of its own.
      expect(Math.abs(plus.y - heading.y)).toBeLessThanOrEqual(4);
    }
  });

  test("qa-docs-48: a previewed recommendation says it is a preview", async ({ page }) => {
    await open(page, VIEWER, "checkout-redesign");
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await page.getByRole("button", { name: "Preview recommendation" }).click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toContainText("Preview.");
    await expect(banner).toContainText("Nothing is saved.");
    await banner.getByRole("button", { name: "Close preview" }).click();
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await expect(page.getByTestId("composition-source")).toContainText("Confirmed revision 1");
  });

  test("qa-docs-49: a viewer gets one plain banner", async ({ page }) => {
    await open(page, VIEWER);
    await expect(page.getByTestId("legacy-notice")).toContainText("Only an approver can confirm them.");
    await expect(page.getByTestId("read-only")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Preview writes nothing");
  });

  test("qa-docs-49: on a PRD with a composition the viewer's banner is plain", async ({ page }) => {
    await open(page, VIEWER, "checkout-redesign");
    await expect(page.getByTestId("read-only")).toHaveText("You can look at this composition and preview a recommendation. Only an approver can change or publish it.");
    await expect(page.getByTestId("legacy-notice")).toHaveCount(0);
  });

  test("qa-docs-43, qa-docs-48: the source chip and the preview banner show in dark", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page, VIEWER, "checkout-redesign");
    await page.getByRole("button", { name: "Preview recommendation" }).click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toBeVisible();
    const [fg, bg] = await banner.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    expect(fg).not.toBe(bg);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-44: the phone's tab is Company policy too, and in view", async ({ page }) => {
    await open(page, VIEWER);
    const link = tabs(page).getByRole("link", { name: "Company policy", exact: true });
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(tabs(page).getByRole("link", { name: "Policy", exact: true })).toHaveCount(0);
  });

  test("qa-docs-49: a viewer gets one plain banner on a phone", async ({ page }) => {
    await open(page, VIEWER);
    await expect(page.getByTestId("legacy-notice")).toBeVisible();
    await expect(page.getByTestId("read-only")).toHaveCount(0);
  });
});

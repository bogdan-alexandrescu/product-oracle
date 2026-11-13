import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on /priorities, round 2, driven through the UI on the mock layer as a person would.
 * Oracle's goal-weighted order: #1 Address lookup service (F-5), #2 Shipping cost shown in the
 * cart (F-2), #3 Saved addresses at checkout (F-1), #4 Bulk export (F-7), #5 Scheduled exports
 * (F-8), #6 Usage alerts (F-4), #7 Shared projects (F-3), #8 Dark mode (F-6).
 */

const APPROVER = "approver@example.com";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const rowOf = (page: Page, key: string) => page.getByTestId(`priority-row-${key}`);
const rows = (page: Page) => page.locator('tr[data-testid^="priority-row-"]');

async function open(page: Page, email = APPROVER) {
  await login(page, email);
  await page.goto("/priorities");
  await expect(rows(page)).toHaveCount(8);
}

async function press(page: Page, key: string, name: "Move up" | "Move down") {
  const row = rowOf(page, key);
  await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const button = row.getByRole("button", { name, exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-plan-5: every feature name reads in full beside the docked inspector", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("priority-inspector")).toBeVisible();
    for (const key of ["F-5", "F-2", "F-1", "F-8"]) {
      const name = rowOf(page, key).locator("td button[aria-controls]");
      await expect(name).toBeVisible();
      const m = await name.evaluate((e) => ({
        sw: e.scrollWidth,
        cw: e.clientWidth,
        ellipsis: getComputedStyle(e).textOverflow === "ellipsis" && getComputedStyle(e).overflow !== "visible",
      }));
      expect(m.sw, `${key}: the name is cut`).toBeLessThanOrEqual(m.cw + 1);
      expect(m.ellipsis, `${key}: the name ends in …`).toBe(false);
    }
    // The Feature column has room for a word of the names (wider than the Flags column's leftovers).
    const cell = rowOf(page, "F-5").locator("td").filter({ has: page.locator("button[aria-controls]") });
    expect((await cell.boundingBox())!.width).toBeGreaterThan(130);
  });

  test("qa-plan-6: ▼ on #7 never opens a pin; it says why it cannot move below the last row", async ({ page }) => {
    await open(page);
    const down = rowOf(page, "F-3").getByRole("button", { name: "Move down", exact: true });
    await expect(down).toBeVisible();
    await expect(down).toBeDisabled();
    await expect(down).toHaveAttribute("title", /Dark mode is last/);
    // #6 ▼ is the usual Move dialog: below the next row.
    await press(page, "F-4", "Move down");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Move below Shared projects");
    await expect(dialog.getByLabel("Rank")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("qa-plan-15: ▼ on #1 says Move below the next feature", async ({ page }) => {
    await open(page);
    await press(page, "F-5", "Move down");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("move-target")).toHaveText("Move below Shipping cost shown in the cart");
    await expect(dialog).not.toContainText("Move above Saved addresses at checkout");
  });

  test("qa-plan-16: the evidence picker says how many may be picked; each item's score is a percent", async ({ page }) => {
    await open(page);
    await press(page, "F-1", "Move up");
    const picker = page.getByRole("dialog").getByRole("group", { name: "Cite evidence (optional)" });
    await expect(picker.getByTestId("cited-count")).toHaveText("Pick up to 5");
    await expect(picker).not.toContainText("0 of 5");
    const chip = picker.getByTestId("evidence-chip").filter({ hasText: "Interview 07" });
    await expect(chip.getByTitle("Confidence", { exact: true })).toHaveText("80%");
    await picker.getByRole("checkbox").first().check();
    await expect(picker.getByTestId("cited-count")).toHaveText("1 picked, up to 5");
  });

  test("qa-plan-17: features by name only: no codes in the cycle, the inspector or Moved for", async ({ page }) => {
    await open(page);
    const banner = page.getByTestId("cycles-banner");
    await expect(banner).toContainText("Bulk export → Scheduled exports");
    await expect(banner).not.toContainText(/F-\d/);
    await rowOf(page, "F-5").getByRole("button", { name: "Address lookup service" }).click();
    const inspector = page.getByTestId("priority-inspector");
    await expect(page.getByTestId("explanation-F-5")).toBeVisible();
    const movedFor = inspector.locator("li", { hasText: "Moved for" });
    await expect(movedFor).toContainText("Shipping cost shown in the cart");
    await expect(inspector).not.toContainText(/\bF-\d/);
  });

  test("qa-plan-18: every score has one precision per method, right-aligned", async ({ page }) => {
    await open(page);
    const methods = page.getByRole("radiogroup", { name: "Ranking method" });
    for (const method of ["Goal-weighted", "RICE", "WSJF"]) {
      await methods.getByRole("radio", { name: method }).click();
      await expect(methods.getByRole("radio", { name: method })).toHaveAttribute("aria-checked", "true");
      await expect(rows(page)).toHaveCount(8);
      const scores = rows(page).getByTestId("score");
      // fix4 qa-plan-50: RICE scores are whole numbers; the others keep two decimals.
      const shape = method === "RICE" ? /^(—|\d{1,3}(,\d{3})*)$/ : /^(—|\d{1,3}(,\d{3})*\.\d\d)$/;
      for (const t of await scores.allInnerTexts()) expect(t.trim(), method).toMatch(shape);
      const rights = await scores.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
      expect(Math.max(...rights) - Math.min(...rights), `${method}: scores share a right edge`).toBeLessThanOrEqual(1);
    }
    await methods.getByRole("radio", { name: "Goal-weighted" }).click();
    await expect(rowOf(page, "F-2").getByTestId("score")).toHaveText("8.10");
  });

  test("qa-plan-19: ▲ ▼ ⋯ show on every row without pointing at it", async ({ page }) => {
    await open(page);
    await page.mouse.move(0, 0);
    for (const key of ["F-2", "F-4", "F-6"]) {
      const row = rowOf(page, key);
      await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await page.mouse.move(0, 0);
      await expect(row.getByRole("button", { name: "Move up", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "More actions" })).toBeVisible();
    }
  });

  test("qa-plan-20: Save snapshot sits in the Snapshots panel; empty lists say how", async ({ page }) => {
    await open(page);
    const panel = page.getByTestId("snapshots-panel");
    await expect(panel.getByTestId("snapshot-save").getByRole("button", { name: "Save snapshot" })).toBeVisible();
    await expect(panel.getByTestId("snapshots-empty")).toHaveText(
      "No snapshots yet. Save one above to keep this order and compare it later.",
    );
    await expect(page.getByTestId("changes-empty")).toContainText("move or pin a feature");
    await panel.getByLabel("Snapshot note (optional)").fill("Before planning");
    await panel.getByRole("button", { name: "Save snapshot" }).click();
    await expect(panel.getByRole("status")).toContainText("Snapshot saved");
    await expect(panel.getByTestId("snapshot-list")).toContainText("Before planning");
  });

  for (const role of ["viewer", "commenter"]) {
    test(`qa-plan-22: a ${role} keeps the Order view switch, no write controls`, async ({ page }) => {
      await open(page, `${role}@example.com`);
      const order = page.getByRole("radiogroup", { name: "Order" });
      await expect(order).toBeVisible();
      await order.getByRole("radio", { name: "Oracle's order" }).click();
      await expect(order.getByRole("radio", { name: "Oracle's order" })).toHaveAttribute("aria-checked", "true");
      await expect(rows(page)).toHaveCount(8);
      await expect(page.getByTestId("row-actions")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save snapshot" })).toHaveCount(0);
    });
  }

  test("qa-plan-33: in the light theme the selected feature's head is on the card surface", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("oracle-theme", "light"));
    await open(page);
    const inspector = page.getByTestId("priority-inspector");
    await expect(inspector).toBeVisible();
    const head = await inspector.locator(":scope > div").first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const card = await page.getByTestId("snapshots-panel").evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(head).toBe(card);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-plan-21: the ranking comes first; the formula's (i) sits beside the method switch", async ({ page }) => {
    await open(page);
    const table = (await page.getByTestId("priority-table").boundingBox())!;
    const saveBox = (await page.getByTestId("snapshot-save").boundingBox())!;
    expect(saveBox.y, "Save snapshot sits below the ranking").toBeGreaterThan(table.y + table.height - 1);
    const tip = (await page.getByRole("button", { name: "About Formula" }).first().boundingBox())!;
    const methods = (await page.getByRole("radiogroup", { name: "Ranking method" }).boundingBox())!;
    expect(Math.abs(tip.y + tip.height / 2 - (methods.y + methods.height / 2)), "on the method switch's line").toBeLessThan(12);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });
});

import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Review of the fix-plan lane, the three majors, through the UI on the mock layer:
 * - Priorities at a laptop's width (1440, the owner's 1512) with the inspector docked keeps
 *   Confidence and Depends on, and the feature's name keeps its room.
 * - Baseline's Goals table keeps Metric at 1440; Weight and Features go first.
 * - qa-plan-20: a row below a feature a person moved says who moved it, never a dependency.
 */

const APPROVER = "approver@example.com";
const rowOf = (page: Page, key: string) => page.getByTestId(`priority-row-${key}`);
const rows = (page: Page) => page.locator('tr[data-testid^="priority-row-"]');

async function notCut(el: Locator) {
  const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  expect(m.sw, "cut sideways").toBeLessThanOrEqual(m.cw + 1);
}

for (const width of [1440, 1512]) {
  test(`priorities at ${width}: Confidence and Depends on stay beside the docked inspector`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, APPROVER);
    await page.goto("/priorities");
    await expect(rows(page).first()).toBeVisible();
    await rowOf(page, "F-5").getByRole("button", { name: "Address lookup service" }).click();
    await expect(page.getByTestId("explanation-F-5")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Confidence" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Depends on" })).toBeVisible();
    const deps = rowOf(page, "F-2").getByTestId("row-deps");
    await expect(deps).toBeVisible();
    await expect(deps).toHaveText("Address lookup service");
    await notCut(deps);
    const name = rowOf(page, "F-5").getByRole("button", { name: "Address lookup service" });
    expect((await name.boundingBox())!.width).toBeGreaterThan(80);
    // The table fits its panel: nothing pushed off its right edge.
    await notCut(page.locator("table").first());
  });
}

test("baseline at 1440: the Goals table keeps Metric; Weight and Features go first", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByTestId("goal-g.activation")).toBeVisible();
  const table = page.getByRole("grid", { name: "Goals" });
  await expect(table.getByRole("columnheader", { name: "Metric" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Weight" })).toBeHidden();
  const goal = table.getByTestId("goal-g.activation").locator("td").first();
  expect((await goal.boundingBox())!.width).toBeGreaterThan(180);
});

test("qa-plan-20: a row below a feature a person moved says who moved it, not a dependency", async ({ page }) => {
  await login(page, APPROVER);
  await page.goto("/priorities");
  await expect(rows(page).first()).toBeVisible();
  const row = rowOf(page, "F-1");
  await row.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await row.hover();
  await row.getByRole("button", { name: "Move up", exact: true }).click();
  const s = page.getByRole("dialog");
  await s.getByLabel("Why?").fill("A launch partner needs it in the first release");
  await s.getByRole("button", { name: "Save", exact: true }).click();
  await expect(s).toBeHidden();
  await expect(row.getByTestId("override-chip")).toHaveText("Moved by Approver");
  const why = rowOf(page, "F-2").getByTestId("rank-reason");
  await expect(why.first()).toBeVisible();
  await expect(rowOf(page, "F-2").getByTestId("row-flags")).toContainText("moved by Approver");
  await expect(rowOf(page, "F-2").getByTestId("row-flags")).not.toContainText("dependency");
});

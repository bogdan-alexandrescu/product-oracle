import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 2 on /sources (rirs-38, 39), driven through the UI on the mock.
 */

async function openCoverage(page: Page) {
  await login(page);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
  await expect(page.getByTestId("coverage-inspector")).toBeVisible();
}

test("rirs-38: at 1440 px the Settings tabs stay on one row, Trash not alone below", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCoverage(page);
  const links = page.getByTestId("settings-nav").getByRole("link");
  await expect(links.filter({ hasText: "Trash" })).toHaveCount(1);
  const tops = await links.evaluateAll((as) => as.map((a) => Math.round(a.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
});

test("rirs-39: the coverage counts say what each counts, so Items, Not read and Used need not add up", async ({ page }) => {
  await openCoverage(page);
  const note = page.getByTestId("coverage-counts-note");
  await expect(note).toContainText("Items read: what Oracle holds from the source.");
  await expect(note).toContainText("counted apart from the items");
  await expect(note).toContainText("one item can be used more than once");
  const table = page.getByTestId("coverage-table");
  await expect(table.getByRole("columnheader", { name: "Items read" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Not read" }).locator("[title]")).toHaveAttribute("title", /counted apart from the items/);
  await expect(table.getByRole("columnheader", { name: "Used" }).locator("[title]")).toHaveAttribute("title", /times its items back evidence/);
});

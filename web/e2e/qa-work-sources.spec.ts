import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/*
 * QA pass on /sources (qa-work-2, 49, 50, 51, 52, 53), driven through the UI on the mock.
 */

const table = (page: Page): Locator => page.getByTestId("coverage-table");
const row = (page: Page, name: string): Locator => table(page).locator("tr[data-row]").filter({ hasText: name });
const inspector = (page: Page): Locator => page.getByTestId("coverage-inspector");

async function openCoverage(page: Page) {
  await login(page);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
  await expect(inspector(page)).toBeVisible();
}

test("qa-work-2: a viewer gets no Sync now or Edit picks, and is told why", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "viewer"), [MOCK_ROLE_KEY] as const);
  await openCoverage(page);
  await expect(inspector(page).getByTestId("sync-viewer-note")).toBeVisible();
  await expect(inspector(page).getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await expect(inspector(page).getByRole("link", { name: "Edit picks" })).toHaveCount(0);
});

test("qa-work-2: Sync now says it started and finished, and Synced reads now", async ({ page }) => {
  await openCoverage(page);
  const synced = row(page, "Product chat").getByTestId("coverage-synced");
  await expect(synced).not.toHaveText("now");
  await inspector(page).getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Product chat synced")).toBeVisible();
  await expect(synced).toHaveText("now");
});

test("qa-work-49: the Kind filter and the selected result name kinds in words", async ({ page }) => {
  await openCoverage(page);
  const kind = page.getByLabel("Kind", { exact: true });
  for (const label of ["Messages", "Pull requests", "READMEs"]) {
    await expect(kind.locator("option", { hasText: label })).toHaveCount(1);
  }
  await expect(kind.locator("option", { hasText: /^pull request$|^pull_request$/ })).toHaveCount(0);
  await kind.selectOption({ label: "Messages" });
  await page.getByLabel("Search", { exact: true }).fill("annual pricing");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByTestId("search-hit").filter({ hasText: "Pricing thread" }).getByRole("button", { name: "Pricing thread" }).click();
  const hit = page.getByTestId("hit-inspector");
  await expect(hit).toContainText("Message · selected");
  await expect(hit).not.toContainText("message · selected");
});

test("qa-work-50: Fresh reads '50% fresh' with its counts on hover; one dash; short ages", async ({ page }) => {
  await openCoverage(page);
  const fresh = row(page, "Product chat").getByTestId("coverage-fresh");
  await expect(fresh).toHaveText("50% fresh");
  await expect(fresh).toHaveAttribute("title", /1 of 2 items fresh/);
  await expect(row(page, "Legacy all-hands chat").getByTestId("coverage-fresh")).toHaveText("—");
  const ages = await table(page).getByTestId("coverage-synced").allTextContents();
  for (const age of ages) expect(age).toMatch(/^(now|Never|\d+(m|h|d|w|mo|y))$/);
});

test("qa-work-51: on a desktop the inspector says why an item was not read", async ({ page }) => {
  await openCoverage(page);
  const entry = inspector(page).getByRole("list", { name: "Not read" }).getByRole("listitem");
  await expect(entry.getByTestId("not-read-reason")).toBeVisible();
  await expect(entry.getByTestId("not-read-reason")).toHaveText("Shared from outside the company");
});

test("qa-work-52: on a phone each coverage card keeps Not read, Used and Synced", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCoverage(page);
  const chat = row(page, "Product chat");
  for (const id of ["coverage-not-read", "coverage-used", "coverage-synced"]) {
    await expect(chat.getByTestId(id)).toBeVisible();
  }
  await expect(chat).toContainText("Not read");
  await expect(chat).toContainText("Used");
  await expect(chat).toContainText("Synced");
  // The reason a skipped item was not read, on the phone too.
  await expect(inspector(page).getByTestId("not-read-reason").first()).toBeVisible();
});

test("qa-work-53: Sources has no Manage link back to Settings in its header", async ({ page }) => {
  await openCoverage(page);
  await expect(page.locator("header[data-page-header]").filter({ visible: true }).getByRole("link", { name: "Manage" })).toHaveCount(0);
});

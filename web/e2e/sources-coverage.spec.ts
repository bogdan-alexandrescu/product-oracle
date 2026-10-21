import { expect, test, type Locator, type Page } from "@playwright/test";

import { login } from "./helpers";

/*
 * A2 Sources coverage, driven through the UI on the mock layer as a person would.
 * Each test states its card: protects / fails_when / no_claim.
 */

const SCENARIO_KEY = "po-mock-scenario";
// Every source name the mock seeds, the owner's and the other members' (Company tab).
const SEEDED_NAMES = [
  "Product chat",
  "Example repo",
  "Legacy all-hands chat",
  "Customer calls",
  "Product docs",
  "Drive folders",
  "Approver drive",
  "Viewer repo",
];

function table(page: Page): Locator {
  return page.getByTestId("coverage-table");
}

function row(page: Page, name: string): Locator {
  return table(page).locator("tr[data-row]").filter({ hasText: name });
}

function inspector(page: Page): Locator {
  return page.getByTestId("coverage-inspector");
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openCoverage(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
}

test("coverage: one row per source with items, a Fresh ring and uses, instead of No search yet", async ({ page }) => {
  // protects=a person sees what Oracle holds from each source before searching
  // fails_when=a source, its item count, Fresh ring or Used count is missing, or "No search yet" stays
  // no_claim=the mock computes coverage like the API (API tests cover it)
  await openCoverage(page);
  await expect(page.getByText("No search yet")).toHaveCount(0);
  await expect(table(page).locator("tr[data-row]")).toHaveCount(6);
  const chat = row(page, "Product chat");
  await expect(chat).toContainText("Slack");
  await expect(chat.getByTestId("coverage-items")).toHaveText("2");
  await expect(chat.getByRole("img", { name: "Fresh 50%" })).toBeVisible();
  await expect(chat.getByTestId("coverage-used")).toHaveText("3");
  await expect(chat.getByTestId("coverage-not-read")).toHaveText("1");
  await expect(row(page, "Legacy all-hands chat").getByTestId("coverage-fresh")).toHaveText("–");
});

test("coverage: the first source is selected; its inspector shows freshness and what was not read", async ({ page }) => {
  // protects=freshness buckets and the left-out entries with their reason
  // fails_when=the bar's counts are wrong, or the skipped entry or its reason is missing
  // no_claim=the API's half-life maths (API tests)
  await openCoverage(page);
  await expect(row(page, "Product chat")).toHaveAttribute("aria-selected", "true");
  const ins = inspector(page);
  await expect(ins.getByRole("heading", { name: "Product chat" })).toBeVisible();
  await expect(ins).toContainText("Source · coverage");
  const fresh = ins.getByTestId("coverage-freshness");
  await expect(fresh.getByTestId("freshness-fresh")).toHaveText(/Fresh\s*1/);
  await expect(fresh.getByTestId("freshness-aging")).toHaveText(/Aging\s*1/);
  await expect(fresh.getByTestId("freshness-stale")).toHaveText(/Stale\s*0/);
  await expect(ins.getByTestId("coverage-kinds")).toContainText("message");

  const notRead = ins.getByRole("list", { name: "Not read" });
  const entry = notRead.getByRole("listitem");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("#partner-launch");
  await expect(entry.getByText("Skipped", { exact: true })).toHaveAttribute("title", "Skipped: shared from outside the company");
});

test("coverage: Used in leads to the baseline item and to the document version", async ({ page }) => {
  // protects=a person reaches the evidence and the documents a source backs
  // fails_when=a use is missing or links to the wrong place
  // no_claim=section links (none seeded)
  await openCoverage(page);
  const used = inspector(page).getByRole("list", { name: "Used in" });
  await expect(used.getByRole("listitem")).toHaveCount(3);
  await used.getByRole("link", { name: /Dark mode/ }).click();
  await expect(page).toHaveURL(/\/baseline\?entity=[0-9a-f-]+$/);
  await expect(page.getByRole("dialog", { name: "Dark mode" })).toBeVisible();

  await page.goBack();
  await used.getByRole("link", { name: /Checkout redesign PRD/ }).click();
  await expect(page).toHaveURL(/\/documents\/checkout-redesign\/v\/2$/);
});

test("coverage: a search shows Results; Coverage brings the table back with the same source", async ({ page }) => {
  // protects=search works as before and Coverage returns to where the person was
  // fails_when=search is broken, or the selection is lost on the way back
  // no_claim=search ranking (sources.spec)
  await openCoverage(page);
  await row(page, "Example repo").click();
  await expect(page).toHaveURL(/\?source=50000000-0000-4000-8000-000000000002$/);
  await page.getByLabel("Search", { exact: true }).fill("pricing");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByRole("region", { name: "Results" });
  await expect(results).toBeVisible();
  await expect(page.getByTestId("search-hit").first()).toBeVisible();
  await expect(table(page)).toHaveCount(0);

  await results.getByRole("button", { name: "Coverage" }).click();
  await expect(row(page, "Example repo")).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("heading", { name: "Example repo" })).toBeVisible();
});

test("coverage: Sync now syncs the source and its row reads synced now", async ({ page }) => {
  // protects=Sync now from the inspector, then fresh coverage
  // fails_when=the row keeps the old sync time
  // no_claim=the connector's sync (API tests)
  await openCoverage(page);
  const synced = row(page, "Product chat").getByTestId("coverage-synced");
  await expect(synced).not.toHaveText("now");
  await inspector(page).getByRole("button", { name: "Sync now" }).click();
  await expect(synced).toHaveText("now");
  await expect(inspector(page).getByRole("link", { name: "Edit picks" })).toHaveAttribute(
    "href",
    "/settings/sources#source-50000000-0000-4000-8000-000000000001",
  );
});

test("coverage: with no sources, Add a source leads to Settings › Sources", async ({ page }) => {
  // protects=the empty state points to where sources are added
  // fails_when=an empty table shows, or the link goes elsewhere
  // no_claim=adding a source (sources.spec)
  await page.goto("/login");
  await page.evaluate((k) => localStorage.setItem(k, "empty"), SCENARIO_KEY);
  await openCoverage(page);
  await expect(page.getByText("No sources yet")).toBeVisible();
  await page.getByRole("link", { name: "Add a source" }).click();
  await expect(page).toHaveURL(/\/settings\/sources$/);
});

test("coverage: Settings › Sources › More › Coverage opens that source", async ({ page }) => {
  // protects=a way from a source's settings to its coverage
  // fails_when=the menu item is missing or opens another source
  // no_claim=the settings row itself (sources.spec)
  await login(page);
  await page.goto("/settings/sources");
  const docs = page.getByRole("listitem", { name: "Product docs" });
  await docs.getByRole("button", { name: "More actions for Product docs" }).click();
  await docs.getByRole("menuitem", { name: "Coverage" }).click();
  await expect(page).toHaveURL(/\/sources\?source=50000000-0000-4000-8000-000000000005$/);
  await expect(row(page, "Product docs")).toHaveAttribute("aria-selected", "true");
  await expect(inspector(page).getByRole("heading", { name: "Product docs" })).toBeVisible();
  // Its not-read entries: skipped and no access.
  await expect(inspector(page).getByRole("list", { name: "Not read" }).getByRole("listitem")).toHaveCount(6);
});

test("coverage at 390 px: Source, Items and Fresh only, the inspector below, no sideways scroll", async ({ page }) => {
  // protects=the phone layout of the table and inspector
  // fails_when=a hidden column shows, the inspector overlaps, or the page scrolls sideways
  // no_claim=tablet widths
  await page.setViewportSize({ width: 390, height: 844 });
  await openCoverage(page);
  const chat = row(page, "Product chat");
  await expect(chat).toContainText("Product chat");
  await expect(chat.getByTestId("coverage-items")).toBeVisible();
  await expect(chat.getByTestId("coverage-fresh")).toBeVisible();
  for (const id of ["coverage-not-read", "coverage-used", "coverage-synced"]) {
    await expect(chat.getByTestId(id)).toBeHidden();
  }
  const t = await table(page).boundingBox();
  const i = await inspector(page).boundingBox();
  expect(i!.y).toBeGreaterThanOrEqual(t!.y + t!.height - 1);
  await noHorizontalScroll(page);
});

test("company: an owner sees members' setup and staleness, commenter without sources first", async ({ page }) => {
  // protects=the owner sees team setup and staleness per member and kind
  // fails_when=a count chip is wrong, the order is wrong, or the approver's stale Drive is not 0%
  // no_claim=the real API's role check (API tests)
  await openCoverage(page);
  await expect(page.getByTestId("coverage-tab-mine")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("coverage-tab-company").click();
  await expect(page).toHaveURL(/\?tab=company$/);
  await expect(page.getByTestId("company-members-chip")).toHaveText("3 of 4 members have a source");
  await expect(page.getByTestId("company-stale-chip")).toHaveText("1 with stale sources");
  const company = page.getByTestId("company-table");
  const groups = company.locator("tr[data-group]");
  await expect(groups.first()).toContainText("commenter@example.com");
  await expect(groups.first()).toContainText("No sources");
  const drive = company.locator("tr[data-row]").filter({ hasText: "Google Docs" }).filter({ has: page.getByRole("img", { name: "Fresh 0%" }) });
  await expect(drive).toHaveCount(1);
});

test("company: a row's inspector has counts only, and no source name shows", async ({ page }) => {
  // protects=counts only: no names, items, lists or actions on another member's source
  // fails_when=a source name, item list, Not read, Used in, Sync now or Edit picks shows
  // no_claim=the API's response schema (API tests pin it)
  await login(page);
  await page.goto("/sources?tab=company");
  const company = page.getByTestId("company-table");
  await company.locator("tr[data-row]").filter({ hasText: "Google Docs" }).first().click();
  const ins = page.getByTestId("company-inspector");
  await expect(ins).toContainText("Company · coverage");
  for (const label of ["Sources", "Items", "Fresh", "Last sync"]) await expect(ins).toContainText(label);
  await expect(ins.getByTestId("freshness-fresh")).toBeVisible();
  await expect(ins.getByTestId("freshness-aging")).toBeVisible();
  await expect(ins.getByTestId("freshness-stale")).toBeVisible();
  for (const name of ["Not read", "Used in"]) await expect(ins.getByRole("list", { name })).toHaveCount(0);
  await expect(ins.getByTestId("coverage-kinds")).toHaveCount(0);
  await expect(ins.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await expect(ins.getByRole("link", { name: "Edit picks" })).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Coverage" });
  for (const name of SEEDED_NAMES) await expect(panel.getByText(name)).toHaveCount(0);
});

for (const email of ["approver@example.com", "commenter@example.com", "viewer@example.com"]) {
  test(`company: ${email.split("@")[0]} sees no tabs, and ?tab=company shows Mine`, async ({ page }) => {
    // protects=the Company tab is the owners' alone
    // fails_when=a non-owner sees a tab strip or the Company counts
    // no_claim=the API's 403 (API tests)
    await openCoverage(page, email);
    await expect(page.getByRole("tablist", { name: "Coverage" })).toHaveCount(0);
    await expect(page.getByTestId("coverage-tab-company")).toHaveCount(0);
    await page.goto("/sources?tab=company");
    await expect(table(page)).toBeVisible();
    await expect(page.getByTestId("company-table")).toHaveCount(0);
  });
}

test("company at 390 px: Kind, Sources and Fresh only, the inspector as a sheet, no sideways scroll", async ({ page }) => {
  // protects=the phone layout of the Company tab
  // fails_when=a hidden column shows, the inspector is not a sheet, or the page scrolls sideways
  // no_claim=tablet widths
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/sources?tab=company");
  const first = page.getByTestId("company-table").locator("tr[data-row]").first();
  await expect(first.getByTestId("company-kind")).toBeVisible();
  await expect(first.getByTestId("company-sources")).toBeVisible();
  await expect(first.getByTestId("company-fresh")).toBeVisible();
  await expect(first.getByTestId("company-items")).toBeHidden();
  await expect(first.getByTestId("company-synced")).toBeHidden();
  await noHorizontalScroll(page);
  await first.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("company-inspector")).toBeVisible();
  await noHorizontalScroll(page);
});

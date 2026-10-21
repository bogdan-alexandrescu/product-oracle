import { expect, test, type Locator, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// E2 Items tab: every roadmap version gets a Document and an Items tab; Items shows the
// version's items as rows grouped by horizon, with an inspector. Oracle's own links to a
// roadmap version open Items first (owner, 2026-10-21, "First tab").
//
// The "roadmap-items" mock scenario gives usage-alerts-roadmap v1's two items every field
// the tab shows (lib/api/mock/roadmap-items.json): Behaviour (Now, Beta 2026-11-30 on the
// verified ENG-412, High, rank 1) and Success metrics (Next, Low, depends on Behaviour,
// may be stale).

const ROADMAP = "/documents/usage-alerts-roadmap/v/1";
const ITEMS = `${ROADMAP}/items`;

function scenario(page: Page) {
  return page.addInitScript((key) => localStorage.setItem(key, "roadmap-items"), MOCK_SCENARIO_KEY);
}

// Next keeps recently visited routes mounted (hidden): only the visible page's elements.
const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const rows = (page: Page) => visible(page, "roadmap-item-row");
const row = (page: Page, key: string) => page.locator(`[data-testid="roadmap-item-row"][data-key="${key}"]`).filter({ visible: true });
const inspector = (page: Page) => visible(page, "roadmap-item-inspector");
const attention = (page: Page) => visible(page, "items-filter").getByRole("button", { name: /^Needs attention/ });

/** The cell of `row` under the column headed `header` (read with innerText: a phone-only label is hidden). */
async function cell(page: Page, r: Locator, header: string): Promise<Locator> {
  const table = visible(page, "roadmap-items-table");
  await expect(table.locator("thead th").first()).toBeAttached();
  const headers = await table.locator("thead th").allInnerTexts();
  const i = headers.findIndex((h) => h.trim() === header);
  expect(i, `column ${header}`).toBeGreaterThanOrEqual(0);
  return r.locator("td").nth(i);
}

/**
 * The ENG-412 schedule basis withdrawn, as POST /v1/schedule-bases/{id}/withdraw leaves it
 * in the mock's data. No screen records or withdraws a basis yet (F3 Record date bases), so
 * the test arranges it in the mock's saved data, then reloads the tab as a person would.
 */
async function withdrawBasis(page: Page, reference: string) {
  await page.evaluate((ref) => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    const basis = db.roadmap.bases.find((b: { reference: string }) => b.reference === ref);
    Object.assign(basis, { status: "withdrawn", withdrawn_by: basis.verified_by, withdrawn_at: new Date().toISOString() });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  }, reference);
}

// Card tabs-on-roadmaps: protects = a roadmap version has Document and Items tabs, with the
// item count, and a PRD version has none; fails_when = the tabs are missing, the count is
// wrong or a PRD shows Items; no_claim = how the count is computed server-side.
test("a roadmap version has Document and Items tabs with the item count; a PRD has none", async ({ page }) => {
  await login(page);
  await page.goto(ROADMAP);
  const doc = visible(page, "version-tab-document");
  const items = visible(page, "version-tab-items");
  await expect(doc).toHaveText("Document");
  await expect(doc).toHaveAttribute("aria-current", "page");
  await expect(items).toHaveText("Items 2");
  await expect(items).toHaveAttribute("href", ITEMS);
  await expect(items).not.toHaveAttribute("aria-current", "page");
  // Typed or shared: the Document tab, no redirect.
  await expect(page).toHaveURL(new RegExp(`${ROADMAP}$`));
  await expect(visible(page, "document-sections")).toBeVisible();

  await items.click();
  await expect(page).toHaveURL(new RegExp(`${ITEMS}$`));
  await expect(visible(page, "version-tab-items")).toHaveAttribute("aria-current", "page");
  await expect(rows(page)).toHaveCount(2);

  await page.goto("/documents/usage-alerts/v/1");
  await expect(visible(page, "document-sections")).toBeVisible();
  await expect(page.getByTestId("version-tab-items")).toHaveCount(0);
  await expect(page.getByTestId("version-tab-document")).toHaveCount(0);
});

// Card items-grouped: protects = rows grouped by horizon in stored order with the item's
// milestone, confidence, dependencies and state; fails_when = items shown in another order,
// ungrouped, or a field missing from its column; no_claim = the real API's ordering (mocked
// by lib/api/mock/roadmap.ts).
test("Items lists the version's items grouped by horizon, one line each", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(ITEMS);
  await expect(rows(page)).toHaveCount(2);
  const groups = visible(page, "roadmap-group");
  await expect(groups).toHaveCount(2);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute("data-horizon")))).toEqual(["now", "next"]);
  await expect(groups.nth(0)).toHaveText("Now 1");
  await expect(groups.nth(1)).toHaveText("Next 1");
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-key")))).toEqual(["item-behaviour", "item-metrics"]);
  await expect(visible(page, "items-summary")).toHaveText("2 items · 1 Now · 1 Next · 0 Later");

  const behaviour = row(page, "item-behaviour");
  await expect(await cell(page, behaviour, "#")).toHaveText("1");
  await expect(await cell(page, behaviour, "Item")).toHaveText("Behaviour");
  await expect(await cell(page, behaviour, "Horizon")).toHaveText("Now");
  await expect(await cell(page, behaviour, "Milestone")).toContainText("Beta");
  await expect(await cell(page, behaviour, "Milestone")).toContainText("2026-11-30");
  await expect((await cell(page, behaviour, "Milestone")).locator("s")).toHaveCount(0);
  await expect(await cell(page, behaviour, "Conf.")).toHaveText("High", { useInnerText: true });
  await expect(await cell(page, behaviour, "Depends on")).toHaveText("—", { useInnerText: true });
  await expect((await cell(page, behaviour, "PRD")).getByRole("link")).toHaveAttribute("href", "/documents/usage-alerts/v/1#behaviour");
  await expect((await cell(page, behaviour, "PRD")).getByRole("link")).toHaveText("§ 1. Behaviour");
  await expect(await cell(page, behaviour, "State")).toHaveText("");

  const metrics = row(page, "item-metrics");
  await expect(await cell(page, metrics, "Horizon")).toHaveText("Next");
  await expect(await cell(page, metrics, "Conf.")).toHaveText("Low", { useInnerText: true });
  const deps = await cell(page, metrics, "Depends on");
  await expect(deps).toHaveText("1", { useInnerText: true });
  await expect(deps.locator("[title]")).toHaveAttribute("title", "Behaviour");
  await expect(await cell(page, metrics, "State")).toHaveText("May be stale");

  // All 2 · Needs attention 1; the filter shows only what needs attention.
  const filter = visible(page, "items-filter");
  await expect(filter.getByRole("button", { name: /^All/ })).toHaveText("All2");
  await expect(attention(page)).toHaveText("Needs attention1");
  await attention(page).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute("data-key", "item-metrics");
  await filter.getByRole("button", { name: /^All/ }).click();
  await expect(rows(page)).toHaveCount(2);
});

// Card item-inspector: protects = selecting a row opens its inspector with the outcome, the
// rank's reason and the PRD section it came from; fails_when = the inspector is missing, shows
// another item, or links elsewhere; no_claim = how the API computes rank (priority).
test("selecting a row opens the item inspector", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(ITEMS);
  await row(page, "item-behaviour").click();
  await expect(row(page, "item-behaviour")).toHaveAttribute("aria-selected", "true");
  const insp = inspector(page);
  await expect(insp).toContainText("Item 1 of 2 · selected");
  await expect(insp.getByRole("heading", { name: "Behaviour" })).toBeVisible();
  await expect(insp.getByTestId("item-outcome")).toContainText("Admins hear about a limit before they reach it");
  await expect(insp.getByTestId("item-rank")).toContainText("Why rank 1");
  await expect(insp.getByTestId("item-rank")).toContainText("activation weight 3 x contribution 2");
  // The date rests on the verified ENG-412 estimate.
  await expect(insp.getByTestId("item-milestone")).toContainText("2026-11-30");
  await expect(insp.getByTestId("item-milestone")).toContainText("verified");
  await expect(insp.getByTestId("item-milestone")).toContainText("ENG-412");
  const fromPrd = insp.getByTestId("item-prd").getByRole("link");
  await expect(fromPrd).toHaveAttribute("href", "/documents/usage-alerts/v/1#behaviour");
  await expect(fromPrd).toHaveText("Usage alerts PRD v1 · § 1. Behaviour");
  // Open in document: the roadmap section that names the item.
  await expect(insp.getByRole("link", { name: "Open in document" })).toHaveAttribute("href", `${ROADMAP}#item-behaviour`);

  // Another row: its own inspector, its dependency by title and horizon.
  await row(page, "item-metrics").click();
  await expect(insp).toContainText("Item 2 of 2 · selected");
  await expect(insp.getByTestId("item-depends")).toContainText("Behaviour");
  await expect(insp.getByTestId("item-depends")).toContainText("Now");
  await expect(insp.getByTestId("item-freshness")).toContainText("The PRD section this item came from changed after the roadmap was built");
});

// Card unverified-date: protects = a withdrawn basis shows as a struck date with "Date
// unverified" and counts as needing attention; fails_when = the date still shows plain;
// no_claim = the API's live re-check (covered by api/tests/test_roadmap_dates.py).
test("a date whose basis was withdrawn shows struck through as Date unverified", async ({ page }) => {
  await scenario(page);
  await login(page);
  await page.goto(ITEMS);
  await expect(attention(page)).toHaveText("Needs attention1");
  await withdrawBasis(page, "ENG-412");
  await page.reload();
  const milestone = await cell(page, row(page, "item-behaviour"), "Milestone");
  await expect(milestone.locator("s")).toHaveText("2026-11-30");
  const mark = milestone.getByText("Date unverified", { exact: true });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("title", /verified estimate, capacity or commitment/);
  await expect(attention(page)).toHaveText("Needs attention2");
  await row(page, "item-behaviour").click();
  await expect(inspector(page).getByTestId("item-milestone")).toContainText(
    "Date unverified: no verified estimate, capacity or commitment supports it",
  );
});

// Card staleness-actions-role: protects = only approvers and owners see and use the two
// staleness actions, and the row's state follows without a reload; fails_when = a viewer or
// commenter sees them, or the chip does not change; no_claim = server-side role checks (API
// tests, test_roadmap_item_staleness.py).
test("approvers mark a stale item under review, then still valid; viewers and commenters cannot", async ({ page, browser }) => {
  await scenario(page);
  await login(page, "approver@example.com");
  await page.goto(ITEMS);
  const state = await cell(page, row(page, "item-metrics"), "State");
  await expect(state).toHaveText("May be stale");
  await row(page, "item-metrics").click();
  const insp = inspector(page);
  await insp.getByRole("button", { name: "Mark under review" }).click();
  await expect(state).toHaveText("Under review");
  await expect(insp.getByRole("button", { name: "Mark under review" })).toHaveCount(0);

  await insp.getByRole("button", { name: "Still valid…" }).click();
  await insp.getByLabel("Why it is still valid").fill("Checked against the PRD; the item stands");
  await insp.getByRole("button", { name: "Mark still valid" }).click();
  await expect(state).toHaveText("");
  await expect(attention(page)).toHaveText("Needs attention0");
  await expect(insp.getByTestId("item-freshness")).toHaveCount(0);

  // Viewers and commenters read the item, without the actions (each in a fresh browser).
  for (const who of ["viewer", "commenter"]) {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1366, height: 820 } });
    const other = await context.newPage();
    await scenario(other);
    await login(other, `${who}@example.com`);
    await other.goto(ITEMS);
    await row(other, "item-metrics").click();
    await expect(inspector(other)).toContainText("Item 2 of 2 · selected");
    await expect(inspector(other).getByTestId("item-freshness")).toContainText("since");
    await expect(inspector(other).getByRole("button", { name: "Mark under review" })).toHaveCount(0);
    await expect(inspector(other).getByRole("button", { name: "Still valid…" })).toHaveCount(0);
    await context.close();
  }
});

// Card switcher-keeps-tab and empty-items: protects = the version switcher on Items links to
// the other version's Items, and a version without items says so with a link to its document;
// fails_when = the switcher drops the tab, or an empty version shows a table; no_claim = the
// API's carry-forward of items into an imported version (api/tests/test_roadmap_items.py).
test("the version switcher keeps the Items tab; a version with no items says so", async ({ page }) => {
  test.setTimeout(90_000);
  // A second roadmap version, built the way a person builds one: from the Roadmap screen.
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Roadmap" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByTestId("estimate-total")).toBeVisible();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Check agents now" }).click();
  await page.getByTestId("checkpoint-roadmap_items").getByRole("button", { name: "Approve and continue" }).click();
  await page.getByRole("button", { name: "Check agents now" }).click();
  await page.getByTestId("segment-roadmap_draft").getByRole("link", { name: "usage-alerts-roadmap v2" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap\/v\/2$/);

  // v2 has no items file: the empty state, no table.
  await visible(page, "version-tab-items").click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap\/v\/2\/items$/);
  const empty = visible(page, "roadmap-items-empty");
  await expect(empty).toContainText("No items for this version");
  await expect(empty.getByRole("link", { name: "Open the document" })).toHaveAttribute("href", "/documents/usage-alerts-roadmap/v/2");
  await expect(page.getByTestId("roadmap-items-table")).toHaveCount(0);

  // The switcher keeps the tab.
  const v1 = page.getByRole("group", { name: "Version" }).filter({ visible: true }).getByRole("link", { name: "v1" });
  await expect(v1).toHaveAttribute("href", ITEMS);
  await v1.click();
  await expect(page).toHaveURL(new RegExp(`${ITEMS}$`));
  await expect(rows(page)).toHaveCount(2);
  await expect(visible(page, "version-tab-items")).toHaveAttribute("aria-current", "page");
});

// Card items-phone: protects = at 390 px the rows stack, a tap opens the inspector in a sheet
// and nothing scrolls sideways; fails_when = the table overflows, or no sheet opens; no_claim
// = other phone layouts of the version view (phone-tables.spec.ts).
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("at 390 px the rows stack and a tap opens the inspector in a sheet", async ({ page }) => {
    await scenario(page);
    await login(page);
    await page.goto(ITEMS);
    const behaviour = row(page, "item-behaviour");
    await expect(behaviour).toBeVisible();
    // Stacked: the title on line 1 with the horizon to its right, the milestone under it.
    const title = (await (await cell(page, behaviour, "Item")).boundingBox())!;
    const horizon = (await (await cell(page, behaviour, "Horizon")).boundingBox())!;
    const milestone = (await (await cell(page, behaviour, "Milestone")).boundingBox())!;
    expect(horizon.x).toBeGreaterThan(title.x);
    expect(milestone.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await expect(inspector(page)).toHaveCount(0);
    await behaviour.click();
    const sheet = visible(page, "sheet-item");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("roadmap-item-inspector")).toContainText("Behaviour");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

// Card items-first: protects = Oracle's own links to a roadmap version open its Items tab,
// typed links and PRD links are unchanged, and a PRD has no Items route; fails_when = the
// Roadmap screen or overview opens the Document tab, a typed link is redirected, or a PRD's
// /items shows a page; no_claim = links outside Oracle.
test("Oracle's links open a roadmap version on Items; typed links and PRDs are unchanged", async ({ page }) => {
  await login(page);
  // A PRD has no Items tab: its /items goes to the version.
  await page.goto("/documents/usage-alerts/v/1/items");
  await expect(page).toHaveURL(/\/documents\/usage-alerts\/v\/1$/);
  await expect(visible(page, "document-sections")).toBeVisible();

  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Roadmap" }).click();
  await expect(page).toHaveURL(/\/roadmap$/);
  const roadmapRow = page.getByTestId("roadmap-row").filter({ hasText: "Usage alerts roadmap" });
  await expect(roadmapRow.getByRole("link", { name: "v1", exact: true })).toHaveAttribute("href", ITEMS);
  // A PRD's links are unchanged.
  await expect(
    page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("link", { name: "Usage alerts PRD" }),
  ).toHaveAttribute("href", "/documents/usage-alerts/v/1");
  await roadmapRow.getByRole("link", { name: "v1", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${ITEMS}$`));
  await expect(visible(page, "version-tab-items")).toHaveAttribute("aria-current", "page");
  await expect(rows(page)).toHaveCount(2);

  // The document overview's version list also opens Items; a PRD's still opens the version.
  await page.goto("/documents/usage-alerts-roadmap");
  await expect(visible(page, "versions-table").getByRole("link", { name: "Version 1" })).toHaveAttribute("href", ITEMS);
  await page.goto("/documents/usage-alerts");
  await expect(visible(page, "versions-table").getByRole("link", { name: "Version 1" })).toHaveAttribute("href", "/documents/usage-alerts/v/1");

  // Typed: the Document tab, never redirected.
  await page.goto(`${ROADMAP}#item-behaviour`);
  await expect(page).toHaveURL(new RegExp(`${ROADMAP}#item-behaviour$`));
  await expect(visible(page, "version-tab-document")).toHaveAttribute("aria-current", "page");
});

// Card approve-parity: protects = Approve on the Items tab behaves as on the Document tab,
// "cannot approve while a date is marked" included (a copy of roadmap.spec.ts's test on
// Items); fails_when = Items drops Approve, or offers it while a date is marked; no_claim =
// the date marks themselves (roadmap.spec.ts, api tests).
test("Items tab: a roadmap version with a marked date cannot be approved", async ({ page }) => {
  await login(page);
  await page.goto(ITEMS);
  await expect(rows(page)).toHaveCount(2);
  const blocked = page.getByTestId("approve-blocked").filter({ visible: true });
  await expect(blocked.getByRole("button", { name: "Approve version" })).toBeDisabled();
  await expect(blocked).toContainText("2026-12-15 (date withdrawn)");
  await expect(blocked).toContainText("Record a basis");
});

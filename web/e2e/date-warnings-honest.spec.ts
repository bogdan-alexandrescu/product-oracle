import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO, NOT_CLAIMS_SCENARIO, SHARED_DATE_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * date-warnings-honest (owner, Nov 3): a roadmap version's date warnings flag only dates
 * that truly have no basis, once per date and item, and follow the bases as they stand.
 * On the mock layer, driven as a person would. In the "date-bases" scenario the roadmap's
 * Beta date (Nov 30) rests on the verified ENG-412 and its GA date (Dec 15) on nothing.
 */

const LEAD = "commenter@example.com";

async function openRoadmap(page: Page) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, DATE_BASES_SCENARIO]);
  await login(page, LEAD);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
}

const dateWarnings = (page: Page) => page.locator('[data-warning="unverified_date"]').filter({ visible: true });
const lacking = (page: Page) => page.getByTestId("dates-lacking").filter({ visible: true });

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport });

    test("one unbacked date shows one warning that opens Plan › Dates filtered to it; once backed, no warnings", async ({ page }) => {
      // protects=date-warnings-honest (1)-(5); fails_when=the backed Nov 30 date warns, the
      // unbacked date warns more than once, the header does not count it or link to Plan ›
      // Dates filtered to it, or the warning stays after a basis is verified;
      // no_claim=the API's matching rules (api/tests/test_date_warnings_honest.py).
      await openRoadmap(page);
      await expect(dateWarnings(page)).toHaveCount(1);
      await expect(dateWarnings(page)).toContainText("the date Dec 15, 2026");
      await expect(dateWarnings(page)).not.toContainText("Nov 30");
      await expect(lacking(page)).toHaveText("1 date lacks a basis");

      await lacking(page).click();
      await expect(page).toHaveURL(/\/plan\/dates\?prd=[^&]+&dates=2026-12-15$/);
      const filter = page.getByTestId("dates-lacking-filter");
      await expect(filter).toContainText("1 date needs a basis: Dec 15.");
      await expect(filter).toContainText("Showing the date sources of Usage alerts PRD.");

      // The lead records the date's source; it is verified at once.
      await page.getByRole("button", { name: "Add a date source" }).click();
      const dialog = page.getByTestId("date-basis-dialog");
      await dialog.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
      await dialog.getByLabel("Reference").fill("ENG-413");
      await dialog.getByLabel("Date it supports").fill("2026-12-15");
      await dialog.getByRole("button", { name: "Record and verify" }).click();
      await expect(dialog).toBeHidden();

      await page.goto("/documents/usage-alerts-roadmap/v/1");
      await expect(page.getByTestId("doc-status").filter({ visible: true }).first()).toBeVisible();
      await expect(page.locator('[data-date-mark="unverified"]').filter({ visible: true })).toHaveCount(0);
      await expect(dateWarnings(page)).toHaveCount(0);
      await expect(lacking(page)).toHaveCount(0);
      await expect(page.locator("[data-warning]").filter({ visible: true })).toHaveCount(0);
    });

    test("the warning's own link opens Plan › Dates filtered to its date", async ({ page }) => {
      // protects=date-warnings-honest (4); fails_when=the warning links to an unfiltered
      // Plan › Dates; no_claim=recording a basis (the test above).
      await openRoadmap(page);
      await dateWarnings(page).getByRole("link", { name: "Open Plan › Dates" }).click();
      await expect(page).toHaveURL(/\/plan\/dates\?prd=[^&]+&dates=2026-12-15$/);
      await expect(page.getByTestId("dates-lacking-filter")).toContainText("Dec 15");
      await page.getByTestId("dates-lacking-filter").getByRole("link", { name: "Show every date source" }).click();
      await expect(page).toHaveURL(/\/plan\/dates$/);
      await expect(page.getByTestId("dates-lacking-filter")).toHaveCount(0);
    });
  });
}

test("Plan › Dates looks up its people once, not again and again", async ({ page }) => {
  // protects=date-warnings-honest review blocker (Plan › Dates fetched people in an endless
  // loop); fails_when=the people lookup keeps running after the tab has loaded, unfiltered
  // or filtered to a PRD; no_claim=which names the By column shows.
  await openRoadmap(page);
  const calls = () => page.evaluate(() => window.__peopleCalls ?? 0);
  const steady = async () => {
    await expect(page.locator("[data-basis]").filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(1000);
    const settled = await calls();
    await page.waitForTimeout(1500);
    expect(await calls()).toBe(settled);
    expect(settled).toBeLessThan(5);
  };
  await lacking(page).click();
  await expect(page).toHaveURL(/\/plan\/dates\?prd=/);
  await steady();
  await page.goto("/plan/dates");
  await steady();
});

test("one date written for two items warns for each item but counts as one date", async ({ page }) => {
  // protects=date-warnings-honest review minors (the header counted date-and-item pairs; the
  // mock took a warning's item from the section key only); fails_when=the header reads
  // "2 dates lack a basis" for one date, or the two items share one warning;
  // no_claim=the API's grouping (api/tests/test_date_warnings_honest.py).
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, SHARED_DATE_SCENARIO]);
  await login(page, LEAD);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(dateWarnings(page)).toHaveCount(2);
  await expect(lacking(page)).toHaveText("1 date lacks a basis");
  await lacking(page).click();
  await expect(page).toHaveURL(/\/plan\/dates\?prd=[^&]+&dates=2026-12-15$/);
  await expect(page.getByTestId("dates-lacking-filter")).toContainText("1 date needs a basis: Dec 15.");
});

test("the version's own day, a quoted source's date and a quarter's range do not warn", async ({ page }) => {
  // protects=date-warnings-honest review minor (the mock did not mirror the API's own-day,
  // quotation and quarter-range skips); fails_when=any of the summary's three non-claim
  // dates warns; no_claim=the API's rules (api/tests/test_date_warnings_honest.py).
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, NOT_CLAIMS_SCENARIO]);
  await login(page, LEAD);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(page.getByText("The courier said").filter({ visible: true }).first()).toBeVisible();
  await expect(dateWarnings(page)).toHaveCount(1);
  await expect(dateWarnings(page)).toContainText("the date Dec 15, 2026");
  await expect(lacking(page)).toHaveText("1 date lacks a basis");
});

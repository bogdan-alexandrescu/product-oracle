import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * Visual-QA fix pass on /sources (F-17, F-55, F-56, F-62), driven through the UI on the mock.
 */

function table(page: Page): Locator {
  return page.getByTestId("coverage-table");
}

function companyTable(page: Page): Locator {
  return page.getByTestId("company-table");
}

function row(page: Page, name: string): Locator {
  return table(page).locator("tr[data-row]").filter({ hasText: name });
}

function inspector(page: Page): Locator {
  return page.getByTestId("coverage-inspector");
}

async function openCoverage(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/sources");
  await expect(page.getByRole("region", { name: "Coverage" })).toBeVisible();
}

/** The owner's Company tab (F-17, F-55 are owner-only). */
async function openCompany(page: Page) {
  await openCoverage(page);
  await page.getByTestId("coverage-tab-company").click();
  await expect(page).toHaveURL(/\?tab=company$/);
}

test.describe("desktop (1440)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("F-17: the Mine/Company help tip names no internal ticket codes", async ({ page }) => {
    await openCompany(page);
    const tip = page.getByRole("button", { name: "About Company" }).filter({ visible: true }).first();
    await tip.click();
    const bubble = page.getByText("Counts only.", { exact: false }).filter({ visible: true }).first();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("never their sources' names or what they hold");
    await expect(bubble).not.toContainText("S5");
    await expect(bubble).not.toContainText("S6");
    await expect(bubble).not.toContainText("(");
  });

  test("F-55: each chip leads to the members it counts; the first column names the member, not a code", async ({ page }) => {
    // fails_when=the "have a source" chip shows the member without one, or no chip leads to
    // the member without a source.
    await openCompany(page);
    const ct = companyTable(page);
    await expect(ct.getByRole("columnheader", { name: "Member" })).toBeVisible();
    await expect(ct.getByRole("columnheader", { name: "Kind", exact: true })).toHaveCount(0);

    await expect(ct.locator("tr[data-row]").first()).toBeVisible();
    const total = await ct.locator("tr[data-row]").count();
    const groups = ct.locator("tr[data-group]");
    await expect(groups).toHaveCount(4);
    const membersChip = page.getByTestId("company-members-chip");
    const withoutChip = page.getByTestId("company-without-chip");
    const staleChip = page.getByTestId("company-stale-chip");
    await expect(membersChip).toHaveText("3 of 4 members have a source");
    await expect(withoutChip).toHaveText("1 without a source");
    await expect(staleChip).toHaveText("1 with stale sources");

    // "3 of 4 have a source": the three members it counts, each with their sources; not the one without.
    await membersChip.click();
    await expect(groups).toHaveCount(3);
    await expect(ct.locator("tr[data-row]")).toHaveCount(total);
    await expect(ct).not.toContainText("commenter@example.com");
    await expect(ct).not.toContainText("No sources");

    // Pressing the same chip again clears the filter.
    await membersChip.click();
    await expect(groups).toHaveCount(4);

    // "1 without a source": only the commenter's group remains, as a header with no data row.
    await withoutChip.click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(0);
    await expect(groups).toHaveCount(1);
    // The member by name, the email beside it (the API sends the member's display name).
    await expect(groups).toContainText("Theo Brandt");
    await expect(groups).toContainText("commenter@example.com");
    await expect(groups).toContainText("No sources");
    await withoutChip.click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(total);

    // Stale: only the approver's row remains.
    await staleChip.click();
    const staleCount = await ct.locator("tr[data-row]").count();
    expect(staleCount).toBeGreaterThan(0);
    expect(staleCount).toBeLessThan(total);
    await expect(groups).toHaveCount(1);
    await expect(groups).toContainText("approver@example.com");

    // "All" clears a filter picked from any chip.
    await page.getByTestId("company-filter-all").click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(total);
    await expect(page.getByTestId("company-filter-all")).toHaveCount(0);
  });

  test("F-56: the coverage counts sit in one tip, not a loose sentence on Mine", async ({ page }) => {
    await openCoverage(page);
    await expect(page.getByTestId("coverage-counts-note")).toHaveCount(0);
    await expect(page.getByText("Items read: what Oracle holds from the source.", { exact: false }).filter({ visible: true })).toHaveCount(0);

    const tip = page.getByRole("button", { name: "About Coverage" }).filter({ visible: true }).first();
    await expect(tip).toBeVisible();
    await tip.click();
    const bubble = page.getByText("Items read: what Oracle holds from the source.", { exact: false }).filter({ visible: true }).first();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("counted apart from the items");
    await expect(bubble).toContainText("one item can be used more than once");
    // The columns themselves keep their short labels.
    await expect(table(page).getByRole("columnheader", { name: "Items read" })).toBeVisible();
  });

  test("F-62: Synced shows a month-first date, the relative age on hover", async ({ page }) => {
    await openCoverage(page);
    const synced = row(page, "Product chat").getByTestId("coverage-synced");
    await expect(synced).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
    const title = await synced.getAttribute("title");
    expect(title).toMatch(/^(now|\d+(m|h|d|w|mo|y))$/);
  });
});

test("F-62 (phone 390): picking a source scrolls its coverage panel into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCoverage(page);
  // fails_when=the page jumps down to the panel on its first load, or a pick leaves the panel,
  // drawn below the whole table, off screen. The pick is a row near the top, so the click
  // itself does not scroll the page down to the panel.
  await expect(row(page, "Example repo")).toBeVisible();
  await expect(inspector(page)).toBeAttached();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(inspector(page)).not.toBeInViewport();
  await row(page, "Example repo").click();
  await expect(page).toHaveURL(/\?source=/);
  await expect(inspector(page)).toBeInViewport();
});

test.describe("dark mode", () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });

  test("F-55 (dark): the filter chips still toggle the member table", async ({ page }) => {
    await openCompany(page);
    const ct = companyTable(page);
    await expect(ct.locator("tr[data-row]").first()).toBeVisible();
    const total = await ct.locator("tr[data-row]").count();
    const staleChip = page.getByTestId("company-stale-chip");
    await staleChip.click();
    await expect.poll(() => ct.locator("tr[data-row]").count()).toBeLessThan(total);
    await staleChip.click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(total);
  });
});

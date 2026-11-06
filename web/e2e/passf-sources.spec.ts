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

  test("F-55: the chips filter the member table; the first column names the member, not a code", async ({ page }) => {
    await openCompany(page);
    const ct = companyTable(page);
    await expect(ct.getByRole("columnheader", { name: "Member" })).toBeVisible();
    await expect(ct.getByRole("columnheader", { name: "Kind", exact: true })).toHaveCount(0);

    await expect(ct.locator("tr[data-row]").first()).toBeVisible();
    const total = await ct.locator("tr[data-row]").count();
    const membersChip = page.getByTestId("company-members-chip");
    const staleChip = page.getByTestId("company-stale-chip");
    await expect(membersChip).toHaveText("3 of 4 members have a source");
    await expect(staleChip).toHaveText("1 with stale sources");

    // Without a source: only the commenter's group remains, as a header with no data row.
    await membersChip.click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(0);
    await expect(ct.locator("tr[data-group]")).toHaveCount(1);
    const onlyGroup = ct.locator("tr[data-group]");
    // The member by name, the email beside it (the API sends the member's display name).
    await expect(onlyGroup).toContainText("Theo Brandt");
    await expect(onlyGroup).toContainText("commenter@example.com");

    // Pressing the same chip again clears the filter.
    await membersChip.click();
    await expect(ct.locator("tr[data-row]")).toHaveCount(total);

    // Stale: only the approver's row remains.
    await staleChip.click();
    const staleCount = await ct.locator("tr[data-row]").count();
    expect(staleCount).toBeGreaterThan(0);
    expect(staleCount).toBeLessThan(total);
    await expect(ct.locator("tr[data-group]")).toContainText("approver@example.com");

    // "All" clears a filter picked from either chip.
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
  // The last seeded source: far enough down the list that its panel, drawn below the
  // whole table, starts off screen until the pick scrolls it into view.
  await row(page, "Drive folders").click();
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

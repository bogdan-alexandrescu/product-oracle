import { readFileSync } from "node:fs";

import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Second QA pass on Company › Metrics, Decisions and Market, driven through the UI on the
 * default mock scenario as the owner: no metrics, no alternatives, no pricing memos and no
 * win or loss records yet, and five judgement calls (no checkpoint records). D-5 "Ship usage
 * caps before anomaly detection" waits on Priya Raman. Each test names the finding it protects.
 */

const CAPS = "Ship usage caps before anomaly detection";

const rows = (page: Page) => page.getByTestId("decision-row");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const group = (page: Page, name: string) => page.getByTestId("decision-filters").getByRole("group", { name, exact: true });
const visibleButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });

async function openAddMetric(page: Page) {
  await login(page);
  await page.goto("/company/metrics");
  await page.getByTestId("metrics-empty").filter({ visible: true }).getByRole("button", { name: "Add your first metric" }).click();
  return page.getByRole("dialog", { name: "Add metric" });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("qa-company-8: Add metric marks every missing field at once, by the field, in plain words", async ({ page }) => {
    const dialog = await openAddMetric(page);
    // Required fields are marked before anything is tried.
    await expect(dialog.getByText("Fields marked (required) must be filled in.")).toBeVisible();
    // Title, What it counts, Unit, Owner and Query (an output read from PostHog).
    await expect(dialog.getByText("(required)", { exact: true })).toHaveCount(5);
    const title = dialog.getByRole("textbox", { name: "Title" });
    await expect(title).toHaveAttribute("aria-required", "true");

    await dialog.getByRole("button", { name: "Add metric" }).click();
    for (const field of ["title", "description", "unit", "owner", "query"]) {
      await expect(dialog.getByTestId(`metric-error-${field}`)).toBeVisible();
    }
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).toBeFocused();
    await expect(title).toHaveAccessibleDescription("Give the metric a title.");
    await expect(dialog.getByTestId("metric-error-description")).toHaveText("Say what the metric counts.");
    // Each note sits right under its own field, not in one box at the bottom.
    const [fieldBox, noteBox] = await Promise.all([title.boundingBox(), dialog.getByTestId("metric-error-title").boundingBox()]);
    expect(noteBox!.y).toBeGreaterThan(fieldBox!.y);
    expect(noteBox!.y - (fieldBox!.y + fieldBox!.height)).toBeLessThan(16);
    await expect(dialog).not.toContainText("title:");

    // Fixing one field clears its note only.
    await title.fill("Weekly active teams");
    await expect(dialog.getByTestId("metric-error-title")).toHaveCount(0);
    await expect(title).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByTestId("metric-error-unit")).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test("qa-company-11: the query box shows a light example, and Test says it needs a query", async ({ page }) => {
    const dialog = await openAddMetric(page);
    const query = dialog.getByLabel("Query");
    await expect(query).toHaveAttribute("placeholder", /^e\.g\. /);
    const [typed, hint] = await query.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el, "::placeholder").color]);
    expect(hint).not.toBe(typed);
    const font = await query.evaluate((el) => getComputedStyle(el, "::placeholder").fontFamily);
    expect(font).not.toMatch(/mono/i);

    const testButton = dialog.getByRole("button", { name: "Test" });
    await expect(testButton).toBeDisabled();
    await expect(dialog.getByTestId("metric-test-hint")).toHaveText("Write a query to test it.");
    await expect(testButton).toHaveAccessibleDescription("Write a query to test it.");
    await query.fill("select count() from events");
    await expect(testButton).toBeEnabled();
    await expect(dialog.getByTestId("metric-test-hint")).toHaveCount(0);
  });

  test("qa-company-20: each empty page has one button per action, in its empty state", async ({ page }) => {
    await login(page);
    await page.goto("/company/metrics");
    await expect(page.getByTestId("metrics-empty").filter({ visible: true })).toBeVisible();
    await expect(visibleButton(page, "Add your first metric")).toHaveCount(1);
    await expect(visibleButton(page, "Add metric")).toHaveCount(0);

    await page.goto("/company/market");
    await expect(page.getByTestId("alternatives-empty").filter({ visible: true })).toBeVisible();
    await expect(visibleButton(page, "Add your first alternative")).toHaveCount(1);
    await expect(visibleButton(page, "Add alternative")).toHaveCount(0);

    await page.goto("/company/market?tab=pricing");
    await expect(page.getByTestId("pricing-empty").filter({ visible: true })).toBeVisible();
    await expect(visibleButton(page, "Write a pricing memo")).toHaveCount(1);
    await expect(visibleButton(page, "New pricing memo")).toHaveCount(0);

    await page.goto("/company/market?tab=win-loss");
    await expect(page.getByTestId("deals-empty").filter({ visible: true })).toBeVisible();
    await expect(visibleButton(page, "Add a record")).toHaveCount(1);
    await expect(visibleButton(page, "Import a CSV file")).toHaveCount(1);
    await expect(visibleButton(page, "Add")).toHaveCount(0);
    await expect(visibleButton(page, "Import CSV")).toHaveCount(0);
  });

  test("qa-company-9: the decision search filters as it is typed, with no Enter", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await expect(row(page, CAPS)).toBeVisible();
    // The owner's rights are in (Needs me shows) before typing, so nothing redraws under it.
    await expect(page.getByTestId("decision-state")).toContainText("Needs me");
    const search = page.getByLabel("Search decisions");
    await search.pressSequentially("zzzz");
    await expect(search).toBeFocused();
    await expect(page.getByTestId("decisions-empty")).toContainText("No decisions match “zzzz”.");
    await expect(rows(page)).toHaveCount(0);
    await expect(page).toHaveURL(/q=zzzz/);
    await search.fill("usage caps");
    await expect(row(page, CAPS)).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
  });

  test("qa-company-10: an empty kind says so, offers all kinds, and the count keeps its total", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await expect(row(page, CAPS)).toBeVisible();
    await group(page, "Kind")
      .getByRole("button", { name: /^Checkpoints/ })
      .click();
    const empty = page.getByTestId("decisions-empty");
    await expect(empty).toContainText("No checkpoint decisions.");
    await expect(empty).not.toContainText("No decisions here yet");
    await expect(page.getByTestId("panel-count").first()).toHaveText(/^0 of \d+\+?$/);
    await empty.getByRole("button", { name: "Show all kinds" }).click();
    await expect(page).toHaveURL(/class=all/);
    await expect(row(page, CAPS)).toBeVisible();
  });

  test("qa-company-39: the Approver column names the approver; numbers are body text, not code", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    const caps = row(page, CAPS);
    await expect(caps.locator('[data-col="approver"]')).toHaveText("Priya Raman");
    const ref = caps.getByText(/^D-\d+$/);
    const title = caps.getByText(CAPS, { exact: true });
    const [refFont, refColor, titleColor] = await Promise.all([
      ref.evaluate((el) => getComputedStyle(el).fontFamily),
      ref.evaluate((el) => getComputedStyle(el).color),
      title.evaluate((el) => getComputedStyle(el).color),
    ]);
    expect(refFont).not.toMatch(/mono/i);
    expect(refColor).toBe(titleColor);
  });

  test("qa-company-40: Import win and loss shows the columns in plain words and a sample file that imports", async ({ page }) => {
    await login(page);
    await page.goto("/company/market?tab=win-loss");
    await page.getByTestId("deals-empty").filter({ visible: true }).getByRole("button", { name: "Import a CSV file" }).click();
    const dialog = page.getByRole("dialog", { name: "Import win and loss" });
    const sample = dialog.getByTestId("import-sample");
    await expect(sample.getByRole("columnheader")).toHaveText(["Column", "Example", "Needed"]);
    await expect(sample).toContainText("Annual value");
    await expect(sample).toContainText("Decided on");
    await expect(dialog).not.toContainText("annual_value");
    await expect(dialog).not.toContainText("reason_note");

    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("link", { name: "Download a sample CSV" }).click()]);
    expect(download.suggestedFilename()).toBe("win-and-loss-sample.csv");
    const path = await download.path();
    const text = readFileSync(path, "utf8");
    expect(text.split("\n")[0]).toBe("Result,Account,Segment,Plan,Annual value,Currency,Decided on,Reason,Reason note,Alternative,Price quoted");
    // The sample is a file the import takes as it is.
    await dialog.getByLabel("CSV file").setInputFiles({ name: "sample.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
    await expect(dialog.getByTestId("import-create")).toHaveText("1 row to create");
    await expect(dialog.getByTestId("import-refused-count")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-company-38: the decision sheet shows the title once", async ({ page }) => {
    await login(page);
    await page.goto("/company/decisions?state=all");
    await row(page, CAPS).click();
    const sheet = page.getByTestId("decision-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(CAPS, { exact: true }).filter({ visible: true })).toHaveCount(1);
  });

  test("qa-company-8 on a phone: every missing field is marked under it", async ({ page }) => {
    const dialog = await openAddMetric(page);
    await dialog.getByRole("button", { name: "Add metric" }).click();
    for (const field of ["title", "description", "unit", "owner", "query"]) {
      await expect(dialog.getByTestId(`metric-error-${field}`)).toBeVisible();
    }
    await expect(dialog.getByRole("textbox", { name: "Title" })).toBeFocused();
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw);
  });
});

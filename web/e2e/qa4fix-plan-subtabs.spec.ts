import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA round 4 fixes on the Plan's sub-tabs: Reports and a report, Dates, Documents, Outcomes and
 * the tab strip (qa4-plan-7, -31, -32, -34 to -39, -47, -48), driven through the UI on the mock
 * API as a person would, on a desktop (1440x900) and a phone (390x844). "alignment-report" is
 * the default company plus two weekly reports; the default company has one track (Usage alerts
 * PRD), no report and no outcome.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const strip = (page: Page) => visible(page, "plan-tabs");
const links = (page: Page) => visible(page, "plan-links");
const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });

async function start(page: Page, scenario?: string) {
  if (scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
}

/** Plan › Reports › the week of Oct 12. */
async function openReport(page: Page) {
  await page.goto("/plan/reports");
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
}

/** Track outcome for Threshold alerts on spend: +5 points, checked on Dec 15, 2026. */
async function trackOutcome(page: Page, metric?: string) {
  await page.goto("/plan/outcomes");
  await visible(page, "outcomes-empty").getByRole("button", { name: "Track outcome" }).click();
  const form = visible(page, "track-outcome-form");
  await form.getByLabel("Item").selectOption({ label: "Threshold alerts on spend" });
  await expect(form.getByLabel("Goal").locator("option:checked")).toHaveText("Raise activation");
  await form.getByLabel("Expected effect").fill("+5 points");
  if (metric) await form.getByLabel("Metric").fill(metric);
  await form.getByLabel("Check date").fill("2026-12-15");
  return form;
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-plan-7: a milestone with an item slipping past it reads at risk, not only verified", async ({ page }) => {
    await start(page, "alignment-report");
    await openReport(page);
    const usage = visible(page, "report-track").filter({ hasText: "Usage alerts PRD" });
    // The same card lists ENG-405 slipping past First release (Nov 30).
    await expect(usage.getByTestId("needs-attention")).toContainText("ENG-405 targets Dec 9, after the milestone date Nov 30.");
    await expect(usage).toContainText("First release, Nov 30");
    await expect(usage.getByTestId("report-milestone-risk")).toHaveText("· at risk: an item slips past it");
    await expect(usage).not.toContainText("a verified basis supports it");
  });

  test("qa4-plan-31: the verified date the Plan shows for Threshold alerts on spend is listed on Dates", async ({ page }) => {
    await start(page);
    await page.goto("/plan");
    const row = visible(page, "plan-row").filter({ hasText: "Threshold alerts on spend" });
    await expect(row.getByTestId("plan-engineering")).toHaveText("ENG-402 · Nov 20 ✓");
    await strip(page).getByTestId("plan-tab-dates").click();
    await expect(page).toHaveURL(/\/plan\/dates$/);
    await visible(page, "dates-filter").getByRole("button", { name: /^All/ }).click();
    const basis = visible(page, "dates-table").locator('[data-basis="ENG-402"]').filter({ visible: true });
    await expect(basis).toHaveAttribute("data-status", "verified");
    await expect(basis).toContainText("Nov 20");
    await expect(basis).toContainText("Threshold alerts on spend");
  });

  test("qa4-plan-32: the Dates table is headed Date and Applies to", async ({ page }) => {
    await start(page);
    await page.goto("/plan/dates");
    const table = visible(page, "dates-table");
    await expect(table.getByRole("columnheader", { name: "Date", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Applies to", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Supports", exact: true })).toHaveCount(0);
    await expect(table.getByRole("columnheader", { name: "For", exact: true })).toHaveCount(0);
    await expect(table.locator('[data-basis="ENG-412"]').filter({ visible: true })).toContainText("The whole PRD");
  });

  test("qa4-plan-34: Documents shows a roadmap's state one way, in the list and the inspector", async ({ page }) => {
    await start(page);
    await page.goto("/plan/documents");
    const inspector = visible(page, "roadmap-inspector");
    const own = inspector.locator("[data-kind][data-status]").first();
    await expect(own).toBeVisible();
    const status = (await own.getAttribute("data-status"))!;
    const listed = visible(page, "roadmaps-table").locator(`[data-kind][data-status="${status}"]`).first();
    await expect(listed).toBeVisible();
    const look = (el: Element) => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, dots: el.querySelectorAll("span[aria-hidden]").length });
    expect(await own.evaluate(look)).toEqual(await listed.evaluate(look));
    expect((await own.evaluate(look)).dots).toBe(1);
    // "Not approved yet" is a state too: the same dotted chip.
    await expect(inspector.getByTestId("roadmap-not-approved").locator("span[aria-hidden]")).toHaveCount(1);
  });

  test("qa4-plan-35: with no outcome, no '0 outcomes' chip beside the empty state", async ({ page }) => {
    await start(page);
    await page.goto("/plan/outcomes");
    await expect(visible(page, "outcomes-empty")).toContainText("No outcomes yet");
    await expect(header(page)).toBeVisible();
    await expect(header(page)).not.toContainText("0 outcomes");
  });

  test("qa4-plan-36: the info button says Reports, and the link opened is the one selected", async ({ page }) => {
    await start(page, "alignment-report");
    await page.goto("/plan/reports");
    await expect(header(page).getByRole("button", { name: "About Reports" })).toBeVisible();
    await expect(page.getByRole("button", { name: "About Alignment reports" })).toHaveCount(0);
    const latest = links(page).getByRole("link", { name: "Latest report" });
    const tab = strip(page).getByTestId("plan-tab-reports");
    await latest.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
    await expect(latest).toHaveAttribute("aria-current", "page");
    await expect(tab).not.toHaveAttribute("aria-current", "page");
    // A report opened from the list: the Reports tab is selected, not Latest report.
    await tab.click();
    await expect(page).toHaveURL(/\/plan\/reports$/);
    await page.getByRole("link", { name: /week of Oct 5/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 5");
    await expect(tab).toHaveAttribute("aria-current", "page");
    await expect(latest).not.toHaveAttribute("aria-current", "page");
  });

  test("qa4-plan-39: a report speaks plain words: made by hand, no engineering ticket", async ({ page }) => {
    await start(page);
    await page.goto("/plan/reports");
    await visible(page, "reports-empty").getByRole("button", { name: "Generate now" }).click();
    await page.getByRole("dialog", { name: "Generate a report now" }).getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+$/);
    await expect(header(page)).toContainText("Made by hand");
    const figures = visible(page, "report-figures");
    await expect(figures.getByText("Now items with no engineering ticket", { exact: true })).toBeVisible();
    await expect(visible(page, "report-track").first()).toContainText(/\d+ with no ticket/);
    const main = page.locator("main");
    for (const word of ["On demand", "without an issue", "untracked"]) await expect(main).not.toContainText(word);
  });

  test("qa4-plan-47: with one outcome, its item, prediction and due date show in full", async ({ page }) => {
    await start(page);
    const form = await trackOutcome(page, "Accounts that finish setup within 7 days");
    await form.getByRole("button", { name: "Track outcome" }).click();
    await expect(form).toHaveCount(0);
    const row = visible(page, "outcome-row").filter({ hasText: "Threshold alerts on spend" });
    await expect(row).toBeVisible();
    // Due says the date once; Predicted does not repeat it.
    await expect(row.getByTestId("outcome-due")).toHaveText("Dec 15, 2026");
    await expect(row.getByTestId("outcome-predicted")).toHaveText("+5 points");
    const cut = await row.locator("td").evaluateAll((tds) =>
      tds.filter((td) => td.clientWidth > 0 && td.scrollWidth > td.clientWidth + 1).map((td) => td.textContent),
    );
    expect(cut).toEqual([]);
  });

  test("qa4-plan-48: the outcome inspector says the start is not measured yet, with the goal's own metric", async ({ page }) => {
    await start(page);
    const form = await trackOutcome(page);
    // The Metric comes from the goal picked with the item.
    await expect(form.getByLabel("Metric")).toHaveValue("Accounts that finish setup within 7 days");
    await form.getByRole("button", { name: "Track outcome" }).click();
    await expect(form).toHaveCount(0);
    const inspector = visible(page, "outcome-inspector");
    await expect(inspector).toContainText("Predicted from today's value (not measured yet) → +5 points");
    await expect(inspector).not.toContainText("Predicted ?");
    await expect(inspector.getByText("Accounts that finish setup within 7 days", { exact: true })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-plan-37: on a phone the report's title is shown in full, wrapping", async ({ page }) => {
    await start(page, "alignment-report");
    await openReport(page);
    const title = page.getByRole("heading", { level: 1 });
    const box = (await title.boundingBox())!;
    // Drawn on the page (not a 1 px screen-reader box), inside the screen, nothing cut.
    expect(box.width).toBeGreaterThan(150);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(title).toBeInViewport();
  });

  test("qa4-plan-38: a tab cut at the strip's left edge shows no letter, even faintly", async ({ page }) => {
    await start(page);
    await page.goto("/plan/reports");
    const scroller = strip(page).locator(".scroll-fade");
    await expect(strip(page).getByTestId("plan-tab-reports")).toHaveAttribute("aria-current", "page");
    await expect(scroller).toHaveAttribute("data-more-left", "true");
    let last = -1;
    await expect
      .poll(async () => {
        const now = await scroller.evaluate((el) => el.scrollLeft);
        const same = now === last;
        last = now;
        return same;
      })
      .toBe(true);
    const cut = await scroller.evaluate((el) => {
      const box = el.getBoundingClientRect();
      // The fully clear (transparent) run at the left edge, as the stylesheet works it out.
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;height:0";
      probe.style.width = getComputedStyle(el).getPropertyValue("--fade-l0").trim();
      document.body.appendChild(probe);
      const clear = box.left + probe.getBoundingClientRect().width;
      probe.remove();
      const out: { name: string; textRight: number; clear: number }[] = [];
      for (const a of el.querySelectorAll("a")) {
        const r = a.getBoundingClientRect();
        if (!(r.left < box.left - 0.5 && r.right > box.left + 0.5)) continue;
        const range = document.createRange();
        range.selectNodeContents(a);
        out.push({ name: a.textContent ?? "", textRight: range.getBoundingClientRect().right, clear });
      }
      return out;
    });
    // At 390 px the strip opens scrolled to Reports, a tab cut at its left edge.
    expect(cut.length).toBeGreaterThan(0);
    for (const c of cut) expect(c.textRight, c.name).toBeLessThanOrEqual(c.clear + 0.5);
  });
});

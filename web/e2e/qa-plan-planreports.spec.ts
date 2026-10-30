import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA findings on Plan's alignment reports and the Dates tab (qa-plan-9, 23-28, 56, 57),
 * driven through the UI on the mock layer. The "alignment-report" scenario seeds two weekly
 * reports; the default scenario has none. The "date-bases" scenario has ENG-412 verified and
 * ENG-420 proposed.
 */

const ISO_DAY = /\d{4}-\d{2}-\d{2}/;
const strip = (page: Page) => page.getByTestId("plan-tabs").filter({ visible: true });

async function withScenario(page: Page, scenario: string, email?: string) {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

async function openReport(page: Page) {
  await page.goto("/plan/reports");
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
}

test("qa-plan-9, qa-plan-57: report sentences name days as 'Nov 30', horizons as '· Now', and ids in body font", async ({ page }) => {
  await withScenario(page, "alignment-report");
  await openReport(page);
  const first = page.getByTestId("report-track").filter({ visible: true }).first();
  await expect(first).toContainText("Next milestone: First release, Nov 30.");
  const attention = first.getByTestId("needs-attention");
  await expect(attention).toContainText("Daily alert digest email · Now: ENG-405 targets Dec 9, after the milestone date Nov 30.");
  await expect(attention).not.toContainText("(now)");
  await expect(first).toContainText("Verified: ENG-412 supports Nov 30");
  await expect(first).toContainText("Withdrawn: ENG-413 (Dec 15): The team re-estimated");
  for (const t of await page.getByTestId("report-track").filter({ visible: true }).all()) {
    expect(await t.innerText()).not.toMatch(ISO_DAY);
    await expect(t.locator(".font-mono")).toHaveCount(0);
  }
  await expect(page.getByTestId("report-headline").filter({ visible: true })).not.toContainText(ISO_DAY);
});

test("qa-plan-56: the report's totals match the items it lists, and say where they are", async ({ page }) => {
  await withScenario(page, "alignment-report");
  await openReport(page);
  const figures = page.getByTestId("report-figures").filter({ visible: true });
  const figure = async (label: string) => Number(await figures.locator("div", { has: page.getByText(label, { exact: true }) }).locator("dd").innerText());
  const tracks = page.getByTestId("report-track").filter({ visible: true });
  await expect(tracks).toHaveCount(2);

  // Slipping: one figure per slipping item listed under Needs attention.
  const slipping = await page.getByTestId("needs-attention").filter({ visible: true }).getByText(/targets .*after the milestone date|has passed/).count();
  expect(await figure("Dates slipping")).toBe(slipping);
  await expect(page.getByTestId("report-headline").filter({ visible: true })).toContainText(`${slipping} date${slipping === 1 ? "" : "s"} slipping`);

  // Now items without an issue: no more than the tracks' untracked items listed.
  let untracked = 0;
  for (const t of await tracks.all()) untracked += Number((await t.innerText()).match(/(\d+) untracked/)![1]);
  expect(await figure("Now items without an issue")).toBe(untracked);
  await expect(page.getByTestId("report-figures-note").filter({ visible: true })).toContainText("listed under each track's Needs attention");
});

test("qa-plan-23: the alignment reports have their own Plan tab, selected on the list and on a report", async ({ page }) => {
  await withScenario(page, "alignment-report");
  await page.goto("/plan/reports");
  const reports = strip(page).getByTestId("plan-tab-reports");
  await expect(reports).toHaveText("Reports");
  await expect(reports).toHaveAttribute("aria-current", "page");
  await expect(strip(page).locator('[aria-current="page"]')).toHaveCount(1);
  await openReport(page);
  await expect(strip(page).getByTestId("plan-tab-reports")).toHaveAttribute("aria-current", "page");
  await expect(strip(page).locator('[aria-current="page"]')).toHaveCount(1);
});

test("qa-plan-24: with no report yet, Alignment report says so and an owner can Generate now", async ({ page }) => {
  await login(page);
  await page.goto("/plan");
  await page.getByRole("link", { name: "Latest report" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/latest$/);
  const none = page.getByTestId("no-report-yet").filter({ visible: true });
  await expect(none).toContainText("No report yet");
  await none.getByRole("button", { name: "Generate now" }).click();
  await page.getByRole("dialog", { name: "Generate a report now" }).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Alignment so far · week of /);
});

test("qa-plan-24: a viewer with no report yet reads why, with no Generate now", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/plan/reports/latest");
  const none = page.getByTestId("no-report-yet").filter({ visible: true });
  await expect(none).toContainText("No report yet");
  await expect(none).toContainText("An owner can generate one now.");
  await expect(page.getByRole("button", { name: "Generate now" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/plan\/reports\/latest$/);
});

test("qa-plan-25: every Plan tab has the same title and the tab strip at the same height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const ys: number[] = [];
  for (const [path, tab] of [
    ["/plan", "plan-tab-plan"],
    ["/plan/documents", "plan-tab-documents"],
    ["/plan/dates", "plan-tab-dates"],
    ["/plan/outcomes", "plan-tab-outcomes"],
  ] as const) {
    await page.goto(path);
    await expect(strip(page).getByTestId(tab)).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plan");
    // Let the header's chips and action settle.
    await page.waitForTimeout(600);
    ys.push((await strip(page).boundingBox())!.y);
  }
  for (const y of ys) expect(Math.abs(y - ys[0]), `strip at ${ys.join(", ")}`).toBeLessThanOrEqual(1);
});

test("qa-plan-26, qa-plan-27: a withdrawn basis says who withdrew it, its reason on a full-width line; every filter counts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withScenario(page, DATE_BASES_SCENARIO);
  await page.goto("/plan/dates");
  const filter = page.getByTestId("dates-filter");
  for (const name of ["Proposed", "Verified", "Withdrawn", "All"]) {
    await expect(filter.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveText(new RegExp(`^${name}\\s*\\d+$`));
  }
  await filter.getByRole("button", { name: /^Verified/ }).click();
  const row = (ref: string) => page.getByTestId("dates-table").locator(`[data-basis="${ref}"]`).filter({ visible: true });
  await row("ENG-412").getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByTestId("withdraw-basis-dialog");
  await dialog.getByLabel("Reason").fill("The team re-estimated after the vendor moved its own delivery by a month and a half");
  await dialog.getByRole("button", { name: "Withdraw date basis" }).click();
  await expect(dialog).toBeHidden();
  await filter.getByRole("button", { name: /^Withdrawn/ }).click();
  await expect(filter.getByRole("button", { name: /^Withdrawn/ })).toHaveText(/^Withdrawn\s*1$/);
  await expect(row("ENG-412")).toContainText(/Withdrawn by Admin, [A-Z][a-z]{2} \d{1,2}/);
  await expect(row("ENG-412")).not.toContainText("Verified by");
  await expect(row("ENG-412")).not.toContainText("re-estimated");
  const reason = page.getByTestId("dates-table").locator('[data-reason-for="ENG-412"]').filter({ visible: true });
  await expect(reason).toContainText("The team re-estimated");
  const table = (await page.getByTestId("dates-table").filter({ visible: true }).boundingBox())!;
  const box = (await reason.boundingBox())!;
  expect(box.width).toBeGreaterThan(table.width * 0.8);
  expect(box.height).toBeLessThan(50);
});

test("qa-plan-26: on a phone the withdrawal reason has its own line too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withScenario(page, DATE_BASES_SCENARIO);
  await page.goto("/plan/dates");
  await page.getByTestId("dates-filter").getByRole("button", { name: /^Verified/ }).click();
  const row = page.getByTestId("dates-table").locator('[data-basis="ENG-412"]').filter({ visible: true });
  await row.getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByTestId("withdraw-basis-dialog");
  await dialog.getByLabel("Reason").fill("The team re-estimated");
  await dialog.getByRole("button", { name: "Withdraw date basis" }).click();
  await page.getByTestId("dates-filter").getByRole("button", { name: /^Withdrawn/ }).click();
  await expect(row).toContainText("Withdrawn by Admin");
  const reason = page.getByTestId("dates-table").locator('[data-reason-for="ENG-412"]').filter({ visible: true });
  await expect(reason).toContainText("The team re-estimated");
  expect((await reason.boundingBox())!.y).toBeGreaterThanOrEqual((await row.boundingBox())!.y + (await row.boundingBox())!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("qa-plan-28: Add a date source submits as 'Record and verify', marks required fields and names what is missing", async ({ page }) => {
  await withScenario(page, DATE_BASES_SCENARIO);
  await page.goto("/plan/dates");
  await page.getByRole("button", { name: "Add a date source" }).click();
  const dialog = page.getByTestId("date-basis-dialog");
  const submit = dialog.getByRole("button", { name: "Record and verify" });
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Verify", exact: true })).toHaveCount(0);
  await expect(dialog.locator("label [data-required]")).toHaveCount(3);
  const missing = dialog.getByTestId("basis-missing");
  await expect(missing).toContainText("Still needed: a PRD, a reference, the date it supports.");
  await dialog.getByLabel("Reference").fill("ENG-600");
  await expect(missing).toContainText("Still needed: a PRD, the date it supports.");
  await dialog.getByLabel("PRD").selectOption({ index: 1 });
  await dialog.getByLabel("Date it supports").fill("2026-12-01");
  await expect(missing).toHaveCount(0);
  await expect(submit).toBeEnabled();
});

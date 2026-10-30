import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Fix round 4 for Plan › Reports (qa-plan-1, -2, -3, -15), driven through the UI on the mock
 * API as a person would. "alignment-report" is the default company plus two weekly reports;
 * "report-prd-moved" is the same with the Usage alerts PRD's v2 approved after its roadmap was
 * built from v1. The report's tracks are read off the tracks the Plan reads.
 */

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function start(page: Page, scenario?: string) {
  if (scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
}

/** The Plan's Usage alerts track headline, as its track panel says it. */
async function planHeadline(page: Page): Promise<string> {
  await page.goto("/plan");
  const line = visible(page, "plan-track").filter({ hasText: "Usage alerts" }).getByText(/items? needs? attention/).first();
  await expect(line).toBeVisible();
  return (await line.innerText()).trim();
}

/** Plan › Reports › the week of Oct 12; its Usage alerts panel. */
async function openReport(page: Page) {
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-reports").click();
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
  return visible(page, "report-track").filter({ hasText: "Usage alerts PRD" });
}

test("qa-plan-1: the report and the Plan count a track's items needing attention the same way", async ({ page }) => {
  await start(page, "alignment-report");
  const plan = await planHeadline(page);
  expect(plan).toMatch(/1 of 7 items need attention/);
  const track = await openReport(page);
  await expect(track).toContainText(plan);
  await expect(track).not.toContainText("1 of 3 items");
});

test("qa-plan-1: a report made now reads the Plan's count too", async ({ page }) => {
  await start(page);
  const plan = await planHeadline(page);
  await page.goto("/plan/reports");
  await visible(page, "reports-empty").getByRole("button", { name: "Generate now" }).click();
  await page.getByRole("dialog", { name: "Generate a report now" }).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+$/);
  await expect(visible(page, "report-track").filter({ hasText: "Usage alerts PRD" })).toContainText(plan);
});

test("qa-plan-2: the report tells one version story with the Plan and Documents", async ({ page }) => {
  // Only v1 is approved: the report says nothing of a v2.
  await start(page, "alignment-report");
  await page.goto("/plan");
  await expect(visible(page, "plan-prd-card").filter({ hasText: "Usage alerts PRD" }).getByTestId("plan-prd-stage")).toHaveText("Approved v1");
  const track = await openReport(page);
  await expect(track.getByTestId("report-prd-moved")).toHaveCount(0);
  await expect(track).not.toContainText("v2 of the PRD");
});

test("qa-plan-2: with v2 approved, the report, the Plan and Documents all say v2", async ({ page }) => {
  await start(page, "report-prd-moved");
  await page.goto("/plan");
  await expect(visible(page, "plan-prd-card").filter({ hasText: "Usage alerts PRD" }).getByTestId("plan-prd-stage")).toHaveText("Approved v2");
  const track = await openReport(page);
  await expect(track.getByTestId("report-prd-moved")).toContainText("v2 of the PRD is approved");
  await page.goto("/plan/documents");
  await expect(visible(page, "approved-prd").filter({ hasText: "Usage alerts PRD" })).toContainText("v2 approved");
});

test("qa-plan-3: the report's roadmap link lands on that PRD's Build roadmap", async ({ page }) => {
  await start(page, "report-prd-moved");
  const track = await openReport(page);
  const moved = track.getByTestId("report-prd-moved");
  await expect(moved).not.toContainText("Update the roadmap");
  await moved.getByRole("link", { name: "Build the roadmap from it" }).click();
  await expect(page).toHaveURL(/\/plan\/documents\?prd=usage-alerts$/);
  // The PRD is picked: its inspector offers Build roadmap.
  const inspector = visible(page, "roadmap-inspector");
  await expect(inspector).toContainText("Usage alerts PRD");
  await inspector.getByRole("button", { name: "Build roadmap" }).click();
  await expect(page.getByRole("dialog", { name: "Build roadmap" })).toContainText("Usage alerts PRD v2");
});

test("qa-plan-15: with no report, Generate now is offered once, in the empty state", async ({ page }) => {
  await start(page);
  await page.goto("/plan/reports");
  await expect(visible(page, "reports-empty").getByRole("button", { name: "Generate now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate now" }).filter({ visible: true })).toHaveCount(1);
});

test("qa-plan-15: with reports, Generate now sits in the header", async ({ page }) => {
  await start(page, "alignment-report");
  await page.goto("/plan/reports");
  await expect(visible(page, "reports-table")).toBeVisible();
  await expect(page.locator("header[data-page-header]").filter({ visible: true }).getByRole("button", { name: "Generate now" })).toBeVisible();
});

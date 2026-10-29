import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA fixes on the bodies of Plan's Reports, Dates, Roadmap documents and Outcomes tabs
 * (qa-plan-3, 40-51), driven through the UI on the mock layer as a person would. The
 * "alignment-report" scenario seeds two weekly reports (Usage alerts at risk in the week of
 * Oct 12); the default scenario has no report and no outcome; "date-bases" has ENG-412
 * verified and ENG-420 proposed, nothing withdrawn.
 */

const PHONE = { width: 390, height: 844 };
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function start(page: Page, opts: { scenario?: string; email?: string } = {}) {
  if (opts.scenario) await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [MOCK_SCENARIO_KEY, opts.scenario] as const);
  await login(page, opts.email);
}

/** Plan › Reports › the week of Oct 12, from the tab strip. */
async function openReport(page: Page) {
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-reports").click();
  await expect(page).toHaveURL(/\/plan\/reports$/);
  await page.getByRole("link", { name: /week of Oct 12/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
  return visible(page, "report-track").first();
}

/* ------------------------------------------ Reports ------------------------------------------ */

test("qa-plan-3, qa-plan-41: the slipping date is pinned on the item that owns ENG-405, named as on the Plan", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  const track = await openReport(page);
  const attention = track.getByTestId("needs-attention");
  await expect(attention).toContainText("Daily alert digest email · Now: ENG-405 targets Dec 9");
  await expect(attention).not.toContainText("Threshold alerts");
  const drift = track.getByTestId("report-drift").first();
  await expect(drift.getByRole("link")).toHaveText("Spend forecast for the month");
  await expect(track).not.toContainText("Digest emails");

  // The item opens on the Plan, where ENG-405 is its issue.
  await expect(attention.getByRole("link", { name: "Daily alert digest email" })).toHaveAttribute(
    "href",
    "/plan?item=usage-alerts:alert-digest",
  );
});

test("qa-plan-42: the withdrawal reason is the one recorded, as the Dates tab shows it", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  const track = await openReport(page);
  await expect(track).toContainText("Withdrawn: ENG-413 (Dec 15): The team re-estimated");
  await expect(track).not.toContainText("Estimate replaced");
});

test("qa-plan-43: a PRD that moved on says which version is approved and links to updating the roadmap", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  const track = await openReport(page);
  const moved = track.getByTestId("report-prd-moved");
  await expect(moved).toHaveText("v2 of the PRD is approved · Update the roadmap");
  const update = moved.getByRole("link", { name: "Update the roadmap" });
  await expect(update).toHaveAttribute("href", "/plan?item=usage-alerts");
  await update.click();
  await expect(page).toHaveURL(/\/plan(\?|$)/);
});

test("qa-plan-44: Covers reads 'Oct 12 – Oct 18' with the time zone said once, nothing wrapped mid-time", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  await openReport(page);
  const covers = visible(page, "report-covers");
  await expect(covers).toHaveText("Oct 12 – Oct 18");
  const rail = visible(page, "report-rail");
  await expect(rail.getByText(/^Times in Pacific Time/)).toHaveCount(1);
  await expect(visible(page, "report-made")).not.toContainText(/P[DS]T/);
  await expect(covers).not.toContainText("12:00 AM");
});

test("qa-plan-44: a report for the week so far ends at its moment, on one line each side", async ({ page }) => {
  await start(page);
  await page.goto("/plan/reports");
  await visible(page, "reports-empty").getByRole("button", { name: "Generate now" }).click();
  await page.getByRole("dialog", { name: "Generate a report now" }).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/reports\/[0-9a-f-]+$/);
  const covers = visible(page, "report-covers");
  await expect(covers).toHaveText(/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M$/);
  for (const part of await covers.locator("span").all()) {
    const box = (await part.boundingBox())!;
    expect(box.height).toBeLessThan(30);
  }
});

test("qa-plan-45: drift chips sit centred on their line with a steady gap before the words", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  const track = await openReport(page);
  const rows = track.getByTestId("report-drift");
  await expect(rows).toHaveCount(2);
  const gaps: number[] = [];
  for (const row of await rows.all()) {
    const chip = (await row.locator(":scope > span").first().boundingBox())!;
    const words = (await row.locator(":scope > span").nth(1).boundingBox())!;
    gaps.push(words.x - (chip.x + chip.width));
    expect(Math.abs(chip.y + chip.height / 2 - (words.y + words.height / 2))).toBeLessThanOrEqual(2);
  }
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(6);
    expect(Math.abs(gap - gaps[0])).toBeLessThanOrEqual(1);
  }
});

test("qa-plan-40: with no report, the list is headed Reports with no 0, and offers Generate now", async ({ page }) => {
  await start(page);
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-reports").click();
  const panel = visible(page, "reports-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Reports");
  await expect(panel).not.toContainText("Every report");
  await expect(panel.getByTestId("panel-count")).toHaveCount(0);
  const empty = panel.getByTestId("reports-empty");
  await expect(empty).toContainText("No report yet");
  await empty.getByRole("button", { name: "Generate now" }).click();
  await expect(page.getByRole("dialog", { name: "Generate a report now" })).toBeVisible();
});

test("qa-plan-40: a viewer's empty list says who can generate, with no button", async ({ page }) => {
  await start(page, { email: "viewer@example.com" });
  await page.goto("/plan/reports");
  const empty = visible(page, "reports-empty");
  await expect(empty).toContainText("An owner can generate one now.");
  await expect(empty.getByRole("button", { name: "Generate now" })).toHaveCount(0);
});

/* ------------------------------------------- Dates ------------------------------------------- */

test("qa-plan-46: the actions column is labelled and a withdrawal's reason sits in its row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await start(page, { scenario: DATE_BASES_SCENARIO });
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-dates").click();
  const table = visible(page, "dates-table");
  await expect(table.getByRole("columnheader", { name: "Actions" })).toBeVisible();
  await page.getByTestId("dates-filter").getByRole("button", { name: /^Verified/ }).click();
  const row = table.locator('[data-basis="ENG-412"]');
  await row.getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByTestId("withdraw-basis-dialog");
  await dialog.getByLabel("Reason").fill("The team re-estimated");
  await dialog.getByRole("button", { name: "Withdraw date basis" }).click();
  await expect(dialog).toBeHidden();
  await page.getByTestId("dates-filter").getByRole("button", { name: /^Withdrawn/ }).click();
  const reason = table.locator('[data-reason-for="ENG-412"]');
  await expect(reason).toContainText("Why it was withdrawn: The team re-estimated");
  // A styled sub-row: a rule on its left and a tint, right under its row.
  const style = await reason.evaluate((el) => {
    const s = getComputedStyle(el);
    return { rule: parseFloat(s.borderLeftWidth), tint: s.backgroundColor };
  });
  expect(style.rule).toBeGreaterThanOrEqual(2);
  expect(style.tint).not.toBe("rgba(0, 0, 0, 0)");
  const r = (await row.boundingBox())!;
  const b = (await reason.boundingBox())!;
  expect(b.y - (r.y + r.height)).toBeLessThan(8);
});

test("qa-plan-47: a filter with nothing in it is dimmed and cannot be picked", async ({ page }) => {
  await start(page, { scenario: DATE_BASES_SCENARIO });
  await page.goto("/plan/dates");
  const filter = page.getByTestId("dates-filter");
  const withdrawn = filter.getByRole("button", { name: /^Withdrawn/ });
  await expect(withdrawn).toHaveText(/^Withdrawn\s*0$/);
  await expect(withdrawn).toBeDisabled();
  expect(Number(await withdrawn.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  await expect(filter.getByRole("button", { name: /^Verified/ })).toBeEnabled();
});

/* ------------------------------------------ Outcomes ------------------------------------------ */

test("qa-plan-48: with no outcome, Outcomes shows only the empty state and its action", async ({ page }) => {
  await start(page);
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByTestId("plan-tab-outcomes").click();
  const empty = visible(page, "outcomes-empty");
  await expect(empty).toContainText("No outcomes yet");
  await expect(page.getByTestId("outcome-filters")).toHaveCount(0);
  await expect(page.getByTestId("outcomes-table")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Predicted" })).toHaveCount(0);
  await empty.getByRole("button", { name: "Track outcome" }).click();
  await expect(page.getByTestId("track-outcome-form")).toBeVisible();
});

test("qa-plan-48: a viewer's empty Outcomes has no action", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-role", "viewer"));
  await start(page);
  await page.goto("/plan/outcomes");
  const empty = visible(page, "outcomes-empty");
  await expect(empty).toContainText("No outcomes yet");
  await expect(empty.getByRole("button")).toHaveCount(0);
});

/* ------------------------------------- Roadmap documents ------------------------------------- */

test("qa-plan-49: approved PRDs have their own table and headers, not the roadmaps'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.goto("/plan");
  await visible(page, "plan-tabs").getByRole("link", { name: "Roadmap documents" }).click();
  await expect(page).toHaveURL(/\/plan\/documents$/);
  const roadmaps = page.getByTestId("roadmaps-table");
  await expect(roadmaps.getByTestId("approved-prd")).toHaveCount(0);
  const prds = page.getByTestId("approved-prds-table");
  await expect(prds.getByRole("columnheader")).toContainText(["Approved PRD", "Approved", "Roadmaps built"]);
  await expect(prds.getByRole("columnheader", { name: "Template" })).toHaveCount(0);
  const prd = prds.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" });
  await expect(prd).toContainText("v1 approved");
  // "v1 approved" sits under Approved.
  const head = (await prds.getByRole("columnheader", { name: "Approved", exact: true }).boundingBox())!;
  const chip = (await prd.getByText("v1 approved").boundingBox())!;
  expect(chip.x).toBeGreaterThanOrEqual(head.x - 1);
  expect(chip.x + chip.width).toBeLessThanOrEqual(head.x + head.width + 1);
});

test("qa-plan-50: a roadmap never approved shows a 'Not approved yet' chip, not a big figure", async ({ page }) => {
  await start(page);
  await page.goto("/plan/documents");
  const inspector = page.getByTestId("roadmap-inspector");
  const chip = inspector.getByTestId("roadmap-not-approved");
  await expect(chip).toHaveText("Not approved yet");
  expect(parseFloat(await chip.evaluate((el) => getComputedStyle(el).fontSize))).toBeLessThanOrEqual(15);
  await expect(inspector).not.toContainText(/Not yet\s*Approved/);
});

test("qa-plan-51: on a phone every link in the documents tables is at least 24 x 24 px", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await start(page);
  await page.goto("/plan/documents");
  const links = page.locator('[data-testid="roadmaps-table"] a, [data-testid="approved-prds-table"] a').filter({ visible: true });
  await expect(links.first()).toBeVisible();
  for (const link of await links.all()) {
    const box = (await link.boundingBox())!;
    expect(box.height, await link.innerText()).toBeGreaterThanOrEqual(24);
    expect(box.width, await link.innerText()).toBeGreaterThanOrEqual(24);
  }
});

import { expect, test, type Page } from "./test";

import { DATE_BASES_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * Fix round 4 for the Plan's tab strip and its Dates, Documents and Outcomes tabs (qa-plan-15,
 * -16, -17, -18, -19, -20, -21, -22, -23, -24, -25, -26, -27, -59), driven through the UI on the
 * mock API as a person would, on a desktop and a phone (390x844). The default company has one
 * track, no outcome and no learning; "date-bases" has ENG-412 verified and ENG-420 proposed.
 */

const PHONE = { width: 390, height: 844 };
const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const strip = (page: Page) => visible(page, "plan-tabs");
const links = (page: Page) => visible(page, "plan-links");
const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });

async function start(page: Page, opts: { scenario?: string; theme?: "light" | "dark" } = {}) {
  if (opts.scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, opts.scenario] as const);
  if (opts.theme) await page.addInitScript(([k, t]) => localStorage.setItem(k, t), [THEME_KEY, opts.theme] as const);
  await login(page);
}

/* ------------------------------------------ The strip ------------------------------------------ */

test("qa-plan-16: Launches and Changelog keep the Plan tab strip, their own link selected", async ({ page }) => {
  await start(page);
  await page.goto("/plan");
  await links(page).getByRole("link", { name: "Launches" }).click();
  await expect(page).toHaveURL(/\/roadmap\/launches$/);
  await expect(strip(page)).toBeVisible();
  await expect(links(page).getByRole("link", { name: "Launches" })).toHaveAttribute("aria-current", "page");
  await links(page).getByRole("link", { name: "Changelog" }).click();
  await expect(page).toHaveURL(/\/roadmap\/changelog$/);
  await expect(links(page).getByRole("link", { name: "Changelog" })).toHaveAttribute("aria-current", "page");
  await expect(links(page).getByRole("link", { name: "Launches" })).not.toHaveAttribute("aria-current", "page");
  // The strip's Plan tab leads back.
  await strip(page).getByTestId("plan-tab-plan").click();
  await expect(page).toHaveURL(/\/plan$/);
});

test("qa-plan-17: the newest report and the list are two entries with two names", async ({ page }) => {
  await start(page, { scenario: "alignment-report" });
  await page.goto("/plan");
  await expect(links(page).getByRole("link")).toHaveText(["Latest report", "Launches", "Changelog"]);
  await expect(page.getByRole("link", { name: "Alignment report" })).toHaveCount(0);
  await links(page).getByRole("link", { name: "Latest report" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weekly alignment · week of Oct 12");
  await strip(page).getByTestId("plan-tab-reports").click();
  await expect(page).toHaveURL(/\/plan\/reports$/);
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-plan-18: the Plan tabs are one row that scrolls, Reports never alone on a second row", async ({ page }) => {
    await start(page);
    await page.goto("/plan");
    const reports = strip(page).getByTestId("plan-tab-reports");
    await reports.scrollIntoViewIfNeeded();
    // Both measured after the scroll, so a page that scrolled to bring Reports in moves both alike.
    const plan = (await strip(page).getByTestId("plan-tab-plan").boundingBox())!;
    const r = (await reports.boundingBox())!;
    expect(Math.abs(r.y - plan.y)).toBeLessThanOrEqual(1);
    await reports.click();
    await expect(page).toHaveURL(/\/plan\/reports$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });

  test("qa-plan-19: the Dates filters are one row, and a filter reading 0 is an ordinary chip", async ({ page }) => {
    await start(page, { scenario: DATE_BASES_SCENARIO });
    await page.goto("/plan/dates");
    const filter = visible(page, "dates-filter");
    const chips = filter.getByRole("button");
    await expect(chips).toHaveCount(4);
    const first = (await chips.first().boundingBox())!;
    for (const chip of await chips.all()) {
      await chip.scrollIntoViewIfNeeded();
      expect(Math.abs((await chip.boundingBox())!.y - first.y)).toBeLessThanOrEqual(1);
    }
    const withdrawn = filter.getByRole("button", { name: /^Withdrawn/ });
    await expect(withdrawn).toHaveText(/^Withdrawn\s*0$/);
    await expect(withdrawn).toBeEnabled();
    expect(Number(await withdrawn.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });
});

/* ------------------------------------------ Dates ------------------------------------------ */

test("qa-plan-20: Withdraw is an outlined row button, not plain grey text", async ({ page }) => {
  await start(page, { scenario: DATE_BASES_SCENARIO });
  await page.goto("/plan/dates");
  await visible(page, "dates-filter").getByRole("button", { name: /^Verified/ }).click();
  const withdraw = visible(page, "dates-table").locator('[data-basis="ENG-412"]').filter({ visible: true }).getByRole("button", { name: "Withdraw" });
  await expect(withdraw).toBeVisible();
  const border = await withdraw.evaluate((el) => ({ width: getComputedStyle(el).borderTopWidth, color: getComputedStyle(el).borderTopColor }));
  expect(border.width).not.toBe("0px");
  expect(border.color).not.toBe("rgba(0, 0, 0, 0)");
});

test("qa-plan-21: Dates says Add a date source, not Record basis", async ({ page }) => {
  await start(page, { scenario: DATE_BASES_SCENARIO });
  await page.goto("/plan/dates");
  await expect(page.getByRole("button", { name: "Record basis" })).toHaveCount(0);
  await header(page).getByRole("button", { name: "Add a date source" }).click();
  await expect(page.getByRole("dialog", { name: "Add a date source" })).toBeVisible();
});

test("qa-plan-59: Dates has summary chips by its title, as the other tabs do", async ({ page }) => {
  await start(page, { scenario: DATE_BASES_SCENARIO });
  await page.goto("/plan/dates");
  const summary = header(page).getByTestId("dates-summary");
  await expect(summary).toContainText("1 proposed");
  await expect(summary).toContainText("1 verified");
  await expect(summary).not.toContainText("withdrawn");
});

/* ------------------------------------------ Documents ------------------------------------------ */

test("qa-plan-22: the roadmap inspector puts each label before its value", async ({ page }) => {
  await start(page);
  await page.goto("/plan/documents");
  const inspector = visible(page, "roadmap-inspector");
  const chip = inspector.getByTestId("roadmap-not-approved");
  await expect(chip).toHaveText("Not approved yet");
  const label = (await inspector.getByTestId("roadmap-versions").getByText("Approved", { exact: true }).boundingBox())!;
  const value = (await chip.boundingBox())!;
  // The label comes first: left of its value on its line, never under it.
  expect(label.x + label.width).toBeLessThanOrEqual(value.x);
  expect(label.y).toBeLessThan(value.y + value.height);
});

test("qa-plan-23: in the light theme the Documents inspector head is white like the Plan's", async ({ page }) => {
  await start(page, { theme: "light" });
  await page.goto("/plan/documents");
  const inspector = visible(page, "roadmap-inspector");
  await expect(inspector).toBeVisible();
  const head = inspector.locator("[data-inspector-head]");
  await expect(head).toHaveAttribute("data-inspector-head", "card");
  expect(await head.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(255, 255, 255)");
});

test("qa-plan-24, qa-plan-25: Build roadmap fits a 900 px window with its footer in view, and says Estimate cost", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.goto("/plan/documents");
  await visible(page, "approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  const box = (await dialog.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  const estimate = dialog.getByTestId("dialog-footer").getByRole("button", { name: "Estimate cost", exact: true });
  await expect(estimate).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Estimate", exact: true })).toHaveCount(0);
});

/* ------------------------------------------ Outcomes ------------------------------------------ */

test("qa-plan-15: with no outcome, Track outcome is offered once, in the empty state", async ({ page }) => {
  await start(page);
  await page.goto("/plan/outcomes");
  await expect(visible(page, "outcomes-empty").getByRole("button", { name: "Track outcome" })).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Track outcome" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Track outcome" }).filter({ visible: true })).toHaveCount(1);
});

test("qa-plan-26: Add learning names what a learning is about and what Oracle does with it", async ({ page }) => {
  await start(page);
  await page.goto("/plan/outcomes");
  await visible(page, "learnings-panel").getByRole("button", { name: "Add learning" }).click();
  const form = visible(page, "learning-form");
  await expect(form).not.toContainText("Applies to");
  await expect(form).not.toContainText("Direction");
  await expect(form.getByLabel("What it is about").locator("option")).toHaveText(["A part of Oracle", "A kind of interview question", "A quality check"]);
  await expect(form.getByLabel("Which kind of question").locator("option").first()).toHaveText("Pick one");
  await expect(form.getByLabel("What Oracle should do").locator("option")).toHaveText(["Suggest it more often", "Suggest it less often", "Just keep it in mind"]);
});

test("qa-plan-27: the Learnings count is neutral text, not an accent figure", async ({ page }) => {
  await start(page);
  await page.goto("/plan/outcomes");
  const count = visible(page, "learnings-panel").getByTestId("panel-count");
  await expect(count).toHaveText("0");
  const [color, text2] = await Promise.all([
    count.locator("span").evaluate((e) => getComputedStyle(e).color),
    visible(page, "learnings-empty").evaluate((e) => getComputedStyle(e).color),
  ]);
  expect(color).toBe(text2);
});

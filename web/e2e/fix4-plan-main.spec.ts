import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Fix round 4 for the Plan's Roadmap table, item inspector, tracks and header (qa-plan-5, -8, -9,
 * -28 to -34, -60, -61), driven through the UI on the mock layer as an owner would, on a desktop
 * (1440x900) and a phone (390x844).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });
const track = (page: Page) => page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(rows(page).first()).toBeVisible();
}

async function box(l: Locator) {
  await expect(l).toBeVisible();
  return (await l.boundingBox())!;
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-plan-5: the inspector's Engineering says which date the row shows", async ({ page }) => {
    await openPlan(page);
    await expect(row(page, "Threshold alerts on spend").getByTestId("plan-engineering")).toHaveText("ENG-402 · Nov 20 ✓");
    await expect(inspector(page).getByRole("heading", { name: "Threshold alerts on spend" })).toBeVisible();
    const eng = inspector(page).getByTestId("plan-item-engineering");
    await expect(eng.getByTestId("plan-record")).toContainText("ENG-402 · In progress · no due date in the tracker");
    await expect(eng.getByTestId("plan-record-date")).toHaveText("The roadmap shows Nov 20 ✓, the verified date (see Date), not a tracker due date.");
    await expect(eng).not.toContainText("· no date");
  });

  test("qa-plan-28: Check now says the result, then Nothing changed", async ({ page }) => {
    await openPlan(page);
    const t = track(page);
    await t.getByRole("button", { name: "Check now" }).click();
    const result = t.getByTestId("track-result");
    await expect(result).toContainText("Now at risk; 1 item at risk");
    await expect(result).not.toContainText("Checked: changed");
    await t.getByRole("button", { name: "Check now" }).click();
    await expect(result).toHaveText("Nothing changed since the last check.");
  });

  test("qa-plan-29: Next reads who decides in one sentence, on the row and in the inspector", async ({ page }) => {
    await openPlan(page);
    await expect(row(page, "Daily alert digest email").getByTestId("plan-next")).toHaveText("Owners decide on the slip");
    await expect(row(page, "One-page checkout").getByTestId("plan-next").getByRole("link", { name: "Review the PRD" })).toBeVisible();
    await row(page, "Daily alert digest email").getByTestId("plan-title").click();
    await expect(inspector(page).getByTestId("plan-why-next")).toHaveText("Owners decide on the slip");
    await expect(inspector(page)).not.toContainText("Decide on slip");
  });

  test("qa-plan-29: a viewer reads Waiting on approvers to review the PRD", async ({ page }) => {
    await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, "viewer"] as const);
    await openPlan(page);
    await expect(row(page, "One-page checkout").getByTestId("plan-next")).toHaveText("Waiting on approvers to review the PRD");
  });

  test("qa-plan-30: state pills hold one line; the rest sits below, outside the pill", async ({ page }) => {
    await openPlan(page);
    for (const [title, whole, pill] of [
      ["Spend forecast for the month", "Proposed · Next → Now", "Proposed"],
      ["Budgets per team", "Dropped in draft 2 (was Planned)", "Dropped"],
    ] as const) {
      const state = row(page, title).getByTestId("plan-state");
      await expect(state).toHaveText(whole);
      const chip = state.locator("[data-kind]");
      await expect(chip).toHaveText(pill);
      expect((await box(chip)).height, `${pill} pill on one line`).toBeLessThanOrEqual(27);
    }
  });

  test("qa-plan-33: inspector eyebrows name the kind only", async ({ page }) => {
    await openPlan(page);
    await expect(inspector(page)).toContainText("Item");
    await expect(inspector(page)).not.toContainText("· selected");
    await track(page).getByTestId("track-milestone").filter({ hasText: "First release" }).click();
    const m = page.getByTestId("plan-milestone").filter({ visible: true });
    await expect(m).toContainText("Milestone");
    await expect(m).not.toContainText("· selected");
    await page.goto("/plan/documents");
    await expect(page.getByText("Roadmap · selected")).toHaveCount(0);
    await expect(page.getByText("PRD · selected")).toHaveCount(0);
  });

  test("qa-plan-60: the Show switch sits in the Roadmap header", async ({ page }) => {
    await openPlan(page);
    const scope = page.getByTestId("plan-scope-bar").filter({ visible: true });
    await expect(scope.getByRole("group", { name: "Plan scope" })).toBeVisible();
    // In the same head as Group by, above the table.
    // The head's other parts (the roadmaps' names) arrive with their own query: wait for it to settle.
    const groupByGroup = page.getByRole("group", { name: "Group by" }).filter({ visible: true });
    await expect.poll(async () => Math.abs((await box(scope)).y - (await box(groupByGroup)).y)).toBeLessThanOrEqual(40);
    const s = await box(scope);
    const table = await box(page.getByTestId("plan-table"));
    expect(s.y).toBeLessThan(table.y);
    const goals = await box(page.getByTestId("plan-goals").filter({ visible: true }));
    expect(s.y, "below the goals, not between the tabs and Goals").toBeGreaterThan(goals.y + goals.height);
  });

  test("qa-plan-61: a paused track says what pausing stops, and Check now waits for Active", async ({ page }) => {
    await openPlan(page);
    const t = track(page);
    await t.getByRole("group", { name: "Track status" }).getByRole("button", { name: "Paused" }).click();
    await expect(t.getByTestId("track-health")).toHaveText("Paused");
    await expect(t).toContainText("Paused: not checked hourly and raises no alerts, and updates take no dates from it. Reports still list it.");
    const check = t.getByRole("button", { name: "Check now" });
    await expect(check).toBeDisabled();
    await expect(check).toHaveAccessibleDescription("Paused tracks are not checked. Set it Active to check it.");
    await t.getByRole("group", { name: "Track status" }).getByRole("button", { name: "Active" }).click();
    await expect(t.getByRole("button", { name: "Check now" })).toBeEnabled();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-plan-8: a milestone's name wraps under its dates, never cut", async ({ page }) => {
    await openPlan(page);
    const m1 = track(page).getByTestId("track-milestone").filter({ hasText: "First release" });
    const name = m1.getByTestId("milestone-name-line");
    await expect(name).toHaveText("First release");
    expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const dates = await box(m1.getByTestId("milestone-title"));
    const n = await box(name);
    expect(n.y, "the name under the dates").toBeGreaterThanOrEqual(dates.y + dates.height - 1);
    expect(n.width).toBeGreaterThan(80);
  });

  test("qa-plan-9: an owner reaches Edit plan and the live roadmap on a phone", async ({ page }) => {
    await openPlan(page);
    await expect(page.getByTestId("plan-live-version").filter({ visible: true })).toHaveText("Usage alerts roadmap v1");
    const edit = page.getByTestId("plan-edit").filter({ visible: true });
    await expect(edit).toBeVisible();
    await edit.click();
    await expect(page.getByTestId("edit-item").filter({ visible: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("qa-plan-31: group headers read Now · 7", async ({ page }) => {
    await openPlan(page);
    const groups = page.getByTestId("plan-group").filter({ visible: true });
    await expect(groups.first()).toBeVisible();
    const texts = (await groups.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(texts).toEqual(["Now · 7", "Next · 1", "Later · 2"]);
  });

  test("qa-plan-32: the item sheet shows the title once and no second scrollbar", async ({ page }) => {
    await openPlan(page);
    await row(page, "Daily alert digest email").getByTestId("plan-title").click();
    const sheet = page.getByTestId("sheet-plan-item");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Daily alert digest email" })).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: "Item", exact: true })).toHaveCount(1);
    await expect(sheet).not.toContainText("· selected");
    const body = sheet.getByTestId("sheet-plan-item-body");
    const bar = await body.evaluate((el) => ({
      w: (el as HTMLElement).offsetWidth - el.clientWidth,
      sw: getComputedStyle(el).scrollbarWidth,
    }));
    expect(bar.w, "no visible scrollbar gutter").toBe(0);
    expect(bar.sw).toBe("none");
  });

  test("qa-plan-34: a goal's value and target on one line", async ({ page }) => {
    await openPlan(page);
    const fig = page.getByTestId("plan-goals").filter({ visible: true }).getByTestId("goal-figure").filter({ hasText: "/" }).first();
    const value = await box(fig.locator("b"));
    const target = await box(fig.locator("span").filter({ hasText: /^\// }));
    expect(Math.abs(target.y + target.height - (value.y + value.height)), "on the value's line").toBeLessThanOrEqual(12);
    expect(target.x).toBeGreaterThan(value.x + value.width - 1);
  });
});

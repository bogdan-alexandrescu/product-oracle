import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA round 4 fixes on the main Plan page (qa4-plan-18, -20, -21, -23 to -27, -30): the roadmap
 * table, the track card, the inspector and Edit plan, driven through the UI on the mock layer as
 * an owner would, on a desktop (1440x900) and a phone (390x844).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const inspector = (page: Page) => page.getByTestId("plan-inspector").filter({ visible: true });
const track = (page: Page) => page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
const milestoneEditor = (page: Page) => page.getByTestId("plan-milestone").filter({ visible: true });
const editItem = (page: Page, title: string) => page.getByTestId("edit-item").filter({ visible: true }).filter({ hasText: title });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(rows(page).first()).toBeVisible();
}

async function openEditPlan(page: Page) {
  await openPlan(page);
  await page.getByTestId("plan-edit").click();
  await expect(editItem(page, "Budgets per team")).toBeVisible();
}

async function box(l: Locator) {
  await expect(l).toBeVisible();
  return (await l.boundingBox())!;
}

const border = (l: Locator) =>
  l.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: parseFloat(s.borderTopWidth), style: s.borderTopStyle };
  });

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-plan-18: the milestone's Horizon and Status buttons fill their box", async ({ page }) => {
    await openPlan(page);
    await track(page).getByTestId("track-milestone").filter({ hasText: "First release" }).click();
    const m = milestoneEditor(page);
    for (const name of ["Horizon", "Milestone status"]) {
      const group = m.getByRole("group", { name, exact: true });
      const g = await box(group);
      const buttons = group.getByRole("button");
      const last = await box(buttons.last());
      const first = await box(buttons.first());
      // The segments share the whole box: no empty room left inside it on the right.
      expect(g.x + g.width - (last.x + last.width)).toBeLessThanOrEqual(2);
      expect(first.x - g.x).toBeLessThanOrEqual(2);
    }
  });

  test("qa4-plan-20: picking a milestone leaves no roadmap row highlighted", async ({ page }) => {
    await openPlan(page);
    await row(page, "Threshold alerts on spend").getByTestId("plan-title").click();
    await expect(row(page, "Threshold alerts on spend")).toHaveAttribute("aria-selected", "true");
    await track(page).getByTestId("track-milestone").filter({ hasText: "First release" }).click();
    await expect(milestoneEditor(page)).toContainText("Milestone");
    await expect(rows(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(0);
    // Picking a row again shows it, highlighted.
    await row(page, "Alert rules API").getByTestId("plan-title").click();
    await expect(row(page, "Alert rules API")).toHaveAttribute("aria-selected", "true");
  });

  test("qa4-plan-21: Edit plan's Up, Down and Defer are outlined buttons; a disabled one is dashed", async ({ page }) => {
    await openEditPlan(page);
    const now = editItem(page, "Threshold alerts on spend");
    const up = now.getByRole("button", { name: "Move Threshold alerts on spend up" });
    const down = now.getByRole("button", { name: "Move Threshold alerts on spend down" });
    const defer = now.getByRole("button", { name: "Defer" });
    await expect(up).toBeDisabled();
    await expect(down).toBeEnabled();
    for (const b of [down, defer]) {
      const line = await border(b);
      expect(line.width).toBeGreaterThanOrEqual(1);
      expect(line.style).toBe("solid");
    }
    const off = await border(up);
    expect(off.width).toBeGreaterThanOrEqual(1);
    expect(off.style).toBe("dashed");
  });

  test("qa4-plan-23: Edit plan's add form says a new item is not in the baseline", async ({ page }) => {
    await openEditPlan(page);
    const form = page.getByRole("form", { name: "Add an item" });
    const pick = form.getByRole("combobox", { name: "Baseline feature" });
    await expect(pick.locator("option:checked")).toHaveText("New: not in the baseline");
    await expect(form).toContainText("Baseline feature");
    await expect(form).not.toContainText("From Baseline");
    await expect(form).not.toContainText("A new item");
  });

  test("qa4-plan-24: a goal with no confidence says so in words, with no empty ring", async ({ page }) => {
    await openPlan(page);
    const g1 = page.getByTestId("plan-goals").getByTestId("home-goal-G1");
    await expect(g1).toContainText("Raise activation");
    await expect(g1.getByTestId("goal-confidence")).toHaveText("No confidence yet: add evidence");
    await expect(g1.getByRole("img", { name: /confidence/i })).toHaveCount(0);
  });

  test("qa4-plan-26: the track headline counts one item once, with both its reasons", async ({ page }) => {
    await openPlan(page);
    const t = track(page);
    await expect(t).toContainText("At risk: 1 of 7 items needs attention (may be out of date and slipping).");
    await expect(t).not.toContainText("1 may be out of date, 1 slipping");
  });

  test("qa4-plan-27: an item's History reads as plain sentences", async ({ page }) => {
    await openPlan(page);
    await row(page, "Spend forecast for the month").getByTestId("plan-title").click();
    const lines = inspector(page).getByTestId("plan-history").getByTestId("plan-history-version");
    await expect(lines).toHaveText(["Added to Next in draft 1 from PRD v1", "Moved to Now in draft 2 from PRD v1"]);
    await expect(inspector(page).getByTestId("plan-history")).not.toContainText("· in a draft");
  });

  test("qa4-plan-30: a GitHub issue on a row reads Issue 418, not its raw reference", async ({ page }) => {
    await openPlan(page);
    const eng = row(page, "Spend forecast for the month").getByTestId("plan-engineering");
    await expect(eng).toHaveText("Issue 418 · Nov 30 ✓");
    await expect(eng).not.toContainText("acme/app");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-plan-25: a row with three goals says +2 goals, without a hover", async ({ page }) => {
    await openPlan(page);
    const more = row(page, "Usage dashboard").getByTestId("plan-goal").getByTestId("plan-goal-more");
    await expect(more).toHaveText("+2 goals");
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("qa4-plan-30: on a phone the row's engineering names the issue in words", async ({ page }) => {
    await openPlan(page);
    const r = row(page, "Spend forecast for the month");
    await expect(r).toContainText("Issue 418");
    await expect(r).not.toContainText("acme/app#418");
  });
});

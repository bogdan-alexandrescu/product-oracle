import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA round 4 fixes on the main Plan page (qa4-plan-3, -4, -18, -20 to -27, -30): the roadmap
 * table, the track card, the inspector and Edit plan, driven through the UI on the mock layer as
 * an owner would, on a desktop (1440x900) and a phone (390x844). By default usage-alerts-roadmap
 * v1 is in review; "plan-decider" has it approved, "roadmap-diff" approved with a draft 2.
 */

const inScenario = (page: Page, s: "plan-decider" | "roadmap-diff") =>
  page.addInitScript(([key, v]) => localStorage.setItem(key, v), [MOCK_SCENARIO_KEY, s] as const);

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
  await inScenario(page, "plan-decider");
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
    await inScenario(page, "roadmap-diff");
    await openPlan(page);
    await row(page, "Spend forecast for the month").getByTestId("plan-title").click();
    const lines = inspector(page).getByTestId("plan-history").getByTestId("plan-history-version");
    await expect(lines).toHaveText(["Added to Next in version 1 from PRD v1, approved Oct 5", "Moved to Now in draft 2 from PRD v1"]);
    await expect(inspector(page).getByTestId("plan-history")).not.toContainText("· in a draft");
  });

  test("qa4-plan-30: a GitHub issue on a row reads Issue 418, not its raw reference", async ({ page }) => {
    await openPlan(page);
    const eng = row(page, "Spend forecast for the month").getByTestId("plan-engineering");
    await expect(eng).toHaveText("Issue 418 · Nov 30 ✓");
    await expect(eng).not.toContainText("acme/app");
  });
});

test.describe("desktop: one approval state", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-plan-3: a roadmap in review is not approved on the Plan, as on Documents", async ({ page }) => {
    await openPlan(page);
    await expect(page.getByTestId("plan-unapproved-version")).toHaveText("Usage alerts roadmap v1: not approved yet");
    await expect(page.getByTestId("plan-live-version")).toHaveCount(0);
    await expect(page.getByTestId("plan-edit")).toHaveCount(0);
    await expect(row(page, "Threshold alerts on spend").getByTestId("plan-state")).toHaveText("Proposed · new");
    await expect(row(page, "Daily alert digest email").getByTestId("plan-state")).toHaveText("Proposed · new");
    await row(page, "Threshold alerts on spend").getByTestId("plan-title").click();
    await expect(inspector(page).getByTestId("plan-history").getByTestId("plan-history-version")).toHaveText(["Added to Now in draft 1 from PRD v1"]);

    // Approved only lists none of its items.
    await page.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved only" }).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("plan-table")).toContainText("No roadmap items yet");
    await page.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved + drafts" }).click();
    await expect(rows(page).first()).toBeVisible();

    // The Documents tab says the same.
    await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
    const doc = page.getByTestId("roadmap-row").filter({ hasText: "Usage alerts roadmap" });
    await expect(doc).toContainText("In review");
    await expect(doc.getByTestId("roadmap-approved-version")).toHaveCount(0);
  });

  test("qa4-plan-3: once the roadmap is approved, the Plan shows it approved and offers Edit plan", async ({ page }) => {
    await inScenario(page, "plan-decider");
    await openPlan(page);
    await expect(page.getByTestId("plan-live-version")).toHaveText("Usage alerts roadmap v1");
    await expect(page.getByTestId("plan-unapproved-version")).toHaveCount(0);
    await expect(row(page, "Threshold alerts on spend").getByTestId("plan-state")).toHaveText("On track");
    await page.getByTestId("plan-edit").click();
    await expect(page.getByTestId("plan-changes").filter({ visible: true })).toContainText("Changes to approved version 1 of Usage alerts roadmap");
  });

  test("qa4-plan-4: a PRD with no roadmap document shows no roadmap draft on the Plan", async ({ page }) => {
    await openPlan(page);
    const card = page.getByTestId("plan-prd-card").filter({ hasText: "Checkout redesign PRD" });
    await expect(card.getByTestId("plan-prd-stage")).toHaveText("Draft 2 in review");
    await expect(card).not.toContainText("roadmap draft");
    await expect(row(page, "One-page checkout")).toHaveCount(0);
    await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "PRD" }).click();
    await expect(page.getByTestId("plan-group").filter({ visible: true })).toHaveText(["Usage alerts PRD · 7"]);
    // Documents lists no Checkout redesign roadmap either.
    await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
    await expect(page.getByTestId("roadmap-row").filter({ hasText: "Checkout redesign" })).toHaveCount(0);
  });

  test("qa4-plan-22: approved version 1 and draft 2 are named one way on the table, Edit plan and History", async ({ page }) => {
    await inScenario(page, "roadmap-diff");
    await openPlan(page);
    await expect(row(page, "Budgets per team").getByTestId("plan-state")).toHaveText("Dropped in draft 2 (was Planned)");
    await row(page, "Budgets per team").getByTestId("plan-title").click();
    await expect(inspector(page).getByTestId("plan-history").getByTestId("plan-history-version")).toHaveText(["Added to Later in version 1 from PRD v1, approved Oct 5"]);
    await page.getByTestId("plan-edit").click();
    const changes = page.getByTestId("plan-changes").filter({ visible: true });
    await expect(changes).toContainText("Changes to approved version 1 of Usage alerts roadmap");
    await expect(changes).not.toContainText("In review, not approved");
    await expect(changes.locator('[data-testid="edit-lane"][data-horizon="later"]')).toContainText("Budgets per team");
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

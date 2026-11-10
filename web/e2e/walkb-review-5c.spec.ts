import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// walkb-roadmap review 5c: a roadmap built from one PRD puts each of its items in the lane of
// the goal its PRD gives it. Guided setup's plan (invented data, the "simple-plan-lanes"
// scenario) names Setup checklist (F-01) and Sample data import (F-02) under its Activation
// goal; they were drawn in the lane of Faster activation, a goal of another roadmap's items.

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
/**
 * The Gantt's goal lanes (tb-mk: the Timeline's bands are tracks): each lane's title and the
 * items drawn under it, in the order the page draws them.
 */
async function ganttLanes(page: Page): Promise<{ title: string; items: string[] }[]> {
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
  // tb-mk: the Gantt starts grouped by track; its Group by Goal draws the goal lanes.
  await page.getByTestId("group-goal").click();
  await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chart-group").first()).toBeVisible();
  const heads: { title: string; y: number }[] = [];
  for (const g of await page.locator('[data-testid="chart-group"], [data-testid="below-the-line"]').all())
    heads.push({ title: (await g.locator("span[title]").first().getAttribute("title")) ?? "", y: (await g.boundingBox())!.y });
  heads.sort((a, b) => a.y - b.y);
  const out = heads.map((h) => ({ title: h.title, items: [] as string[] }));
  for (const b of await page.locator('g[data-testid="bar"]').all()) {
    const box = (await b.boundingBox())!;
    const mid = box.y + box.height / 2;
    const at = heads.findLastIndex((h) => h.y <= mid);
    if (at >= 0) out[at].items.push((await b.getAttribute("data-item"))!);
  }
  return out;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    // Card entry: protects = a PRD's items sit in the lanes of that PRD's goals; fails_when =
    // Setup checklist or Sample data import sits in the Faster activation lane, apart from the
    // PRD's other Activation work; no_claim = the lanes' order.
    test("a PRD's items sit in their own goal's lane", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan-lanes"] as const);
      await login(page);
      await page.goto(URL);
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
      // tb-mk: the Timeline's bands are tracks: the goal lanes are the Gantt's Group by Goal.
      const lanes = await ganttLanes(page);
      const activation = lanes.find((l) => /^Activation( · \d+ items?)?$/.test(l.title));
      expect(activation, `an Activation lane among ${lanes.map((l) => l.title).join(", ")}`).toBeTruthy();
      expect(activation!.items).toHaveLength(5);
      // The desktop's Waterfall (still by goal) heads the lane with its count, the five drawn.
      if (viewport.width > 600) {
        await page.getByTestId("format-waterfall").click();
        await expect(page.getByTestId("chart-group").filter({ has: page.locator('[title="Activation"]') }).getByTestId("lane-count")).toHaveText("5 items");
      }
      expect(lanes.filter((l) => l.title.startsWith("Faster activation"))).toEqual([]);
      for (const item of ["setup-checklist", "setup-import"]) expect(activation!.items).toContain(item);
    });

    // The phone's Timeline is a list by quarter with no lane headers: each row names its goal
    // under its title ("Oct 5 – Nov 2 · Activation"), so the same promise reads off the rows.
    if (viewport.width < 600)
      test("a phone's Timeline names each PRD item's own goal", async ({ page }) => {
        await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan-lanes"] as const);
        await login(page);
        await page.goto(URL);
        await expect(page.getByTestId("timeline-list")).toBeVisible();
        const rows = page.getByTestId("timeline-list").getByTestId("timeline-row");
        await expect(rows.first()).toBeVisible();
        // tb-mk: a phone's rows read dates only (the owner's pick): both items are listed, and the
        // same phone's Gantt, by goal, draws them in the PRD's Activation lane, five in all.
        for (const item of ["setup-checklist", "setup-import"]) await expect(rows.and(page.locator(`[data-item="${item}"]`)).first()).toBeVisible();
        const lanes = await ganttLanes(page);
        const activation = lanes.find((l) => l.title === "Activation");
        for (const item of ["setup-checklist", "setup-import"]) expect(activation?.items, `${item} sits in its PRD's goal`).toContain(item);
        expect(new Set(activation!.items).size).toBe(5);
        expect(lanes.filter((l) => l.title === "Faster activation")).toEqual([]);
      });
  });
}

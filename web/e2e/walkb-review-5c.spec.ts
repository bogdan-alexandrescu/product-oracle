import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// walkb-roadmap review 5c: a roadmap built from one PRD puts each of its items in the lane of
// the goal its PRD gives it. Guided setup's plan (invented data, the "simple-plan-lanes"
// scenario) names Setup checklist (F-01) and Sample data import (F-02) under its Activation
// goal; they were drawn in the lane of Faster activation, a goal of another roadmap's items.

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
/**
 * build-roadmap (47361c89): the picked Timeline draws a header per goal lane ("Activation · 5
 * items") with its items' rows under it, and a phone's Timeline is a list by quarter, so a
 * phone reads the goal lanes on the Gantt. Each lane's title and the items drawn under it, in
 * the order the page draws them.
 */
async function timelineLanes(page: Page): Promise<{ title: string; items: string[] }[]> {
  await expect(page.getByTestId("timeline-lane").first()).toBeVisible();
  return page.getByTestId("simple-chart").evaluate((root) => {
    const out: { title: string; items: string[] }[] = [];
    for (const r of root.querySelectorAll<HTMLElement>('[data-testid="timeline-lane"], [data-testid="timeline-row"]')) {
      if (r.dataset.testid === "timeline-lane") out.push({ title: (r.textContent ?? "").replace(/\s+/g, " ").trim(), items: [] });
      else out[out.length - 1]?.items.push(r.dataset.item!);
    }
    return out;
  });
}

async function ganttLanes(page: Page): Promise<{ title: string; items: string[] }[]> {
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
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
      const lanes = viewport.width > 600 ? await timelineLanes(page) : await ganttLanes(page);
      const activation = lanes.find((l) => /^Activation( · \d+ items?)?$/.test(l.title));
      expect(activation, `an Activation lane among ${lanes.map((l) => l.title).join(", ")}`).toBeTruthy();
      // The desktop's header counts its items; both count five drawn under it.
      if (viewport.width > 600) expect(activation!.title).toBe("Activation · 5 items");
      expect(activation!.items).toHaveLength(5);
      expect(lanes.filter((l) => l.title.startsWith("Faster activation"))).toEqual([]);
      for (const item of ["setup-checklist", "setup-import"]) expect(activation!.items).toContain(item);
    });
  });
}

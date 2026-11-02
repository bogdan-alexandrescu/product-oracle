import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// walkb-roadmap review 5b: Simple > Roadmap draws an item the same way in every view (solid:
// dated, hatched: estimated dates), so the Waterfall does not hatch a dated item's phases; and
// the Gantt's warning callout never sits on top of its own bar.

const bars = (page: Page) => page.locator('g[data-testid="bar"]');

async function kinds(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await bars(page).all()) out[(await b.getAttribute("data-item"))!] = (await b.getAttribute("data-kind"))!;
  return out;
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("the Waterfall hatches only the items the Gantt hatches", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await page.getByTestId("format-gantt").click();
      await expect(bars(page).first()).toBeVisible();
      const gantt = await kinds(page);
      expect(Object.values(gantt)).toContain("dated");

      await page.getByTestId("format-waterfall").click();
      await expect(page.locator('rect[data-testid="phase"]').first()).toBeVisible();
      let dated = 0;
      for (const b of await bars(page).all()) {
        const key = (await b.getAttribute("data-item"))!;
        const kind = gantt[key];
        if (!kind || kind === "cut") continue;
        for (const p of await b.locator('rect[data-testid="phase"]').all()) {
          const fill = (await p.getAttribute("fill")) ?? "";
          if (kind === "estimated") expect(fill, `${key}: an estimated item's phase is hatched`).toMatch(/^url\(/);
          else {
            dated += 1;
            expect(fill, `${key}: a ${kind} item's phase is solid, as in the Gantt`).not.toMatch(/^url\(/);
          }
        }
      }
      expect(dated).toBeGreaterThan(0);
    });

    test("the Gantt's warning never covers its bar", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
      await page.getByTestId("format-gantt").click();
      const callouts = page.getByTestId("broken-callout");
      await expect(callouts.first()).toBeVisible();
      const clear = async () => {
        for (const c of await callouts.all()) {
          const key = (await c.getAttribute("data-item"))!;
          const body = page.locator(`g[data-testid="bar"][data-item="${key}"]`).locator("rect[data-body], rect[data-slice-body]").first();
          const box = (await body.boundingBox())!;
          const warn = (await c.boundingBox())!;
          expect(overlaps(box, warn), `${key}: its warning sits beside its bar, not on it`).toBe(false);
        }
      };
      await clear();
      if (viewport.width < 600) return;
      // A bar too long for its warning on either side (by weeks, Weekly alert digest made ten
      // weeks longer from the keyboard): the warning still sits beside it, not on it.
      await page.getByTestId("unit-week").first().click();
      const digest = page.locator('g[data-testid="bar"][data-item="alert-digest"]');
      const end = await digest.getAttribute("data-end");
      await digest.focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
      await expect(digest).not.toHaveAttribute("data-end", end!);
      await expect(page.locator('[data-testid="broken-callout"][data-item="alert-digest"]')).toBeVisible();
      await page.waitForTimeout(1500);
      await clear();
    });
  });
}

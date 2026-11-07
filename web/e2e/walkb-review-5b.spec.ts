import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// walkb-roadmap review 5b: Simple > Roadmap draws an item the same way in every view (solid:
// dated, hatched: estimated dates), so the Waterfall does not hatch a dated item's phases; and
// the Gantt's warnings (in the conflicts panel above it) never sit on top of a bar.

const bars = (page: Page) => page.locator('g[data-testid="bar"]');

async function kinds(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await bars(page).all()) out[(await b.getAttribute("data-item"))!] = (await b.getAttribute("data-kind"))!;
  return out;
}

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

    // build-roadmap (47361c89, mk-qa4-roadmap QR3 A): the Gantt's broken links moved from a
    // callout beside each bar to the conflicts panel above the chart. Its promise holds there:
    // each warning is listed, in full, and its bar is drawn and flagged as broken. That the
    // panel covers no bar follows from the layout (it sits above the chart), so the test reads
    // it as that: the panel ends above the chart's first bar.
    test("the Gantt's warning never covers its bar", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
      const panel = page.getByTestId("conflicts");
      const warnings = panel.getByTestId("conflict");
      await expect(warnings.first()).toBeVisible();
      const clear = async () => {
        const warn = (await panel.boundingBox())!;
        for (const c of await warnings.all()) {
          const key = (await c.getAttribute("data-item"))!;
          // Pre-demo QA S-5 (7821685f4): an end past its milestone is listed too, by its
          // feature's name with its sentence behind an (i); a link reads its sentence whole.
          if (await c.getByTestId("conflict-why").count()) {
            await c.getByTestId("conflict-why").hover();
            await expect(c.getByRole("tooltip")).toBeVisible();
            await expect(c.getByRole("tooltip")).toContainText("after its milestone");
            await page.mouse.move(0, 0);
            await expect(c.getByRole("tooltip")).toBeHidden();
          } else await expect(c).toContainText(/starts/);
          const bar = bars(page).and(page.locator(`[data-item="${key}"]`));
          await expect(bar).toBeVisible();
          await expect(bar, `${key}: a listed warning's bar is flagged as broken`).not.toHaveAttribute("data-broken", "false");
        }
        const tops: number[] = [];
        for (const b of await bars(page).all()) tops.push((await b.boundingBox())!.y);
        expect(warn.y + warn.height, "the warnings sit above the chart, not on a bar").toBeLessThanOrEqual(Math.min(...tops) + 1);
      };
      await clear();
      if (viewport.width < 600) return;
      // A bar too long for a warning on either side (by weeks, Weekly alert digest made ten
      // weeks longer from the keyboard): its warning is still listed, still off every bar.
      await page.getByTestId("unit-week").first().click();
      const digest = page.locator('g[data-testid="bar"][data-item="alert-digest"]');
      const end = await digest.getAttribute("data-end");
      await digest.focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
      await expect(digest).not.toHaveAttribute("data-end", end!);
      await expect(page.locator('[data-testid="conflict"][data-item="alert-digest"]').filter({ hasText: "starts" })).toBeVisible();
      await expect(page.getByTestId("draft-count")).toBeVisible();
      await clear();
    });
  });
}

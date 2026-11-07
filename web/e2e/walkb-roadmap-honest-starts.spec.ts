import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// walkb-roadmap 3: Mobile alert push has only an end date and depends on Alert rules engine.
// Its start is never made up as its window's first day: it starts after Alert rules engine
// ends, and raises no broken link "starts Oct 1, but ...". hotfix-effort-start: it starts its
// effort (3 weeks, its end included) to its Dec 20 end, Nov 30, well after the rules engine ends (Nov 10).

// build-roadmap (47361c89): the picked Timeline draws a bar per item in its own row, with its
// dates on it, and lists broken links in the conflicts panel above the chart, not by the bar.
const bar = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"] [data-testid="timeline-bar"]`);
const ganttBar = (page: Page, key: string) => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The second bar starts the day after the first ends (its dates; else on `on`), and is drawn after it. */
async function startsAfter(page: Page, first: string, then: string, on?: string) {
  await expect(bar(page, then)).toBeVisible();
  const end = (await bar(page, first).getAttribute("data-end"))!;
  await expect(bar(page, then)).toHaveAttribute("data-start", on ?? dayAfter(end));
  expect((on ?? dayAfter(end)) > end).toBe(true);
  const a = (await bar(page, first).boundingBox())!;
  const b = (await bar(page, then).boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    // Card entry: protects = an end-only item starts after its dependency and has no broken
    // link; fails_when = its start is its window's first day and the callout says it starts
    // before its dependency ends; no_claim = Weekly alert digest's own (typed) broken link.
    test("an end-only item starts after its dependency, with no false broken link", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-chart")).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/‘Mobile alert push’ starts/);
      await expect(page.getByTestId("conflicts")).toBeVisible();
      await expect(page.locator('[data-testid="conflict"][data-item="alert-mobile"]')).toHaveCount(0);
      if (viewport.width > 600) await startsAfter(page, "alert-rules", "alert-mobile", "2026-11-30");
    });

    // Card entry (walkb-roadmap review): protects = a fully estimated item (Alert routing by
    // team, no dates typed) starts after what it depends on (Alert history export, a real
    // end) and has no broken link; fails_when = its bar stays at its window's start, before
    // its dependency's end; no_claim = the bar's length.
    test("a fully estimated item starts after its dependency", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-chart")).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/‘Alert routing by team’ starts/);
      await expect(page.getByTestId("conflicts")).toBeVisible();
      await expect(page.locator('[data-testid="conflict"][data-item="alert-sso"]')).toHaveCount(0);
      if (viewport.width > 600) {
        await startsAfter(page, "alert-export", "alert-sso");
        // Still drawn as estimated (the Gantt names each bar's kind).
        await page.getByTestId("format-gantt").click();
        await expect(ganttBar(page, "alert-sso")).toHaveAttribute("data-kind", "estimated");
      }
    });
  });
}

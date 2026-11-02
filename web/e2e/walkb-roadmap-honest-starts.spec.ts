import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// walkb-roadmap 3: Mobile alert push has only an end date and depends on Alert rules engine.
// Its start is never made up as its window's first day: it starts after Alert rules engine
// ends, and raises no broken link "starts Oct 1, but ...".

const bar = (page: Page, key: string) => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const body = (page: Page, key: string) => bar(page, key).locator("rect[data-body], rect[data-slice-body]").first();

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
      await expect(page.locator('[data-testid="broken-callout"][data-item="alert-mobile"]')).toHaveCount(0);
      if (viewport.width > 600) {
        await expect(bar(page, "alert-mobile")).toBeVisible();
        const rules = (await body(page, "alert-rules").boundingBox())!;
        const mobile = (await body(page, "alert-mobile").boundingBox())!;
        expect(mobile.x).toBeGreaterThanOrEqual(rules.x + rules.width - 1);
      }
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
      await expect(page.locator('[data-testid="broken-callout"][data-item="alert-sso"]')).toHaveCount(0);
      if (viewport.width > 600) {
        await expect(bar(page, "alert-sso")).toHaveAttribute("data-kind", "estimated");
        const exp = (await body(page, "alert-export").boundingBox())!;
        const sso = (await body(page, "alert-sso").boundingBox())!;
        expect(sso.x).toBeGreaterThanOrEqual(exp.x + exp.width - 1);
      }
    });
  });
}

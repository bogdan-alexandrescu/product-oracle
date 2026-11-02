import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

// walkb-roadmap review 5f: a roadmap built from a PRD can have a long name. Simple > Roadmap's
// header chip shows it whole, wrapping on a phone (390px) instead of running off the screen.

const NAME = "Guided setup for new workspace admins and their first teams roadmap";

async function pickRoadmap(page: Page, phone: boolean) {
  if (phone) {
    const toggle = page.getByTestId("filters-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(page.getByTestId("filter-pickers")).toBeVisible();
  }
  await page.getByTestId("filter-roadmap").selectOption({ label: NAME });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    // Card entry: protects = the roadmap name chip shows the whole long name inside the page;
    // fails_when = the chip keeps to one line and runs past the screen's edge (cut off);
    // no_claim = the chip's colours and the header's other controls.
    test("the roadmap name chip shows a long name whole, inside the page", async ({ page }) => {
      await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-walk-long-name"] as const);
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await pickRoadmap(page, viewport.width <= 600);
      const chip = page.getByTestId("roadmap-scope");
      await expect(chip).toHaveText(NAME);
      const box = (await chip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      // Its text is not clipped inside it either: the chip is as wide as what it holds.
      const fits = await chip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(fits).toBe(true);
      // Nothing on the page scrolls sideways.
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways).toBeLessThanOrEqual(0);
    });
  });
}

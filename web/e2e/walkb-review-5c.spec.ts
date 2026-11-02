import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

// walkb-roadmap review 5c: a roadmap built from one PRD puts each of its items in the lane of
// the goal its PRD gives it. Guided setup's plan (invented data, the "simple-plan-lanes"
// scenario) names Setup checklist (F-01) and Sample data import (F-02) under its Activation
// goal; they were drawn in the lane of Faster activation, a goal of another roadmap's items.

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const lane = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ has: page.locator("b", { hasText: new RegExp(`^${title}$`) }) });
const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const phoneLane = (page: Page, title: string): Locator => page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: new RegExp(`^${title}$`) }) });

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
      if (viewport.width > 600) {
        const activation = lane(page, "Activation");
        await expect(activation.getByTestId("lane-count")).toHaveText("5 items");
        await expect(lane(page, "Faster activation")).toHaveCount(0);
        const key = await activation.getAttribute("data-lane");
        for (const item of ["setup-checklist", "setup-import"]) await expect(bar(page, item)).toHaveAttribute("data-lane", key!);
      } else {
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "lanes-phone");
        await expect(phoneLane(page, "Activation").getByTestId("lane-count")).toHaveText("5 items");
        await expect(phoneLane(page, "Faster activation")).toHaveCount(0);
      }
    });
  });
}

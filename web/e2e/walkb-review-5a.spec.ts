import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// walkb-roadmap review 5a: a roadmap built from a PRD has no approved version until its first
// review passes. Its working-draft banner (and the toast when it is sent for review) never
// says "the approved roadmap stays published": there is none. In the mock's
// "simple-unapproved-roadmap" scenario the Alerts roadmap has no approved version yet.

// build-roadmap (47361c89): the picked Timeline draws a bar per item in its own row; the arrow
// keys move a focused bar as the Gantt's did.
const bar = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"] [data-testid="timeline-bar"]`);

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("a roadmap with no approved version: its draft banner claims none", async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-unapproved-roadmap"]);
      // The change is made on a desktop width (a phone's Timeline is a list by quarter, not bars), then read at the test's width.
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-chart")).toBeVisible();
      await bar(page, "alert-export").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await page.setViewportSize(viewport);

      const words = page.getByTestId("draft-words");
      await expect(words).toContainText("Your working draft");
      // roadmap-decide: what happens next, with no approved roadmap to replace; the decider approves and publishes in place.
      await expect(words).toContainText("version 2 is published");
      await expect(words).not.toContainText("approved roadmap");

      await page.getByTestId("draft-banner").getByRole("button", { name: "Approve and publish" }).click();
      const toast = page.getByRole("status").filter({ hasText: "Approved" });
      await expect(toast).toBeVisible();
      await expect(toast).not.toContainText("approved roadmap");
    });

    test("a roadmap with an approved version: its draft banner still says it stays published", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-chart")).toBeVisible();
      await bar(page, "alert-export").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("draft-count")).toHaveText("1");
      await page.setViewportSize(viewport);
      await expect(page.getByTestId("draft-words")).toContainText("version 2 replaces the approved roadmap");
    });
  });
}

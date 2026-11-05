import { expect, test, type Page } from "./test";

import { VERSION_WARNINGS_SCENARIO } from "../lib/api/mock/roadmap";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA pass B, PRDs and documents, on the mock layer, driven as a person would. Each test
 * states its card: protects / fails_when.
 */

const scenario = (page: Page, s: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, s]);

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test("B-04: Present on a version with no brief shows the full document as slides", async ({ page }) => {
      // protects=B-04; fails_when=Present mode opens a dead end with the API's message.
      await login(page);
      if (viewport.width > 600) {
        await page.goto("/documents/checkout-redesign/v/2");
        await page.getByRole("link", { name: "Present" }).filter({ visible: true }).first().click();
      } else {
        await page.goto("/documents/checkout-redesign/v/2/present");
      }
      const deck = page.getByTestId("present-mode");
      await expect(page.getByTestId("slide-counter")).toBeVisible();
      await expect(deck).not.toContainText("no brief sections");
      await expect(deck).not.toContainText("checkout-redesign");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("slide-counter")).toHaveText(/^2 \/ \d+$/);
    });

    test("B-05: the roadmap's title line reads its as-of day month first", async ({ page }) => {
      // protects=B-05; fails_when=the line under the title reads "As of 2026-10-02".
      await login(page);
      await page.goto("/documents/usage-alerts-roadmap/v/1");
      const main = page.locator("main");
      await expect(main.getByText("As of Oct 2, 2026").filter({ visible: true }).first()).toBeVisible();
      await expect(main).not.toContainText("As of 2026-10-02");
    });

    test("B-09: a version's warnings are in the chip's tip, the body names their sections in one line", async ({ page }) => {
      // protects=B-09; fails_when=the body shows the warnings again as cards.
      await scenario(page, VERSION_WARNINGS_SCENARIO);
      await login(page);
      await page.goto("/documents/usage-alerts-roadmap/v/1");
      const chip = page.getByTestId("version-warnings-chip").filter({ visible: true });
      await expect(chip).toHaveText("2 warnings");
      await expect(page.locator('[data-warning]:not([data-state="done"])').filter({ visible: true })).toHaveCount(0);
      const line = page.getByTestId("warned-sections").filter({ visible: true });
      await expect(line).toHaveText("Still open in Summary, Behaviour");
      expect((await line.boundingBox())!.height).toBeLessThan(viewport.width < 600 ? 60 : 32);
      await line.getByRole("link", { name: "Behaviour" }).click();
      await expect(page).toHaveURL(/#behaviour|section=behaviour/);
      await chip.click();
      await expect(page.getByRole("tooltip").filter({ visible: true })).toContainText("feedback items stay open");
    });

    test("B-18: the run review bar is the run's own review, the rest behind its (i)", async ({ page }) => {
      // protects=B-18; fails_when=the bar reads "Run review · <flow> · draft v2 · …" with no (i).
      await scenario(page, "run-review");
      await login(page);
      await page.goto("/documents/usage-alerts/v/2");
      const bar = page.getByTestId("run-review-bar").filter({ visible: true });
      await expect(bar.getByTestId("run-review-text")).toHaveText("This run's review · 0 of 3 sections reviewed");
      await bar.getByRole("button", { name: "About this run's review" }).click();
      const tip = page.getByRole("tooltip").filter({ visible: true });
      await expect(tip).toContainText("The review of draft v2 by the Baseline to PRD run");
    });
  });
}

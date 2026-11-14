import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * Visual QA, Nov 12 (detailed-a #9), on the mock "ground-truth-flags" company (invented data).
 *
 * protects = the Ground Truth page's band and its Flagged tab name their counts apart: the band
 * reads "Ground Truth checks N" (each check the Ground Truth breaks) and the tab "Flagged items N"
 * (the features the trace flags), so two numbers never read as one count; fails_when = the band
 * reads "Ground Truth flags" or the tab "Flagged".
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page);
  await page.getByTestId("nav-baseline").click();
  await expect(page.getByRole("heading", { level: 1, name: "Ground Truth" })).toBeVisible();
}

test("#9: the band counts Ground Truth checks and the tab counts Flagged items", async ({ page }) => {
  await open(page);
  const band = page.getByRole("region", { name: "Ground Truth checks" });
  await expect(band).toBeVisible();
  await expect(band.getByRole("heading", { level: 2 })).toHaveText("Ground Truth checks");
  const checks = Number(await band.getByTestId("gt-total").textContent());
  expect(checks).toBeGreaterThan(0);
  await expect(page.getByText("Ground Truth flags", { exact: true })).toHaveCount(0);

  const tab = page.getByRole("tab", { name: /^Flagged items \d+$/ });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^Flagged \d+$/ })).toHaveCount(0);
});

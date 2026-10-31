import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner's production walk of Simple mode (P4, P11), driven through the UI on a desktop
 * (1366x820) and a phone (390x844), light and dark, against the mock (invented data).
 *
 * Card walk-prd-owner-span (P4): protects = an approved PRD's page header names the document's
 * owner (Guided setup was brought in by Priya Raman: "Owner Priya Raman", never the company's
 * first owner) and its span from its dated milestones (Oct 5, 2026 – Jan 15, 2027, the last
 * milestone), never a period out to an estimated or unmilestoned end; fails_when = the header
 * names the company owner, reads "No owner yet", or runs to Mar 12, 2027; no_claim = how the
 * API resolves the owner and span (api tests/test_simple_walk_fixes3_ph_api.py).
 *
 * Card walk-track-headline (P11): protects = a plan approved a week ago whose items an earlier
 * rule marked stale only because the PRD got a new version reads the one item stale by its
 * own rule, in plain words ("At risk: 1 of N items needs attention (may be out of date)"),
 * never "N of N items need attention" nor the word "stale"; fails_when = every item counts as
 * needing attention; no_claim = the per-item marking on a new PRD version (the API's tests).
 */

async function setUp(page: Page, scenario: string, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test(`an approved PRD names its owner and its milestones' span (${where})`, async ({ page }) => {
        await setUp(page, "simple-walk", scheme);
        await login(page, "viewer@example.com");
        await page.goto("/simple/prds/guided-setup");
        const meta = page.getByTestId("one-pager-meta");
        await expect(meta).toContainText("Owner Priya Raman");
        await expect(meta).not.toContainText("Owner Avery Stone");
        await expect(meta).not.toContainText("No owner yet");
        await expect(meta).toContainText("Oct 5, 2026 → Jan 15, 2027");
        await expect(meta).not.toContainText("Mar 12, 2027");
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width).toBeLessThanOrEqual(phone ? 390 : 1366);
      });

      test(`a plan approved a week ago counts only items stale by their own rule (${where})`, async ({ page }) => {
        await setUp(page, "plan-stale", scheme);
        await login(page);
        // The rail on a desktop, the tab bar on a phone: both are the "Oracle" navigation.
        await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
        await expect(page).toHaveURL(/\/plan$/);
        const track = page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
        await expect(track).toBeVisible();
        await expect(track.getByTestId("track-health")).toHaveText("At risk");
        const headline = track.getByText(/^At risk: /);
        await expect(headline).toHaveText(/^At risk: (1 of \d+ items needs|the item needs) attention \(may be out of date\)\./);
        await expect(headline).not.toContainText("stale");
        const text = (await headline.textContent()) ?? "";
        const all = /(\d+) of (\d+) items/.exec(text);
        if (all) expect(all[1]).not.toBe(all[2]);
      });
    });
  }
}

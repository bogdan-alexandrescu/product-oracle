import { login, signOut } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Code map refresh as a company setting (owner, 2026-10-26), on the mock layer: Settings ›
 * Sources (Detailed) carries "Refresh stale code maps" for owners, Daily until one chooses,
 * with a line saying what a refresh costs; on desktop and phone, light and dark.
 *
 * Card code-map-refresh-setting: protects = an owner reads Daily (the default), changes it
 * to each of Hourly, Every 6 hours, Weekly and Only on demand through the select, sees it
 * saved, and the choice is still there after a reload; the cost line is shown; fails_when =
 * the control is missing, does not default to Daily, or the choice is not stored;
 * no_claim = the ticker's spacing (api/tests/test_code_maps.py).
 *
 * Card code-map-refresh-owners-only: protects = an approver's Settings › Sources has no
 * "Refresh stale code maps" (can("put_setting") is the owner's); fails_when = a non-owner is
 * offered the setting; no_claim = the API's 403 (api/tests/test_code_maps.py).
 */

/** Switches people: the account menu lives in the desktop rail, so sign out there and come
 * back to the test's width (as e2e/simple-one-pager.spec.ts does). */
async function switchTo(page: Page, email?: string) {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1366, height: 820 });
  await signOut(page);
  await login(page, email);
  await page.setViewportSize(size);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("an owner chooses how often stale code maps refresh", async ({ page }) => {
        await login(page);
        await page.goto("/settings/sources");
        const select = page.getByLabel("Refresh stale code maps");
        await expect(select).toBeVisible();
        await expect(select).toHaveValue("daily");
        await expect(page.getByTestId("code-map-refresh-cost")).toContainText("Each refresh is one code map run per stale repository");
        for (const label of ["Hourly", "Every 6 hours", "Weekly", "Only on demand"]) {
          await select.selectOption({ label });
          await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
          await expect(select).toHaveValue(
            { Hourly: "hourly", "Every 6 hours": "every_6_hours", Weekly: "weekly", "Only on demand": "on_demand" }[label]!,
          );
        }
        await page.reload();
        await expect(page.getByLabel("Refresh stale code maps")).toHaveValue("on_demand");
      });

      test("an approver is not offered the setting", async ({ page }) => {
        await login(page);
        await switchTo(page, "approver@example.com");
        await page.goto("/settings/sources");
        await expect(page.getByRole("heading", { name: "Sources" }).first()).toBeVisible();
        await expect(page.getByLabel("Refresh stale code maps")).toHaveCount(0);
      });
    });
  }
}

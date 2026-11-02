import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * build-plan review's minors, on the picked Priorities and Home:
 * - A goal card opens Priorities for that goal itself: two goals with the same name (G-R and G-T
 *   Grow retention) each show only their own features.
 * - A goal's list split at a dated line keeps the line's caption (the picked qp4=b mock-up),
 *   counting only that goal's features.
 * - A proposal row on Home names its change in words, never the change's code ("set_owner").
 * fails_when = a goal card filters by name, the goal's caption is gone, or a raw op code shows.
 */

const SIZES = [
  { name: "desktop", size: { width: 1440, height: 900 } },
  { name: "phone", size: { width: 390, height: 844 } },
];

async function setUp(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, "simple-home-same-name", THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
}

const goalCard = (page: Page, code: string) => page.locator(`[data-testid="home-goal-link"][title="${code} · Grow retention"]`);

for (const v of SIZES) {
  test.describe(`build-plan review (${v.name})`, () => {
    test(`two goals with one name each open their own features (${v.name})`, async ({ page }) => {
      await setUp(page, v.size);
      await expect(page.getByTestId("home-goal-link").filter({ hasText: /^Grow retention$/ })).toHaveCount(2);
      await goalCard(page, "G-T").click();
      const filter = page.getByTestId("prio-goal-filter");
      await expect(filter).toContainText("Showing Grow retention only: nothing for this goal is planned yet");
      await expect(page.getByTestId("prio-row")).toHaveCount(0);

      await page.goto("/simple");
      await goalCard(page, "G-R").click();
      await expect(filter).toContainText(/^Showing Grow retention only: \d+ of \d+ features/);
      const goals = await page.getByTestId("prio-row").getByTestId("prio-goal").allTextContents();
      expect(goals.length).toBeGreaterThan(0);
      expect(new Set(goals)).toEqual(new Set(["Grow retention"]));
    });

    test(`a goal's list split at a dated line keeps the line's caption (${v.name})`, async ({ page }) => {
      await setUp(page, v.size);
      await goalCard(page, "G-R").click();
      await expect(page.getByTestId("prio-goal-filter")).toBeVisible();
      await expect(page.getByText("Loading priorities…")).toHaveCount(0);
      const options = await page.locator("#prio-line option").allTextContents();
      const label = options.find((o) => o.startsWith("Milestone: Beta"));
      expect(label, options.join(" | ")).toBeTruthy();
      await page.getByTestId("line-picker").getByLabel("Line", { exact: true }).selectOption({ label: label! });
      await expect(page.getByTestId("prio-part-head")).toHaveCount(2);
      const shown = await page.getByTestId("prio-row").count();
      const missing = await page.locator('[data-testid="prio-row"][data-misses="true"]').count();
      await expect(page.getByTestId("line-caption")).toContainText(new RegExp(`^${missing} of ${shown} miss `));
    });

    test(`a proposal row names its change in words (${v.name})`, async ({ page }) => {
      await setUp(page, v.size);
      const row = page.getByTestId("home-proposal").filter({ hasText: "I can run it" });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Change the owner: Alert rules engine");
      await expect(page.getByText(/set_owner/)).toHaveCount(0);
    });
  });
}

import { GOAL_BUCKETS_HARD_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA findings of Nov 12, 2026 on Priorities' Goal buckets (docs/qa/2026-11-12/simple-goalmap.md), driven through
 * the UI on the mock (invented data only), desktop 1440x900:
 * PR1 (bucket part): a bucket row shows its feature's Ground Truth code, never initials made from its name ("SC");
 *   a feature with no code is flagged "Not in the Ground Truth".
 * PR6: in goal-buckets-hard, F-22 Partner directory listing (no roadmap item) has the same pencil and ⋯ as the rows
 *   round it; its pencil opens its feature panel.
 * PR7: the plan card's summary is a short line; the sentence and the footnote are behind its (i).
 * PR8: the New goal form says "Name the goal." only once the person leaves the field, not as it opens.
 * PR10: a row with two milestone chips keeps its name readable (never one word per line).
 */

const DESKTOP = { width: 1440, height: 900 };
/** A Ground Truth feature code (F-12, a slice F-15a). */
const GT_CODE = /^[A-Z]{1,3}-\d+[a-j]?$/;

async function open(page: Page, scenario: string | null) {
  await page.setViewportSize(DESKTOP);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByText("Loading priorities…")).toHaveCount(0);
}

const bucket = (page: Page, goal: string) => page.locator(`[data-testid="plan-goal"][data-goal="${goal}"]`);

test.describe("QA Nov 12: Priorities, Goal buckets", () => {
  test("PR1: bucket rows show a Ground Truth code or the Not in the Ground Truth flag, never made-up initials", async ({ page }) => {
    await open(page, null);
    const rows = page.getByTestId("bucket-features").getByTestId("plan-feature");
    await expect(rows.filter({ hasText: "Setup checklist" })).toBeVisible();
    const read = await rows.evaluateAll((els) =>
      els.map((e) => ({
        name: e.querySelector('[data-testid="plan-feature-name"]')?.textContent ?? "",
        code: e.querySelector('[data-testid="prio-code"]')?.textContent?.trim() ?? null,
        flagged: !!e.querySelector('[data-testid="not-in-gt"]'),
      })),
    );
    expect(read.length).toBeGreaterThan(0);
    for (const r of read) {
      // Each row: its code, or (none) the flag; never both, never neither.
      expect(r.code === null ? r.flagged : GT_CODE.test(r.code) && !r.flagged, `${r.code ?? "no code"} ${r.name}`).toBe(true);
    }
    // Setup checklist never reads "SC".
    await expect(rows.filter({ hasText: "Setup checklist" }).getByTestId("prio-code").filter({ hasText: /^SC$/ })).toHaveCount(0);
    // The flag reads plainly.
    const flags = page.getByTestId("bucket-features").getByTestId("not-in-gt");
    if ((await flags.count()) > 0) await expect(flags.first()).toHaveText("Not in the Ground Truth");
  });

  test("PR6: F-22, with no roadmap item, has the same pencil and ⋯ as its neighbours; the pencil opens its panel", async ({ page }) => {
    await open(page, GOAL_BUCKETS_HARD_SCENARIO);
    const big = bucket(page, "Grow partner network");
    await expect(big.getByTestId("plan-feature")).toHaveCount(15);
    // Every row of the bucket has its actions.
    await expect(big.getByTestId("task-actions")).toHaveCount(15);
    const f22 = big.locator('[data-testid="plan-feature"][data-code="F-22"]');
    await expect(f22.getByRole("button", { name: "Edit Partner directory listing" })).toBeVisible();
    await f22.getByRole("button", { name: "More for Partner directory listing" }).click();
    await expect(f22.getByRole("menuitem", { name: "Edit feature" })).toBeVisible();
    await f22.getByRole("menuitem", { name: "Edit feature" }).click();
    await expect(page.getByTestId("item-panel")).toContainText("Partner directory listing");
  });

  test("PR7: the plan card's summary is one short line; its sentence and footnote are behind the (i)", async ({ page }) => {
    await open(page, "simple-plan");
    const head = page.getByTestId("buckets-head");
    await expect(head.getByTestId("buckets-summary")).toHaveText("Nov 2 – Feb 12 · 56 engineer-weeks, 5 spare");
    await expect(head.getByText("Bars are engineer-weeks", { exact: false })).toBeHidden();
    await expect(head.getByText("Each feature counts once", { exact: false })).toBeHidden();
    await head.getByRole("button", { name: "About these bars" }).click();
    const tip = page.locator('[role="tooltip"]').filter({ hasText: "Each feature counts once, under the goal it moves most" });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("56 engineer-weeks over three milestones (51 planned + 5 spare)");
  });

  test("PR8: the New goal form names no missing field as it opens, only once the person leaves it", async ({ page }) => {
    await open(page, "simple-plan");
    await page.getByTestId("add-goal").getByRole("button", { name: "+ Add goal" }).click();
    const form = page.getByTestId("add-goal").getByTestId("goal-form");
    await expect(form.getByRole("heading", { name: "New goal" })).toBeVisible();
    await expect(form.getByText("Name the goal.")).toHaveCount(0);
    await expect(form.getByText("Add a measure.")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Save goal" })).toBeDisabled();
    // Leaving the empty name says what it lacks.
    await form.getByLabel("Measure: the number that shows it").click();
    await expect(form.getByText("Name the goal.")).toBeVisible();
    await expect(form.getByText("Add a measure.")).toHaveCount(0);
  });

  test("PR10: a row with two milestone chips keeps its name readable", async ({ page }) => {
    await open(page, GOAL_BUCKETS_HARD_SCENARIO);
    const big = bucket(page, "Grow partner network");
    // F-11 Self-serve checkout and F-12 Referral link: each in M2 and M3.
    for (const code of ["F-11", "F-12"]) {
      const row = big.locator(`[data-testid="plan-feature"][data-code="${code}"]`);
      await expect(row.getByTestId("plan-chip")).toHaveCount(2);
      const name = row.getByTestId("plan-feature-name");
      const box = (await name.boundingBox())!;
      expect(box.width, (await name.textContent()) ?? "").toBeGreaterThanOrEqual(150);
      // At most two lines (22px each): never one word per line.
      const open = row.getByTestId("plan-feature-open");
      expect((await open.boundingBox())!.height, (await open.textContent()) ?? "").toBeLessThanOrEqual(46);
    }
  });
});

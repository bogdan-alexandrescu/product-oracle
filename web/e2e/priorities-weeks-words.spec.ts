import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Priorities' weeks, after PRs 1457 and 1459: a 1-week segment's title says "1 engineer-week"; a milestone's caption
 * puts each noun after its own number ("13 weeks of 1 week", never "13 of 1 week"); a bar's label shows whenever its
 * text, as drawn, fits its segment (no letter-count guess); the page never scrolls sideways at 1440, 768 or 390 px in
 * either theme, every feature row whole; and two plan goals with one name and no code are one goal with one shape on
 * the Value / effort chart (the owner's pick). On the mock's "simple-plan" scenarios (invented data).
 */

/** "simple-plan" with M1's capacity 1 engineer-week and Revenue's M2 work 1 week (simple-priorities.ts). */
const ONE_WEEK = "priorities-plan-one-week";
/** "simple-plan" whose plan names Activation twice, with no code (simple-priorities.ts). */
const GOAL_TWINS = "priorities-plan-goal-twins";

type Tab = "ranked" | "value-effort" | "buckets";

async function open(page: Page, tab: Tab, scenario: string, width = 1440, theme: "light" | "dark" = "light"): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey, t]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, theme] as const,
  );
  await login(page, ADMIN.email);
  await show(page, tab);
}

/** A tab of the page, laid out and measured (the bars' labels, the chart's marks). */
async function show(page: Page, tab: Tab): Promise<void> {
  await page.goto(`/simple/priorities?tab=${tab}`);
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  if (tab === "buckets") await expect(page.getByTestId("plan-feature").first()).toBeVisible();
  if (tab === "value-effort") await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  if (tab === "ranked") await expect(page.getByTestId("prio-row").first()).toBeVisible();
  await page.waitForTimeout(400);
}

const segment = (page: Page, goal: string, milestone: string) => page.locator(`[data-testid="goal-bar"][data-goal="${goal}"] [data-testid="goal-bar-segment"][data-milestone="${milestone}"]`);

test("a 1-week segment says '1 engineer-week', and a caption's noun follows its own number", async ({ page }) => {
  await open(page, "buckets", ONE_WEEK);
  const head = page.getByTestId("buckets-head");
  // Revenue's M2 work is 1 week: too narrow for its label, its words in its title.
  const revenue = segment(page, "Revenue", "M2");
  await expect(revenue).toHaveAttribute("title", "M2 Scale volume: 1 engineer-week");
  await expect(revenue.locator("[data-label]")).toHaveText("M2 Scale volume · 1 week");
  await expect(segment(page, "Revenue", "M3")).toHaveAttribute("title", "M3 Open to all: 9 engineer-weeks");
  // M1 plans 13 weeks of its 1-week capacity; M2 and M3 read as before.
  const chips = head.getByTestId("milestone-chip");
  await expect(chips.nth(0)).toHaveText(/ · 13 weeks of 1 week$/);
  await expect(chips.nth(1)).toHaveText(/ · 14 of 16 weeks$/);
  await expect(head).not.toContainText(/\b13 of 1 week/);
  await expect(head).not.toContainText(/\b1 engineer-weeks\b/);
});

test("a bar's label shows whenever its text fits its segment, and only then", async ({ page }) => {
  await open(page, "buckets", "simple-plan");
  // "M3 Open to all · 4 weeks" fits Reliability's 4-week segment with room to spare: shown, whole.
  const m3 = segment(page, "Reliability", "M3");
  await expect(m3.getByTestId("goal-bar-label")).toHaveText("M3 Open to all · 4 weeks");
  await expect(m3.getByTestId("goal-bar-label")).toBeVisible();
  const fits = await page.getByTestId("goal-bar-segment").evaluateAll((segs) =>
    segs.map((s) => {
      const label = s.querySelector<HTMLElement>("[data-label]")!;
      const box = s.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      return {
        label: label.textContent,
        shown: label.dataset.testid === "goal-bar-label" && getComputedStyle(label).opacity === "1",
        fits: text.width + 12 <= s.clientWidth,
        inside: text.left >= box.left && text.right <= box.right,
      };
    }),
  );
  expect(fits.filter((f) => f.shown).length).toBeGreaterThan(0);
  expect(fits.filter((f) => !f.shown).length).toBeGreaterThan(0);
  for (const f of fits) {
    expect(f.shown, `${f.label}: shown exactly when it fits`).toBe(f.fits);
    if (f.shown) expect(f.inside, `${f.label}: drawn whole inside its segment`).toBe(true);
  }
});

for (const width of [1440, 768, 390])
  for (const theme of ["light", "dark"] as const)
    test(`no sideways scroll at ${width} px (${theme}): every tab fits, every feature row whole`, async ({ page }) => {
      await open(page, "buckets", "simple-plan", width, theme);
      for (const tab of ["buckets", "ranked", "value-effort"] as const) {
        await show(page, tab);
        const wide = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: document.documentElement.clientWidth }));
        expect(wide.page, `${tab}: the page is no wider than the window`).toBeLessThanOrEqual(wide.window);
        if (tab !== "buckets") continue;
        // Each goal's feature rows fit their card: nothing clipped or scrolled out of sight.
        const cut = await page.getByTestId("plan-feature").evaluateAll((rows) => rows.filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => (r as HTMLElement).innerText));
        expect(cut, `${tab}: feature rows wider than their card`).toEqual([]);
        for (const card of await page.getByTestId("plan-goal").all()) {
          const [box, main] = [(await card.boundingBox())!, (await page.locator("main").boundingBox())!];
          expect(box.x + box.width, "a goal's card ends inside the page").toBeLessThanOrEqual(main.x + main.width + 1);
        }
      }
    });

test("two plan goals with one name and no code are one goal: one legend entry, one shape", async ({ page }) => {
  await open(page, "value-effort", GOAL_TWINS);
  const activation = page.getByRole("list", { name: "Legend" }).getByRole("listitem").filter({ hasText: /^Activation$/ });
  await expect(activation).toHaveCount(1);
  const shape = await activation.getAttribute("data-shape");
  expect(shape).toBeTruthy();
  // Onboarding emails (F-16), a lone mark, and Bulk import (F-07), in a count with Plan limits: both Activation, one shape.
  await expect(page.locator('[data-testid="vxe-point"][data-code="plan-f-16"]')).toHaveAttribute("data-shape", shape!);
  await page.locator('[data-testid="vxe-crowd"][aria-label*="Bulk import"]').click();
  await expect(page.getByTestId("vxe-crowd-sheet").locator('[data-testid="vxe-crowd-row"][data-code="plan-f-07"]')).toHaveAttribute("data-shape", shape!);
});

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The plan-charts lane (the owner's picks of 2026-10-28): Priorities' Goal buckets header is
 * "Where each goal's work lands" (engineer-weeks per goal per milestone, from the plan), and
 * Value / effort has a log effort axis split at the medians, linked to the Ranked list beside
 * it. Driven through the UI on a desktop (1366x820) and a phone (390x844), light and dark.
 *
 * Goal buckets run on the mock's "simple-plan" scenario (invented: Guided setup's plan, M1 Prove
 * it 2 Nov - 27 Nov 13 of 16 wk, M2 Scale volume 30 Nov - 25 Dec 15 of 16 wk, M3 Open to all
 * 28 Dec - 12 Feb 23 of 24 wk; Reliability 4 + 3 + 4, Growth 3 + 7 + 6, Activation 6 + 3 + 4,
 * Revenue 0 + 2 + 9). Value / effort runs on the default company (nine features: values 0-6,
 * efforts 1-4 weeks; alert-export and setup-video both at value 0, effort 1).
 *
 * Card plan-charts-buckets: protects = the header reads "Where each goal's work lands", the
 * plan's capacity, planned and spare weeks in one line, a legend chip per milestone with its
 * name, dates and how full it is, one stacked bar per goal with a segment per milestone
 * ("M1 4.0") and its total, the footnote, every total equal to the plan's, goal cards listing
 * each feature with its milestone chips and weeks, and the page's quarter label the plan's
 * span; no label is cut and every label on a milestone colour reads at 4.5:1; roadmap items
 * outside the plan still listed under their goal; fails_when = a number differs from the plan,
 * the old "Share of ..." caption shows, a bar or chip is missing, a label overflows or reads
 * under 4.5:1, a chip carries more than the code, dates and how full, or items outside the
 * plan vanish; no_claim = how the API reads
 * the plan (api tests/test_simple_plan_api.py), suggestions under each goal (their own spec).
 *
 * Card plan-charts-value-effort: protects = the effort axis is logarithmic (ticks 0.5, 1, 2,
 * 4 wk, a doubling the same distance), the quadrant lines sit at the medians with each
 * quadrant's name and count (Quick wins 2, Big bets 3, Fill-ins 3, Later 1), marks keep their
 * codes and two marks on the same spot fan out so neither hides the other; fails_when = a
 * linear axis, quadrants split at the middle of the plot instead of the medians, a count is
 * wrong or the twin marks overlap; no_claim = the API's scoring.
 *
 * Card plan-charts-linked: protects = selecting a mark (click, tap or the keyboard) highlights
 * its row in the Ranked list beside the chart and scrolls it into view, selecting a row
 * highlights its mark, Escape clears both (once the Ask panel it may have closed first is shut);
 * a real tap on a phone selects; the Ranked titles wrap, never cut; a sideways drag still re-estimates effort on the log
 * scale through the change engine; fails_when = the row or mark is not highlighted, the row
 * stays off screen, Escape leaves a highlight, Escape that closes the Ask panel also clears
 * the selection, a tap does not select, a title is cut or a drag reads the linear scale; no_claim =
 * the change engine's roles (simple-priorities.spec.ts).
 */

const PHONE = { width: 390, height: 844 };
const VIEWS = [
  { name: "desktop, light", phone: false, scheme: "light" },
  { name: "phone, dark", phone: true, scheme: "dark" },
  { name: "desktop, dark", phone: false, scheme: "dark" },
  { name: "phone, light", phone: true, scheme: "light" },
] as const;

async function setUp(page: Page, scheme: "light" | "dark", scenario: string | null) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, ADMIN.email);
}

const GOALS = [
  { goal: "Reliability", parts: ["M1 4.0", "M2 3.0", "M3 4.0"], total: "11.0 wk" },
  { goal: "Growth", parts: ["M1 3.0", "M2 7.0", "M3 6.0"], total: "16.0 wk" },
  { goal: "Activation", parts: ["M1 6.0", "M2 3.0", "M3 4.0"], total: "13.0 wk" },
  { goal: "Revenue", parts: ["M2 2.0", "M3 9.0"], total: "11.0 wk" },
];

/** The labels whose text reads under 4.5:1 on their own background (the nearest painted one). */
async function contrasts(where: Locator) {
  return where.evaluateAll((els) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bg = (e: Element | null): number[] => {
      for (; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c.length < 4 || c[3] > 0)) return c;
      }
      return [255, 255, 255];
    };
    return els
      .map((e) => {
        const [a, b] = [lum(rgb(getComputedStyle(e).color)), lum(bg(e))].sort((x, y) => y - x);
        return { text: e.textContent, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
      })
      .filter((x) => x.ratio < 4.5);
  });
}

/** No label inside the element is wider than its box (nothing cut). */
async function nothingCut(where: Locator) {
  const cut = await where.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
  expect(cut).toEqual([]);
}

const mark = (page: Page, code: string) => page.locator(`[data-testid="vxe-point"][data-code="${code}"]`);
const sideRow = (page: Page, code: string) => page.locator(`[data-testid="side-row"][data-code="${code}"]`);
const centreX = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return b.x + b.width / 2;
};

for (const v of VIEWS) {
  test.describe(v.name, () => {
    if (v.phone) test.use({ viewport: PHONE, hasTouch: true });

    test("goal buckets: where each goal's work lands, by milestone, from the plan", async ({ page }) => {
      await setUp(page, v.scheme, "simple-plan");
      await page.goto("/simple/priorities");
      await expect(page.getByTestId("prio-subtitle")).toContainText("2 Nov - 12 Feb");
      await page.getByRole("tab", { name: "Goal buckets" }).click();
      const head = page.getByTestId("buckets-head");
      await expect(head.getByRole("heading", { name: "Where each goal's work lands" })).toBeVisible();
      await expect(head.getByTestId("buckets-summary")).toHaveText(
        "This quarter: 56.0 engineer-weeks over three milestones (51.0 planned + 5.0 spare). Bars are engineer-weeks.",
      );
      await expect(head.getByTestId("milestone-chip")).toHaveText([
        "M1 · 2 Nov - 27 Nov · 13.0 of 16.0 wk",
        "M2 · 30 Nov - 25 Dec · 15.0 of 16.0 wk",
        "M3 · 28 Dec - 12 Feb · 23.0 of 24.0 wk",
      ]);
      // The chip's name is in its title (hover), not its words: the owner's "M2 · dates · how full".
      await expect(head.getByTestId("milestone-chip").nth(1)).toHaveAttribute("title", "M2 Scale volume");
      const bars = head.getByTestId("goal-bar");
      await expect(bars).toHaveCount(4);
      for (const [k, g] of GOALS.entries()) {
        const bar = bars.nth(k);
        await expect(bar.getByTestId("goal-bar-name")).toHaveText(g.goal);
        await expect(bar.getByTestId("goal-bar-total")).toHaveText(g.total);
        await expect(bar.getByTestId("goal-bar-segment")).toHaveCount(g.parts.length);
        for (const p of g.parts) await expect(bar).toContainText(p);
      }
      // A longer total draws a longer bar: Growth's 16 against Reliability's 11.
      const width = async (k: number) => (await bars.nth(k).getByTestId("goal-bar-track").boundingBox())!.width;
      const fill = async (k: number) =>
        (await bars.nth(k).getByTestId("goal-bar-segment").evaluateAll((els) => els.reduce((n, e) => n + e.getBoundingClientRect().width, 0))) / (await width(k));
      expect((await fill(1)) / (await fill(0))).toBeCloseTo(16 / 11, 1);
      await expect(head.getByTestId("buckets-footnote")).toHaveText("Each feature counts once, under the goal it moves most. Engineer-weeks are the PRD's, per slice.");
      await expect(page.getByText(/Share of .* by engineer-weeks/)).toHaveCount(0);
      await nothingCut(head.locator('[data-testid="goal-bar-segment"] span, [data-testid="milestone-chip"]'));
      // Every label on a milestone colour reads at AA (4.5:1), light and dark.
      expect(await contrasts(head.locator('[data-testid="goal-bar-segment"] span'))).toEqual([]);

      // The goal cards: each feature with its milestone chips and weeks.
      const growth = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
      await expect(growth.getByRole("heading", { name: "Growth" })).toBeVisible();
      await expect(growth.getByTestId("plan-goal-total")).toHaveText("16.0 wk");
      const invites = growth.locator('[data-testid="plan-feature"][data-code="F-05"]');
      await expect(invites).toContainText("F-05 Team invites");
      await expect(invites.getByTestId("plan-chip")).toHaveText(["M1 3.0 wk", "M2 2.0 wk"]);
      await expect(invites.getByTestId("plan-feature-total")).toHaveText("5.0 wk");
      const launch = growth.locator('[data-testid="plan-feature"][data-code="F-10"]');
      await expect(launch.getByTestId("plan-chip")).toHaveText(["M2 PM-owned"]);
      await expect(page.getByTestId("plan-goal")).toHaveCount(4);
      await nothingCut(page.locator('[data-testid="plan-chip"]'));
      expect(await contrasts(page.locator('[data-testid="plan-chip"]'))).toEqual([]);

      // Roadmap items outside the plan (the alerts roadmap's) still show, under their goal.
      const outside = page.getByTestId("plan-outside");
      await expect(outside.getByRole("heading", { name: "Also this quarter, outside the plan" })).toBeVisible();
      const retention = outside.locator('[data-testid="plan-outside-goal"][data-key="grow-retention"]');
      await expect(retention).toContainText("Grow retention");
      for (const title of ["Alert rules engine", "Weekly alert digest", "Mobile alert push"]) await expect(retention).toContainText(title);
      // The plan's own features are in the cards above, not again here.
      await expect(outside).not.toContainText("Setup checklist");
    });

    test("value / effort: a log effort axis split at the medians, linked to the ranked list", async ({ page }) => {
      await setUp(page, v.scheme, null);
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(mark(page, "alert-rules")).toBeVisible();

      // The log axis: 0.5, 1, 2, 4 wk, each doubling the same distance.
      const ticks = page.getByTestId("vxe-tick");
      await expect(ticks).toHaveText(["0.5 wk", "1 wk", "2 wk", "4 wk"]);
      const xs = await Promise.all([0, 1, 2, 3].map((k) => centreX(ticks.nth(k))));
      expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 0);
      expect(xs[2] - xs[1]).toBeCloseTo(xs[3] - xs[2], 0);
      // A 2-week mark sits on the 2 wk tick (alert-sso: value 3, effort 2).
      expect(Math.abs((await centreX(mark(page, "alert-sso"))) - xs[2])).toBeLessThan(4);

      // The quadrants at the medians, each with its name and count.
      await expect(page.getByTestId("vxe-quadrant")).toHaveText(["Quick wins · 2", "Big bets · 3", "Fill-ins · 3", "Later · 1"]);
      const plot = (await page.getByTestId("vxe-plot").boundingBox())!;
      const split = (await page.getByTestId("vxe-median-effort").boundingBox())!;
      // The effort median is 2 weeks: the line runs through the 2 wk tick, not the plot's middle.
      expect(Math.abs(split.x + split.width / 2 - xs[2])).toBeLessThan(4);
      expect(Math.abs(split.x + split.width / 2 - (plot.x + plot.width / 2))).toBeGreaterThan(10);

      // Twins fan out: alert-export and setup-video share value 0, effort 1.
      const a = (await mark(page, "alert-export").boundingBox())!;
      const b = (await mark(page, "setup-video").boundingBox())!;
      const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(overlap).toBe(0);
      await expect(mark(page, "alert-export").getByTestId("vxe-code")).toHaveText("AE");

      // The Ranked list's titles wrap, never cut.
      await nothingCut(page.locator('[data-testid="side-row"] [data-testid="prio-title"]'));

      // Select a mark (a tap on a phone): its row lights up and comes into view.
      if (v.phone) await mark(page, "price-tiers").tap();
      else await mark(page, "price-tiers").click();
      await expect(mark(page, "price-tiers")).toHaveAttribute("aria-pressed", "true");
      await expect(sideRow(page, "price-tiers")).toHaveAttribute("data-selected", "true");
      await expect(sideRow(page, "price-tiers")).toBeInViewport();
      await expect(page.locator('[data-testid="side-row"][data-selected="true"]')).toHaveCount(1);
      // Select a row: its mark lights up instead.
      if (v.phone) await sideRow(page, "alert-digest").getByRole("button").tap();
      else await sideRow(page, "alert-digest").getByRole("button").click();
      await expect(mark(page, "alert-digest")).toHaveAttribute("aria-pressed", "true");
      await expect(mark(page, "price-tiers")).toHaveAttribute("aria-pressed", "false");
      await expect(sideRow(page, "alert-digest")).toHaveAttribute("data-selected", "true");
      if (!v.phone) {
        // Escape closes what is open on top first (the Ask panel), and leaves the selection.
        // Simple has no Ask strip: its rail's Ask Oracle opens the panel (qa-shell-16), and a
        // closed panel leaves no dock behind.
        await page.getByTestId("simple-ask").click();
        await expect(page.getByTestId("hop-dock")).toHaveAttribute("data-open", "true");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("hop-dock")).toHaveCount(0);
        await expect(sideRow(page, "alert-digest")).toHaveAttribute("data-selected", "true");
      }
      // Escape clears both.
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-testid="side-row"][data-selected="true"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="vxe-point"][aria-pressed="true"]')).toHaveCount(0);
      // The keyboard: Enter on a focused mark selects it.
      await mark(page, "setup-video").focus();
      await page.keyboard.press("Enter");
      await expect(sideRow(page, "setup-video")).toHaveAttribute("data-selected", "true");
      await expect(sideRow(page, "setup-video")).toBeInViewport();
    });
  });
}

test("value / effort: a sideways drag re-estimates effort on the log scale", async ({ page }) => {
  await setUp(page, "light", null);
  await page.goto("/simple/priorities?tab=value-effort");
  const ticks = page.getByTestId("vxe-tick");
  await expect(ticks).toHaveCount(4);
  // One doubling is the distance from the 1 wk tick to the 2 wk tick: setup-import, 3 weeks,
  // dragged to 1.5 weeks is one doubling to the left.
  const octave = (await centreX(ticks.nth(2))) - (await centreX(ticks.nth(1)));
  const at = (await mark(page, "setup-import").boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 - octave, at.y + at.height / 2 + 3, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByText("Re-estimated setup-import: effort 1.5 wk")).toBeVisible();
  await expect(page.getByRole("button", { name: /setup-import: goal value 6, effort 1\.5 weeks/ })).toBeVisible();
  // A drag is not a selection.
  await expect(page.locator('[data-testid="side-row"][data-selected="true"]')).toHaveCount(0);
});

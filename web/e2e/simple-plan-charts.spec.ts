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
 * plan's capacity, planned and spare weeks in one line, a legend entry per milestone (B: a
 * swatch, the code, its dates "Nov 2 – Nov 27" and how full it is, its name in the title), one
 * stacked bar per goal in B's strong milestone colours with a segment per milestone ("M1 4.0",
 * blank when too narrow) and its total, B's footnote, every total equal to the plan's, goal
 * cards as B (the name, "n features this quarter", a row per feature: code, name, a chip per
 * milestone, its weeks or PM-owned) with "+ Suggest a feature" and "✦ Ask Oracle to suggest"
 * under each list, and the page's quarter label the plan's span; no label is cut and every
 * label on a milestone colour reads at 4.5:1; roadmap items outside the plan still listed
 * under their goal; fails_when = a number differs from the plan, the old "Share of ..."
 * caption shows, the bars are pale tints, a bar or chip is missing, a label overflows or reads
 * under 4.5:1, or items outside the plan vanish; no_claim = how the API reads the plan (api
 * tests/test_simple_plan_api.py), what the suggest buttons open (the next test).
 *
 * Card plan-charts-value-effort: protects = the effort axis is logarithmic (ticks 0.5, 1, 2,
 * 4, "Effort (engineer-weeks, log scale)", a doubling the same distance), the value axis has
 * B's gridlines and values, the quadrant lines sit at the medians with each quadrant's name and
 * count (Quick wins 2, Big bets 3, Fill-ins 3, Later 1), marks keep their codes, a feature with
 * no goal is a neutral dashed circle (never a cross) named in the legend, two marks on the same
 * spot fan out so neither hides the other, and B's legend and drag note; fails_when = a linear
 * axis, quadrants split at the middle of the plot instead of the medians, a count is wrong, a
 * cross, or the twin marks overlap; no_claim = the API's scoring.
 *
 * Card plan-charts-linked: protects = selecting a mark (click, tap or the keyboard) highlights
 * its row in the Ranked list beside the chart and scrolls it into view, selecting a row
 * highlights its mark, Escape clears both (once the Ask panel it may have closed first is shut);
 * a real tap on a phone selects; the Ranked rows are B's one line each (rank, code, the name cut
 * with "…" and whole in its title, a small "Misses" chip, the score); a sideways drag still
 * re-estimates effort on the log scale through the change engine; fails_when = the row or mark
 * is not highlighted, the row stays off screen, Escape leaves a highlight, Escape that closes
 * the Ask panel also clears the selection, a tap does not select, a row runs onto a second
 * line or reads "Misses This quarter …", or a drag reads the linear scale; no_claim =
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
      // B's legend: a swatch, the code in bold, its dates and how full ("M1 Oct 19 – Nov 13 · 14.0 of 14.0 wk").
      await expect(head.getByTestId("milestone-chip")).toHaveText([
        "M1 Nov 2 – Nov 27 · 13.0 of 16.0 wk",
        "M2 Nov 30 – Dec 25 · 15.0 of 16.0 wk",
        "M3 Dec 28 – Feb 12 · 23.0 of 24.0 wk",
      ]);
      // The milestone's name is in its title (hover), not its words.
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
      await expect(head.getByTestId("buckets-footnote")).toHaveText(
        "Each feature counts once, under the goal it moves most (listed first in the PRD's Goals column). Engineer-weeks are the PRD's, per slice.",
      );
      await expect(page.getByText(/Share of .* by engineer-weeks/)).toHaveCount(0);
      // B's strong milestone colours, not pale tints: each segment's text is --on-accent on it.
      const fills = await head.getByTestId("goal-bar-segment").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
      expect(fills).toHaveLength(3);
      // A label shows only where it fits (B leaves a narrow segment blank, its words in its title).
      await nothingCut(head.locator('[data-testid="goal-bar-label"], [data-testid="milestone-chip"]'));
      if (!v.phone) await expect(head.getByTestId("goal-bar-label")).toHaveCount(11);
      // Every label on a milestone colour reads at AA (4.5:1), light and dark.
      expect(await contrasts(head.getByTestId("goal-bar-label"))).toEqual([]);

      // The goal cards, as B: the name, "n features this quarter", a row per feature (code, name,
      // a chip per milestone, its weeks or PM-owned).
      const growth = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
      await expect(growth.getByRole("heading", { name: "Growth" })).toBeVisible();
      await expect(growth.getByTestId("plan-goal-count")).toHaveText("5 features this quarter");
      const invites = growth.locator('[data-testid="plan-feature"][data-code="F-05"]');
      await expect(invites).toContainText("F-05 Team invites");
      await expect(invites.getByTestId("plan-chip")).toHaveText(["M1", "M2"]);
      await expect(invites.getByTestId("plan-chip").first()).toHaveAttribute("title", "M1 Prove it: 3.0 wk");
      await expect(invites.getByTestId("plan-feature-total")).toHaveText("5.0 wk");
      const launch = growth.locator('[data-testid="plan-feature"][data-code="F-10"]');
      await expect(launch.getByTestId("plan-chip")).toHaveText(["M2"]);
      await expect(launch.getByTestId("plan-feature-total")).toHaveText("PM-owned");
      await expect(page.getByTestId("plan-goal")).toHaveCount(4);
      await nothingCut(page.locator('[data-testid="plan-chip"]'));
      expect(await contrasts(page.locator('[data-testid="plan-chip"]'))).toEqual([]);
      // B's two buttons under each goal's list, for who may suggest.
      await expect(page.getByTestId("goal-suggest-feature")).toHaveCount(4);
      await expect(page.getByTestId("goal-ask-oracle")).toHaveText(Array(4).fill("✦ Ask Oracle to suggest"));

      // Roadmap items outside the plan (the alerts roadmap's) still show, under their goal.
      const outside = page.getByTestId("plan-outside");
      await expect(outside.getByRole("heading", { name: "Also this quarter, outside the plan" })).toBeVisible();
      const retention = outside.locator('[data-testid="plan-outside-goal"][data-key="grow-retention"]');
      await expect(retention).toContainText("Grow retention");
      for (const title of ["Alert rules engine", "Weekly alert digest", "Mobile alert push"]) await expect(retention).toContainText(title);
      // The plan's own features are in the cards above, not again here.
      await expect(outside).not.toContainText("Setup checklist");
    });

    /**
     * Card fid-prio-suggest: protects = under each goal's list on Goal buckets (the owner's pick
     * B), "+ Suggest a feature" opens that goal's suggestions drawer with the form open (the
     * owner too, who decides) and the suggestion sent lands under People, and "✦ Ask Oracle to
     * suggest" asks Oracle at once and opens the drawer on Oracle's tab, where its suggestions
     * arrive; fails_when = a card has no way to suggest, the form stays folded, the ask is not
     * sent or the drawer opens on the wrong tab; no_claim = who may suggest (the viewer test
     * below), the suggestions API (pytest test_simple_suggestions*).
     */
    test("goal buckets: suggest a feature, or ask Oracle to suggest one, from a goal's card", async ({ page }) => {
      await setUp(page, v.scheme, "simple-plan");
      await page.goto("/simple/priorities?tab=buckets");
      const growth = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
      await growth.getByTestId("goal-suggest-feature").click();
      const panel = page.getByTestId("goal-panel");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Suggestions · Growth" })).toBeVisible();
      const form = panel.getByTestId("suggest-form");
      await expect(form).toBeVisible();
      await form.getByLabel("Feature name").fill("Invite from the dashboard");
      await form.getByLabel("What it does, and for whom").fill("An admin invites a teammate from the usage dashboard");
      await form.getByRole("button", { name: "Send suggestion" }).click();
      await expect(page.getByText("Sent: Invite from the dashboard")).toBeVisible();
      await expect(panel.getByTestId("suggestions-tab-people")).toHaveText("People · 1");
      await expect(panel.locator('[data-testid="person-suggestion"][data-title="Invite from the dashboard"]')).toBeVisible();
      await panel.getByRole("button", { name: /^Close/ }).first().click();
      await expect(panel).toHaveCount(0);

      const reliability = page.locator('[data-testid="plan-goal"][data-goal="Reliability"]');
      await reliability.getByTestId("goal-ask-oracle").click();
      await expect(page.getByText("Oracle is suggesting features for Reliability")).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Suggestions · Reliability" })).toBeVisible();
      await expect(panel.getByTestId("suggestions-tab-oracle")).toHaveAttribute("aria-selected", "true");
      await expect(panel.locator('[data-testid="goal-suggestion"][data-title="Setup health check"]')).toBeVisible();
      await expect(panel.getByTestId("suggestions-tab-oracle")).toHaveText("✦ Oracle · 2");
      await panel.getByRole("button", { name: /^Close/ }).first().click();
      await expect(reliability.getByTestId("goal-ask-oracle")).toHaveText("✦ Ask Oracle to suggest");
    });

    test("value / effort: a log effort axis split at the medians, linked to the ranked list", async ({ page }) => {
      await setUp(page, v.scheme, null);
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(mark(page, "alert-rules")).toBeVisible();

      // The log axis: 0.5, 1, 2, 4 (B: "Effort (engineer-weeks, log scale)"), each doubling the same distance.
      const ticks = page.getByTestId("vxe-tick");
      await expect(ticks).toHaveText(["0.5", "1", "2", "4"]);
      await expect(page.getByText("Effort (engineer-weeks, log scale) →")).toBeVisible();
      // The goal value axis: B's gridlines with their values, 0 at the foot.
      await expect(page.getByTestId("vxe-value-tick")).toHaveText(["0", "2", "4", "6", "8"]);
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
      // The median lines say what they are ("middle effort", "middle value"), never under a mark.
      const marks = await page.getByTestId("vxe-point").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      for (const id of ["vxe-middle-effort", "vxe-middle-value"]) {
        const l = (await page.getByTestId(id).boundingBox())!;
        const under = marks.filter((m) => m.x < l.x + l.width && l.x < m.x + m.width && m.y < l.y + l.height && l.y < m.y + m.height);
        expect(under, id).toEqual([]);
      }
      // A feature with no goal is never a cross: a neutral dashed circle, named in the legend.
      for (const code of ["alert-export", "setup-video", "price-tiers"]) await expect(mark(page, code)).toHaveAttribute("data-shape", "none");
      await expect(mark(page, "alert-rules")).toHaveAttribute("data-shape", "square");
      const legend = page.getByLabel("Legend");
      await expect(legend.getByTestId("vxe-legend-no-goal")).toHaveText("No goal");
      await expect(legend).toContainText("Codes stay with the item; ranks are in the list. Hollow: below the line (not this quarter).");
      await expect(page.getByText("Drag a mark sideways to change its effort, up or down to change its goal value (or use the arrow keys).")).toBeVisible();

      // B's Ranked rows: one line each (rank, code, the name cut with "…", the score), a row
      // that misses the line carrying a small "Misses" chip (the line in its title).
      const rowHeights = await page.getByTestId("side-row").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      for (const h of rowHeights) expect(h).toBeLessThanOrEqual(30);
      const misses = sideRow(page, "price-tiers").getByTestId("prio-misses");
      await expect(misses).toHaveText("Misses");
      await expect(misses).toHaveAttribute("title", "Misses This quarter (Now)");
      await expect(sideRow(page, "price-tiers").getByTestId("prio-title")).toHaveAttribute("title", "New plan tiers");

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
        await page.getByTestId("hop-strip").click();
        await expect(page.getByTestId("hop-dock")).toHaveAttribute("data-open", "true");
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("hop-dock")).toHaveAttribute("data-open", "false");
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

/**
 * Card fid-prio-suggest-roles: protects = a commenter gets B's two buttons under each goal's
 * list; a viewer, who may not suggest, gets neither, only the goal's suggestions to read;
 * fails_when = a viewer is offered a suggest button or a commenter is not; no_claim = the API's
 * refusal of a viewer's suggestion (pytest).
 */
for (const who of ["commenter", "viewer"] as const) {
  test(`goal buckets: who may suggest gets the two buttons, a viewer reads the suggestions (${who})`, async ({ page }) => {
    await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan"] as const);
    await login(page, `${who}@example.com`);
    await page.goto("/simple/priorities?tab=buckets");
    await expect(page.getByTestId("buckets-head")).toBeVisible();
    const growth = page.locator('[data-testid="plan-goal"][data-goal="Growth"]');
    if (who === "commenter") {
      await expect(growth.getByTestId("goal-suggest-feature")).toHaveText("+ Suggest a feature");
      await expect(growth.getByTestId("goal-ask-oracle")).toHaveText("✦ Ask Oracle to suggest");
    } else {
      await expect(growth.getByTestId("goal-suggestions-open")).toBeVisible();
      await expect(page.getByTestId("goal-suggest-feature")).toHaveCount(0);
      await expect(page.getByTestId("goal-ask-oracle")).toHaveCount(0);
    }
  });
}

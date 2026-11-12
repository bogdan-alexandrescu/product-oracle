import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The Simple roadmap's shared chart (Chart in _timeline.tsx: the Waterfall here, the Plan's
 * Timeline too) on a phone, driven as a person does against the mock's invented data:
 * Today stays named on the chart, and no quarter label is cut by the chart's edge, whether
 * the chart is scrolled to its start or to its end. A desktop's chart does not move.
 */

async function open(page: Page, theme: "light" | "dark") {
  await page.context().addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, theme] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-waterfall").click();
  const chart = page.locator('[data-testid="simple-chart"][data-format="waterfall"]');
  await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
  return chart;
}

/** Each quarter label's text and whether its box is cut by the svg's edge or by the edge of the part in view. */
async function labels(page: Page) {
  return page.locator('[data-testid="simple-chart"] [data-testid="chart-scroll"]').evaluate((box) => {
    const b = box.getBoundingClientRect();
    const view = [b.left + box.clientLeft, b.left + box.clientLeft + box.clientWidth];
    const s = box.querySelector("svg")!.getBoundingClientRect();
    return [...box.querySelectorAll('[data-testid="axis-tick"]')].map((t) => {
      const r = t.getBoundingClientRect();
      const cut = r.left < s.left - 0.5 || r.right > s.right + 0.5 || (r.left < view[0] - 0.5 && r.right > view[0] + 0.5) || (r.left < view[1] - 0.5 && r.right > view[1] + 0.5);
      const shown = r.right > view[0] + 0.5 && r.left < view[1] - 0.5;
      return { text: t.textContent ?? "", cut, shown };
    });
  });
}

for (const width of [390, 320]) {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${width} wide, ${theme}`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: true });

      test("Today is named on the chart", async ({ page }) => {
        // protects: on a 390 and a 320 wide phone, in the light and the dark theme, the Waterfall draws Today's line and a pill reading "Today" that sits inside the part of the chart in view
        // fails_when: the line is missing, the pill does not read "Today", or the pill is cut off by the edge of the view
        // no_claim: Today's exact date, the quarter labels, or scrolled positions
        const chart = await open(page, theme);
        const scroll = chart.getByTestId("chart-scroll");

        // Today: its line (an svg line has no width, so it is never "visible" to Playwright) and
        // its pill, inside the part of the chart in view.
        await expect(chart.getByTestId("today-line")).toBeAttached();
        const pill = chart.getByTestId("today-pill");
        await expect(pill).toBeVisible();
        await expect(pill).toHaveText("Today");
        const [p, v] = await Promise.all([pill.boundingBox(), scroll.boundingBox()]);
        expect(p!.x).toBeGreaterThanOrEqual(v!.x);
        expect(p!.x + p!.width).toBeLessThanOrEqual(v!.x + v!.width);
      });

      test("every quarter label is whole", async ({ page }) => {
        // protects: on a 390 and a 320 wide phone, in the light and the dark theme, no Waterfall quarter label is cut by the chart's edge or the edge of the view, at the start and scrolled to the end, each reads like "Q4 2026" or "Q2 '27", and the last shows at the end
        // fails_when: a label is cut by an edge, a label is not in those forms, or the last label is out of view at the end
        // no_claim: Today's pill, widths other than these two, or the label order
        const chart = await open(page, theme);
        const scroll = chart.getByTestId("chart-scroll");

        // Every label whole, at the start and scrolled to the end (where the last one shows).
        for (const end of [false, true]) {
          if (end) await scroll.evaluate((el) => (el.scrollLeft = el.scrollWidth));
          await expect
            .poll(async () => (await labels(page)).filter((l) => l.cut).map((l) => l.text), { message: `cut labels${end ? " at the end" : ""}` })
            .toEqual([]);
          const all = await labels(page);
          for (const l of all) expect(l.text).toMatch(/^Q[1-4] (\d{4}|'\d{2})$/);
          if (end) expect(all.at(-1)!.shown).toBe(true);
        }
      });
    });
  }
}

test.describe("1440 wide", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the desktop's chart does not move", async ({ page }) => {
    // protects: at 1440 wide, the Waterfall fits its box with nothing to scroll, its quarter labels start at their own lines in order (year in full on the first and each Q1), and the "Today" pill sits by its line
    // fails_when: the chart is wider than its box, a label is moved off its line or is out of order or in the wrong form, or the Today pill is far from its line
    // no_claim: phone widths, the dark theme, or scrolling
    const chart = await open(page, "light");
    const svg = chart.getByTestId("chart-svg");
    const scroll = chart.getByTestId("chart-scroll");
    // The chart fits its box: nothing to scroll, so no label is moved for a scroll window.
    const [w, box] = await Promise.all([svg.evaluate((s: SVGSVGElement) => s.width.baseVal.value), scroll.evaluate((el) => el.clientWidth)]);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(box + 1);
    const ticks = await chart.locator('[data-testid="chart-axis"] > g').evaluateAll((gs) =>
      gs.map((g) => {
        const t = g.querySelector('[data-testid="axis-tick"]');
        return { line: Number(g.querySelector("line")!.getAttribute("x1")), text: t?.textContent ?? "", x: Number(t?.getAttribute("x")), anchor: t?.getAttribute("text-anchor") };
      }),
    );
    expect(ticks.length).toBeGreaterThan(4);
    // Each quarter is labelled in order, from its own line (just after it), left to right.
    ticks.forEach((t, n) => {
      expect(t.text).toMatch(n === 0 || t.text.startsWith("Q1") ? /^Q[1-4] \d{4}$/ : /^Q[2-4] '\d{2}$/);
      expect(t.anchor).toBe("start");
      expect(t.x - t.line).toBeCloseTo(3, 1);
      if (n) expect(t.line).toBeGreaterThan(ticks[n - 1].line);
    });
    await expect(chart.getByTestId("today-pill")).toHaveText("Today");
    // Today's pill sits by its line, inside the chart.
    const line = Number(await chart.getByTestId("today-line").getAttribute("x1"));
    const pillX = Number(await chart.locator('[data-testid="today-pill"] rect').getAttribute("x"));
    expect(Math.abs(pillX - line)).toBeLessThan(40);
    expect(Number(await chart.getByTestId("today-line").getAttribute("y1"))).toBeGreaterThan(30);
  });
});

test("no quarter label is cut at any width from 320 to 1680", async ({ page }) => {
  // protects: as the window is resized across 14 widths from 320 to 1680 in the light theme, no Waterfall quarter label is cut by the chart's edge or the view's edge, at the start and scrolled to the end
  // fails_when: at any of those widths a label is cut at either scroll place
  // no_claim: the label text, Today's pill, the dark theme, or widths between the ones tried
  await page.setViewportSize({ width: 320, height: 844 });
  const chart = await open(page, "light");
  const scroll = chart.getByTestId("chart-scroll");
  for (const width of [320, 360, 390, 430, 520, 600, 641, 700, 800, 900, 1024, 1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 844 });
    for (const end of [false, true]) {
      await scroll.evaluate((el, e) => (el.scrollLeft = e ? el.scrollWidth : 0), end);
      await expect
        .poll(async () => (await labels(page)).filter((l) => l.cut).map((l) => l.text), { message: `cut labels at ${width}${end ? ", scrolled to the end" : ""}` })
        .toEqual([]);
    }
  }
});

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
    const chart = await open(page, "light");
    const svg = chart.getByTestId("chart-svg");
    await expect(svg).toHaveAttribute("width", "893");
    await expect(svg).toHaveAttribute("height", "712");
    const ticks = await chart.getByTestId("axis-tick").evaluateAll((ts) => ts.map((t) => [t.textContent, Number(t.getAttribute("x")), t.getAttribute("text-anchor")] as const));
    const want: [string, number][] = [
      ["Q4 2026", 3],
      ["Q1 2027", 92.98],
      ["Q2 2027", 181.01],
      ["Q3 2027", 270.02],
      ["Q4 2027", 360.0],
      ["Q1 2028", 449.99],
      ["Q2 2028", 539.0],
      ["Q3 2028", 628.0],
      ["Q4 2028", 717.99],
      ["Q1 2029", 807.97],
    ];
    expect(ticks.map(([t, , a]) => [t, a])).toEqual(want.map(([t]) => [t, "start"]));
    ticks.forEach(([, x], n) => expect(x).toBeCloseTo(want[n][1], 1));
    await expect(chart.getByTestId("today-pill")).toHaveText("Today");
    expect(Number(await chart.locator('[data-testid="today-pill"] rect').getAttribute("x"))).toBeCloseTo(22.54, 1);
    await expect(chart.getByTestId("today-line")).toHaveAttribute("y1", "38");
  });
});

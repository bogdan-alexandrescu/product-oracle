import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Reported at 390 px: on a phone the roadmap chart (Chart in _timeline.tsx, on the Simple
 * roadmap and on the Plan page that shares it) hid its Today pill and cut its last quarter
 * label ("Q2 20"). A guard, driven as a person does on a phone against the mock's invented
 * data: the Today pill's box is on screen and in the part of the chart in view, and each
 * quarter label's box is whole inside the chart, at its start and scrolled to its end.
 */

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function simple(page: Page, format: "waterfall" | "gantt") {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
  const chart = page.locator(
    `[data-testid="simple-chart"][data-format="${format}"]`,
  );
  await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
  return chart;
}

async function plan(page: Page) {
  await page.addInitScript(([key, v]) => localStorage.setItem(key, v), [
    MOCK_SCENARIO_KEY,
    "plan-timeline",
  ] as const);
  await login(page);
  await page.goto("/plan");
  await page
    .getByRole("group", { name: "Roadmap view" })
    .getByRole("button", { name: "Timeline", exact: true })
    .click();
  const chart = page.getByTestId("plan-timeline").getByTestId("simple-chart");
  await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
  return chart;
}

/** The Today pill's box: on screen, inside the part of the chart in view. */
async function todayOnScreen(page: Page, chart: Locator) {
  const pill = chart.getByTestId("today-pill");
  await chart.getByTestId("chart-axis").scrollIntoViewIfNeeded();
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("Today");
  const [p, v] = await Promise.all([
    pill.boundingBox(),
    chart.getByTestId("chart-scroll").boundingBox(),
  ]);
  const screen = page.viewportSize()!;
  expect(p!.width).toBeGreaterThan(30);
  expect(p!.x).toBeGreaterThanOrEqual(Math.max(0, v!.x));
  expect(p!.x + p!.width).toBeLessThanOrEqual(
    Math.min(screen.width, v!.x + v!.width),
  );
  expect(p!.y).toBeGreaterThanOrEqual(0);
  expect(p!.y + p!.height).toBeLessThanOrEqual(screen.height);
}

/** Each quarter label: its words, and whether its box is cut by the chart's edge or the edge of the part in view. */
function labels(chart: Locator) {
  return chart.getByTestId("chart-scroll").evaluate((box) => {
    const b = box.getBoundingClientRect();
    const view = [
      b.left + box.clientLeft,
      b.left + box.clientLeft + box.clientWidth,
    ];
    const s = box.querySelector("svg")!.getBoundingClientRect();
    return [...box.querySelectorAll('[data-testid="axis-tick"]')].map((t) => {
      const r = t.getBoundingClientRect();
      const across = (edge: number) =>
        r.left < edge - 0.5 && r.right > edge + 0.5;
      return {
        text: t.textContent ?? "",
        cut:
          r.left < s.left - 0.5 ||
          r.right > s.right + 0.5 ||
          across(view[0]) ||
          across(view[1]),
        shown: r.right > view[0] + 0.5 && r.left < view[1] - 0.5,
      };
    });
  });
}

async function quartersWhole(chart: Locator) {
  const scroll = chart.getByTestId("chart-scroll");
  for (const end of [false, true]) {
    await scroll.evaluate(
      (el, e) => (el.scrollLeft = e ? el.scrollWidth : 0),
      end,
    );
    await expect
      .poll(
        async () =>
          (await labels(chart)).filter((l) => l.cut).map((l) => l.text),
        { message: `cut labels${end ? " at the end" : ""}` },
      )
      .toEqual([]);
    const all = await labels(chart);
    expect(all.length).toBeGreaterThan(1);
    for (const l of all) expect(l.text).toMatch(/^Q[1-4] (\d{4}|'\d{2})$/);
    // Scrolled to its end, the last quarter's label is in view, whole.
    if (end) expect(all.at(-1)!.shown).toBe(true);
  }
}

test("Simple roadmap, Waterfall: Today is on screen and every quarter label is whole", async ({
  page,
}) => {
  const chart = await simple(page, "waterfall");
  await todayOnScreen(page, chart);
  await quartersWhole(chart);
});

test("Simple roadmap, Gantt: Today is on screen", async ({ page }) => {
  const chart = await simple(page, "gantt");
  await todayOnScreen(page, chart);
});

test("Plan, Timeline: Today is on screen and every quarter label is whole", async ({
  page,
}) => {
  const chart = await plan(page);
  await todayOnScreen(page, chart);
  await quartersWhole(chart);
});

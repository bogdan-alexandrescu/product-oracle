import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's Timeline and Waterfall (qa4-simple-roadmap-16, 26, 27, 28, 31,
 * 47), driven as a person does against the mock's invented data (the default scenario).
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, opts: { scenario?: string; url?: string } = {}) {
  const { scenario = "", url = "/simple/roadmap" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const timeline = (page: Page) => page.locator('[data-testid="simple-chart"][data-format="timeline"]');

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa4-27: no milestone, key date or Today line runs through a label at the top of the Timeline", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    await expect(chart.getByTestId("milestone-end-label").first()).toBeVisible();
    const strikes = await chart.locator('svg[data-testid="chart-svg"]').evaluate((svg) => {
      const lines = [...svg.querySelectorAll<SVGLineElement>('[data-testid="today-line"], [data-testid="milestone-end-line"], [data-testid="key-date-marker"] line')];
      const labels = [...svg.querySelectorAll<SVGTextElement>('[data-testid="milestone-end-label"], [data-testid="key-date-label"], [data-testid="track-milestone"] text')];
      const out: string[] = [];
      for (const t of labels) {
        const b = t.getBBox();
        // (A track's label sits in a translated group: its box in the chart's own pixels.)
        const m = t.getCTM();
        const s = (svg as unknown as SVGGraphicsElement).getCTM();
        const dx = m && s ? m.e - s.e : 0;
        const dy = m && s ? m.f - s.f : 0;
        const [x0, x1, y0, y1] = [b.x + dx + 1, b.x + dx + b.width - 1, b.y + dy + 1, b.y + dy + b.height - 1];
        for (const l of lines) {
          const x = Number(l.getAttribute("x1"));
          const top = Math.min(Number(l.getAttribute("y1")), Number(l.getAttribute("y2")));
          const bottom = Math.max(Number(l.getAttribute("y1")), Number(l.getAttribute("y2")));
          if (x > x0 && x < x1 && top < y1 && bottom > y0) out.push(`${l.getAttribute("data-testid") ?? "key date line"} through "${t.textContent}"`);
        }
      }
      return out;
    });
    expect(strikes).toEqual([]);
  });

  test("qa4-26: Oracle's dotted date suggestion for Welcome video fits inside the Timeline", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    const outline = chart.locator('rect[data-testid="suggestion-outline"][data-item="setup-video"]');
    await expect(outline).toBeAttached();
    const svgW = Number(await chart.locator('svg[data-testid="chart-svg"]').getAttribute("width"));
    const right = Number(await outline.getAttribute("x")) + Number(await outline.getAttribute("width"));
    // Its rounded end and its 1.5 px stroke whole, clear of the chart's right edge.
    expect(right).toBeLessThanOrEqual(svgW - 6);
  });

  test("qa4-28: each Timeline lane is as tall as what it draws (Group by Goal)", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    await expect(chart.locator('g[data-testid="bar"]').first()).toBeVisible();
    const gaps = await chart.evaluate((root) => {
      const lanes = [...root.querySelectorAll<HTMLElement>('[data-testid="chart-labels"] [data-lane]')];
      const out: string[] = [];
      for (const lane of lanes) {
        const lb = lane.getBoundingClientRect();
        const key = lane.dataset.lane;
        const bottoms = [...root.querySelectorAll<SVGGElement>(`g[data-testid="bar"][data-lane="${key}"]`)].map((g) => g.getBoundingClientRect().bottom);
        const items = [...root.querySelectorAll<SVGGElement>(`g[data-testid="bar"][data-lane="${key}"]`)].map((g) => g.dataset.item);
        for (const c of root.querySelectorAll<HTMLElement>('[data-testid="broken-callout"]')) if (items.includes(c.dataset.item)) bottoms.push(c.getBoundingClientRect().bottom);
        if (!bottoms.length) continue;
        const empty = lb.bottom - Math.max(...bottoms);
        // A lane's foot: its 8 px pad and the pill's 4 px inset; never a band of empty rows.
        if (empty > 20) out.push(`${lane.textContent}: ${Math.round(empty)} px empty`);
      }
      return out;
    });
    expect(gaps).toEqual([]);
  });

  test("qa4-47: the Timeline's bars come in reading order: lane by lane, row by row, left to right", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    await expect(chart.locator('g[data-testid="bar"]').first()).toBeVisible();
    const order = await chart.evaluate((root) => {
      const lanes = [...root.querySelectorAll<HTMLElement>('[data-testid="chart-labels"] [data-lane]')].map((l) => l.dataset.lane);
      return [...root.querySelectorAll<SVGGElement>('g[data-testid="bar"][tabindex="0"]')].map((g) => ({
        item: g.dataset.item!,
        lane: lanes.indexOf(g.dataset.lane),
        row: Number(g.dataset.row),
        x: Number(g.dataset.x0),
      }));
    });
    expect(order.length).toBeGreaterThan(3);
    const sorted = [...order].sort((a, b) => a.lane - b.lane || a.row - b.row || a.x - b.x);
    expect(order.map((o) => o.item)).toEqual(sorted.map((o) => o.item));
    // And Tab walks them so: the first bar, then the next in reading order.
    const first = chart.locator(`g[data-testid="bar"][data-item="${sorted[0].item}"]`);
    await first.focus();
    await page.keyboard.press("Tab");
    const next = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-testid="bar"], [data-testid="suggestion-open"]')?.getAttribute("data-item"));
    // (A bar's own "?" for Oracle's dates may come right after it.)
    expect([sorted[0].item, sorted[1].item]).toContain(next);
  });

  test("qa4-31: the Waterfall legend groups its phases under a label and Today with the marks", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    await expect(page.locator('[data-testid="simple-chart"][data-format="waterfall"]')).toBeVisible();
    const legend = page.getByTestId("legend");
    const phases = legend.locator('[data-group="phases"]');
    await expect(phases).toContainText("Phases");
    await expect(phases.getByTestId("phase-key").first()).toBeVisible();
    // Beta, the phase, is never read as Beta, a key date.
    const beta = phases.getByTestId("phase-key").filter({ hasText: "Beta" });
    if (await beta.count()) await expect(beta).toHaveText("Beta phase");
    for (const t of await legend.getByTestId("phase-key").allTextContents()) expect(t).not.toBe("Beta");
    // Today sits with the other marks, not on its own.
    await expect(legend.locator('[data-group="marks"] [data-key="today"]')).toHaveText("Today");
    await expect(legend.locator(':scope > [data-key="today"]')).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa4-16: the phone Waterfall's warnings wrap and sit clear of the bars; goal names wrap", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    const chart = page.locator('[data-testid="simple-chart"][data-format="waterfall"]');
    await expect(chart).toBeVisible();
    const callouts = chart.getByTestId("broken-callout");
    await expect(callouts.first()).toBeAttached();
    const problems = await chart.evaluate((root) => {
      const out: string[] = [];
      const bodies = [...root.querySelectorAll<SVGRectElement>('g[data-testid="bar"] rect[data-body]')].map((r) => ({ item: r.closest("g[data-testid=bar]")?.getAttribute("data-item"), b: r.getBoundingClientRect() }));
      for (const c of root.querySelectorAll<HTMLElement>('[data-testid="broken-callout"]')) {
        const cb = c.getBoundingClientRect();
        for (const { item, b } of bodies)
          if (cb.left < b.right - 1 && b.left < cb.right - 1 && cb.top < b.bottom - 1 && b.top < cb.bottom - 1) out.push(`${c.dataset.item}'s warning over ${item}`);
        const words = c.querySelector<HTMLElement>("span");
        if (words && (getComputedStyle(words).textOverflow === "ellipsis" || words.scrollWidth > words.clientWidth + 1)) out.push(`${c.dataset.item}'s warning is cut`);
      }
      for (const g of root.querySelectorAll<HTMLElement>('[data-testid="chart-group"] span[title]')) {
        if (getComputedStyle(g).textOverflow === "ellipsis" || g.scrollWidth > g.clientWidth + 1) out.push(`"${g.title}" is cut`);
        // Nor painted past its row.
        const row = g.closest<HTMLElement>('[data-testid="chart-group"]')!.getBoundingClientRect();
        const b = g.getBoundingClientRect();
        if (b.bottom > row.bottom + 1 || b.top < row.top - 1) out.push(`"${g.title}" runs out of its row`);
      }
      return out;
    });
    expect(problems).toEqual([]);
  });
});

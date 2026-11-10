import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's Timeline, Gantt and Waterfall (qa4-simple-roadmap-16, 26, 27,
 * 28, 31, 47), driven as a person does against the mock's invented data (the default scenario).
 * The Timeline is mk-qa4-roadmap's (_zoom.tsx); milestones, key dates and Oracle's date
 * suggestions are checked on the Gantt, which draws them.
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
const gantt = (page: Page) => page.locator('[data-testid="simple-chart"][data-format="gantt"]');
const WORDS: Record<string, string> = { goal: "Goal", track: "Track", prd: "PRD", milestone: "Milestone" };

test.describe("desktop", () => {
  test.use(DESKTOP);

  // mk-qa4-roadmap: the Timeline (QR1 A) draws no milestones or key dates over its chart; the
  // Gantt does, in every Group by.
  test("qa4-27: no milestone, key date or Today line runs through a label at the top of the Gantt", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    const chart = gantt(page);
    await expect(chart).toBeVisible();
    // Each grouping draws its own marks (a milestone's end under Milestone, a track's under Track).
    for (const group of ["goal", "track", "prd", "milestone"]) {
      await page.getByTestId(`group-${group}`).click();
      await expect(chart.getByTestId("chart-labels").locator(":scope > div").first()).toHaveText(WORDS[group]);
      await expect(chart.locator('[data-testid="key-date-label"], [data-testid="milestone-end-label"], [data-testid="track-milestone"] text').first()).toBeVisible();
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
      expect(strikes, `Group by ${group}`).toEqual([]);
    }
  });

  // mk-qa4-roadmap: Oracle's date suggestions are drawn on the Gantt, not the Timeline.
  test("qa4-26: Oracle's dotted date suggestion for Welcome video fits inside the Gantt", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    const chart = gantt(page);
    const outline = chart.locator('rect[data-testid="suggestion-outline"][data-item="setup-video"]');
    await expect(outline).toBeAttached();
    const svgW = Number(await chart.locator('svg[data-testid="chart-svg"]').getAttribute("width"));
    const right = Number(await outline.getAttribute("x")) + Number(await outline.getAttribute("width"));
    // Its rounded end and its 1.5 px stroke whole, clear of the chart's right edge.
    expect(right).toBeLessThanOrEqual(svgW - 6);
  });

  test("qa4-28: each Timeline lane is as tall as what it draws: a row per item it counts, no empty rows", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    await expect(chart.getByTestId("timeline-bar").first()).toBeVisible();
    const gaps = await chart.evaluate((root) => {
      const out: string[] = [];
      const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="timeline-lane"], [data-testid="timeline-row"]')];
      let lane: { name: string; count: number; seen: number } | null = null;
      const close = () => {
        // tb-mk: a track band names no count (the owner's pick C); it draws at least one row, never an empty band.
        if (lane && (lane.count < 0 ? lane.seen < 1 : lane.seen !== lane.count)) out.push(`${lane.name}: says ${lane.count}, draws ${lane.seen}`);
      };
      for (const r of rows) {
        if (r.dataset.testid === "timeline-lane") {
          close();
          const t = r.textContent ?? "";
          lane = { name: t, count: Number(/· (\d+) items?/.exec(t)?.[1] ?? -1), seen: 0 };
          continue;
        }
        if (lane) lane.seen++;
        // A row is as tall as its bar and a little room; never a band of empty rows.
        const h = r.getBoundingClientRect().height;
        if (h > 40) out.push(`${r.dataset.item}: ${Math.round(h)} px tall`);
        if (!r.querySelector('[data-testid="timeline-bar"]')) out.push(`${r.dataset.item}: an empty row`);
      }
      close();
      return out;
    });
    expect(gaps).toEqual([]);
  });

  test("qa4-47: the Timeline's rows come in reading order: lane by lane, each lane by start date", async ({ page }) => {
    await open(page);
    const chart = timeline(page);
    await expect(chart.getByTestId("timeline-bar").first()).toBeVisible();
    const lanes = await chart.evaluate((root) => {
      const out: { lane: string; items: { item: string; x: number }[] }[] = [];
      for (const r of root.querySelectorAll<HTMLElement>('[data-testid="timeline-lane"], [data-testid="timeline-row"]')) {
        if (r.dataset.testid === "timeline-lane") out.push({ lane: r.textContent ?? "", items: [] });
        else out[out.length - 1]?.items.push({ item: r.dataset.item!, x: r.querySelector<HTMLElement>('[data-testid="timeline-bar"]')!.getBoundingClientRect().left });
      }
      return out;
    });
    expect(lanes.flatMap((l) => l.items).length).toBeGreaterThan(3);
    // (Below the line keeps the cut order, not dates.)
    for (const l of lanes.filter((x) => !x.lane.startsWith("Below the line"))) {
      const sorted = [...l.items].sort((a, b) => a.x - b.x);
      expect(l.items.map((o) => o.item), l.lane).toEqual(sorted.map((o) => o.item));
    }
    // And Tab walks them so: a row's name, its bar, then the next row's name.
    const rows = chart.getByTestId("timeline-row");
    const [first, second] = [await rows.nth(0).getAttribute("data-item"), await rows.nth(1).getAttribute("data-item")];
    await rows.nth(0).locator("button[title]").focus();
    await page.keyboard.press("Tab");
    const at = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { item: el?.closest('[data-testid="timeline-row"]')?.getAttribute("data-item"), bar: el?.dataset.testid === "timeline-bar" };
    });
    expect(await at()).toEqual({ item: first, bar: true });
    await page.keyboard.press("Tab");
    expect(await at()).toEqual({ item: second, bar: false });
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

  test("qa4-16: the phone Waterfall's warnings sit in the panel above it, whole; goal names wrap", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-waterfall").click();
    const chart = page.locator('[data-testid="simple-chart"][data-format="waterfall"]');
    await expect(chart).toBeVisible();
    // mk-qa4-roadmap QR3 A: the broken links sit in their own panel above the chart, never over a bar.
    const panel = page.getByTestId("conflicts");
    await expect(panel.getByTestId("conflict").first()).toBeVisible();
    const pb = (await panel.boundingBox())!;
    const cb = (await chart.boundingBox())!;
    expect(pb.y + pb.height, "the warnings sit above the chart").toBeLessThanOrEqual(cb.y + 1);
    const vw = page.viewportSize()!.width;
    expect(pb.x + pb.width, "the panel fits the phone").toBeLessThanOrEqual(vw + 1);
    for (const c of await panel.getByTestId("conflict").all()) {
      const words = c.getByRole("button").first();
      const cut = await words.evaluate((el) => getComputedStyle(el).textOverflow === "ellipsis" || el.scrollWidth > el.clientWidth + 1);
      expect(cut, `${await c.getAttribute("data-item")}'s warning is whole`).toBe(false);
    }
    const problems = await chart.evaluate((root) => {
      const out: string[] = [];
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

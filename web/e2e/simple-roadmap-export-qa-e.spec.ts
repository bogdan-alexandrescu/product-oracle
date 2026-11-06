import { readFileSync, writeFileSync } from "node:fs";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA pass E on the Simple roadmap's exports (and the axes they copy), driven as a
 * person does against the mock's invented data: each export is read as the page draws it,
 * the SVG it hands to the canvas, and the PDF from the file it saves.
 */

declare global {
  interface Window {
    __exportSvgs?: string[];
  }
}

type Format = "timeline" | "gantt" | "waterfall" | "board";

async function open(page: Page, opts: { scenario?: string; theme?: "light" | "dark"; format?: Format } = {}) {
  const { scenario = "", theme = "light", format = "timeline" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey, t]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, t);
      // Keep each SVG picture the export draws onto its canvas.
      const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        ...d,
        set(v: string) {
          const src = String(v);
          if (src.startsWith("data:image/svg+xml")) (window.__exportSvgs ??= []).push(decodeURIComponent(src.slice(src.indexOf(",") + 1)));
          d.set!.call(this, v);
        },
      });
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

/** Clicks Export PNG or PDF, waits for the file, and gives back the picture it was drawn from and the file's bytes. */
async function exported(page: Page, kind: "PNG" | "PDF"): Promise<{ svg: string; bytes: Buffer }> {
  const before = await page.evaluate(() => window.__exportSvgs?.length ?? 0);
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: `Export ${kind}` }).click()]);
  expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${kind.toLowerCase()}$`));
  const all = await page.evaluate(() => window.__exportSvgs ?? []);
  expect(all.length).toBeGreaterThan(before);
  return { svg: all[all.length - 1], bytes: readFileSync((await file.path())!) };
}

/** The texts of the elements a selector finds in an exported picture. */
async function textsIn(page: Page, svg: string, sel: string): Promise<string[]> {
  return page.evaluate(
    ([markup, s]) => [...new DOMParser().parseFromString(markup, "image/svg+xml").querySelectorAll(s)].map((t) => (t.textContent ?? "").trim()),
    [svg, sel] as const,
  );
}

const QUARTER = /^Q[1-4] (\d{4}|'\d{2})$/;

test.describe("R1: a phone's exported chart keeps every quarter label whole", () => {
  for (const width of [390, 320]) {
    test.describe(`${width} wide`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: true });

      test("the exported Waterfall names every quarter, each at its own line", async ({ page }) => {
        await open(page, { format: "waterfall" });
        const chart = page.locator('[data-testid="simple-chart"][data-format="waterfall"]');
        await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
        const scroll = chart.getByTestId("chart-scroll");
        // Scrolled to the middle of the chart's second quarter: the page moves that quarter's label into view.
        const quarters = await chart.locator('[data-testid="chart-axis"] > g').count();
        await scroll.evaluate((el) => {
          const lines = [...el.querySelectorAll('[data-testid="chart-axis"] > g > line')];
          el.scrollLeft = Number(lines[1].getAttribute("x1")) + 20;
        });
        for (const kind of ["PNG", "PDF"] as const) {
          const { svg } = await exported(page, kind);
          const ticks = await page.evaluate((markup) => {
            const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
            return [...doc.querySelectorAll('[data-testid="chart-axis"] > g')].map((g) => {
              const line = g.querySelector("line")!;
              const t = g.querySelector('[data-testid="axis-tick"]');
              return { line: Number(line.getAttribute("x1")), text: t?.textContent ?? "", x: Number(t?.getAttribute("x") ?? -1), anchor: t?.getAttribute("text-anchor") ?? "" };
            });
          }, svg);
          expect(ticks, `${kind}: a label for every quarter`).toHaveLength(quarters);
          for (const t of ticks) {
            expect(t.text, `${kind}: whole quarter label`).toMatch(QUARTER);
            // Its own place: just after its quarter's line (the last may end at the chart's edge).
            if (t.anchor !== "end") expect(t.x - t.line, `${kind}: ${t.text} sits at its line`).toBeCloseTo(3, 0);
          }
        }
      });
    });
  }
});

test.describe("A phone's Timeline export names every quarter and every goal", () => {
  for (const width of [390, 320]) {
    test.describe(`${width} wide`, () => {
      test.use({ viewport: { width, height: 844 }, hasTouch: true });

      test("the PNG and the PDF carry each quarter the page lists, its months, and each goal's lane by name", async ({ page }) => {
        await open(page, { format: "timeline" });
        await expect(page.getByTestId("timeline-quarter").first()).toBeVisible();
        // What the phone shows: each quarter ("Q4 2026", "Oct – Dec 2026") and the goal each row serves.
        const heads = await page.locator('[data-testid="timeline-quarter"] h3').allInnerTexts();
        const shown = heads.map((h) => {
          const m = /^(Q[1-4] \d{4})\s+((?:Jan|Apr|Jul|Oct) – (?:Mar|Jun|Sep|Dec) \d{4})/.exec(h.replace(/\s+/g, " ").trim());
          expect(m, `a quarter's head: ${h}`).not.toBeNull();
          return { label: m![1], months: m![2] };
        });
        expect(shown.length).toBeGreaterThan(1);
        const rows = await page.locator('[data-testid="timeline-bar"] > span > span:nth-child(2)').allInnerTexts();
        const goals = [...new Set(rows.map((r) => r.split(" · ").slice(1).join(" · ").trim()).filter(Boolean))];
        expect(goals.length).toBeGreaterThan(1);
        for (const kind of ["PNG", "PDF"] as const) {
          await page.evaluate(() => (window.__poExports = []));
          const { svg, bytes } = await exported(page, kind);
          // Kept beside the test's results, to be looked at.
          writeFileSync(test.info().outputPath(`timeline-${width}.${kind.toLowerCase()}`), bytes);
          writeFileSync(test.info().outputPath(`timeline-${width}-${kind.toLowerCase()}.svg`), svg);
          const quarters = await textsIn(page, svg, '[data-testid="export-quarter"]');
          for (const q of shown) {
            expect(quarters, `${kind}: ${q.label} on the axis`).toContain(q.label);
            expect(quarters, `${kind}: ${q.label}'s months`).toContain(q.months);
          }
          // Its months too, month first.
          const months = await textsIn(page, svg, '[data-testid="chart-axis"] [data-testid="axis-tick"]');
          expect(months.length, `${kind}: month ticks`).toBeGreaterThan(2);
          for (const m of months) expect(m).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{4})?$/);
          // A lane reads "2 Faster activation · 3 items": its number, its goal whole, its count.
          const lanes = (await textsIn(page, svg, '[data-testid="export-lane"]')).map((l) => l.replace(/^\d+\s*/, ""));
          for (const g of goals) expect(lanes.some((l) => l === g || l.startsWith(`${g} · `)), `${kind}: the lane ${g} is named whole`).toBe(true);
          if (kind === "PDF") {
            const pdf = bytes.toString("latin1");
            expect(pdf).toContain("/MediaBox [0 0 792 612]");
            expect(pdf).toMatch(/\(Page 1 of \d+\)/);
          } else expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        }
      });
    });
  }
});

test.describe("A phone's Gantt export names each goal lane whole", () => {
  test.use({ viewport: { width: 320, height: 844 }, hasTouch: true });

  test("each lane's goal and metric read whole in the PNG and the PDF", async ({ page }) => {
    await open(page, { format: "gantt" });
    const groups = page.locator('[data-testid="chart-labels"] > [data-testid="chart-group"]');
    await expect(groups.first()).toBeVisible();
    // Each lane's goal and, after it, its metric ("Grow retention · Teams active after 90 days").
    const names = await groups.evaluateAll((els) =>
      els.map((el) => [...el.querySelectorAll("span[title]")].map((t) => (t.getAttribute("title") ?? "").trim()).filter(Boolean).join(" · ")).filter(Boolean),
    );
    expect(names.length).toBeGreaterThan(1);
    for (const kind of ["PNG", "PDF"] as const) {
      const { svg } = await exported(page, kind);
      const lanes = (await textsIn(page, svg, '[data-testid="export-lane"]')).map((l) => l.replace(/^\d+\s*/, ""));
      for (const n of names) expect(lanes, `${kind}: ${n} whole`).toContain(n);
    }
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("E-1: the Timeline's export is the zoom shown: its months, window, goals and dated milestones", async ({ page }) => {
    await open(page, { format: "timeline" });
    await expect(page.getByTestId("timeline-row").first()).toBeVisible();
    const lanes = (await page.getByTestId("timeline-lane").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim().split(" · ")[0].replace(/^\d+\s*/, ""));
    expect(lanes.length).toBeGreaterThan(0);
    const files: Record<string, string> = {};
    for (const zoom of ["3m", "1y"] as const) {
      await page.getByTestId(`zoom-${zoom}`).click();
      await expect(page.getByTestId(`zoom-${zoom}`)).toHaveAttribute("aria-pressed", "true");
      const { svg } = await exported(page, "PNG");
      files[zoom] = svg;
      const months = await textsIn(page, svg, '[data-testid="export-month"]');
      expect(months.length, `${zoom}: month ticks`).toBeGreaterThanOrEqual(zoom === "3m" ? 2 : 10);
      for (const m of months) expect(m).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)( \d{4})?$/);
      expect(months[0], "the first month names its year").toMatch(/ \d{4}$/);
      // Every goal's lane is named.
      const named = await textsIn(page, svg, '[data-testid="export-lane"]');
      for (const lane of lanes) expect(named.join("\n")).toContain(lane);
      // A milestone in the file says its day.
      for (const m of await textsIn(page, svg, '[data-testid="export-milestone"]')) expect(m).toMatch(/· (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/);
      // Drawn as a person would read it: each bar's words clear of its bar, the header's words above Today's line.
      const clash = await page.evaluate((markup) => {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
        host.innerHTML = markup;
        document.body.append(host);
        const out: string[] = [];
        for (const row of host.querySelectorAll('[data-testid="export-row"]')) {
          const bar = row.querySelector<SVGGraphicsElement>('[data-testid="export-bar"]');
          const words = row.querySelector<SVGGraphicsElement>('[data-testid="export-bar-words"]');
          // (A bar wider than the view, both its ends out of sight, carries its dates on it.)
          if (!bar || !words || words.getAttribute("data-place") === "inside") continue;
          const b = bar.getBBox();
          const w = words.getBBox();
          if (w.x < b.x + b.width - 0.5 && w.x + w.width > b.x + 0.5) out.push(`words over bar: ${words.textContent}`);
        }
        const today = host.querySelector('[data-testid="export-today"]');
        if (today) {
          const y1 = Number(today.getAttribute("y1"));
          for (const t of host.querySelectorAll<SVGGraphicsElement>('[data-testid="export-milestone"], [data-testid="export-month"]')) if (t.getBBox().y + t.getBBox().height > y1 + 0.5) out.push(`Today through: ${t.textContent}`);
        }
        host.remove();
        return out;
      }, svg);
      expect(clash).toEqual([]);
    }
    expect(files["3m"], "3 months and 1 year export different pictures").not.toEqual(files["1y"]);
  });

  test("E-10: an export from a dark page is drawn in the light palette", async ({ page }) => {
    await open(page, { theme: "dark", format: "gantt" });
    await expect(page.getByTestId("chart-svg")).toBeVisible();
    const { svg } = await exported(page, "PNG");
    const fills = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      return [...doc.querySelectorAll("rect, text")].map((e) => (e.getAttribute("fill") ?? "").toLowerCase());
    }, svg);
    expect(fills[0], "the page behind the picture is white").toMatch(/^#(fff|ffffff)$/);
    // None of the dark theme's surfaces or text colours.
    for (const dark of ["#0c1a2e", "#06101e", "#11233b", "#1e3350"]) expect(fills, `no ${dark}`).not.toContain(dark);
  });

  test("E-5: a cut row's export keeps its name and its note", async ({ page }) => {
    await open(page, { format: "gantt" });
    const row = page.locator('[data-testid="chart-labels"] > *').filter({ has: page.getByTestId("return-place") }).first();
    await expect(row).toBeVisible();
    const title = (await row.getByTestId("label-title").innerText()).trim();
    const note = (await row.getByTestId("return-place").innerText()).trim();
    const { svg } = await exported(page, "PNG");
    const texts = await textsIn(page, svg, "text");
    expect(texts).toContain(`${title} · ${note}`);
  });

  test("a cut card in the Now / Next / Later export keeps its place in the return queue", async ({ page }) => {
    await open(page, { format: "gantt" });
    const row = page.locator('[data-testid="chart-labels"] > *').filter({ has: page.getByTestId("return-place") }).first();
    await expect(row).toBeVisible();
    const title = (await row.getByTestId("label-title").innerText()).trim();
    const note = (await row.getByTestId("return-place").innerText()).trim();
    await page.getByTestId("format-board").click();
    await expect(page.getByTestId("board")).toBeVisible();
    const { svg } = await exported(page, "PNG");
    const texts = await textsIn(page, svg, "text");
    const at = texts.indexOf(title);
    expect(at, `the card ${title}`).toBeGreaterThanOrEqual(0);
    expect(texts[at + 1]).toMatch(new RegExp(` · ${note}$`));
  });

  test("E-3: the Gantt's week axis names the year on its first tick and each January, page and export", async ({ page }) => {
    await open(page, { format: "gantt" });
    await page.getByTestId("unit-week").click();
    const chart = page.getByTestId("chart-svg");
    await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
    const want = async (root: string) =>
      page.evaluate((markup) => {
        const doc = markup ? new DOMParser().parseFromString(markup, "image/svg+xml") : document;
        const days = [...doc.querySelectorAll('[data-testid="chart-axis"] > g[data-day]')].map((g) => g.getAttribute("data-day")!);
        const years = [...doc.querySelectorAll('[data-testid="axis-year"]')].map((t) => [t.closest("g[data-day]")?.getAttribute("data-day"), t.textContent]);
        return { days, years };
      }, root);
    for (const source of ["page", "export"] as const) {
      const { days, years } = await want(source === "page" ? "" : (await exported(page, "PNG")).svg);
      expect(days.length, source).toBeGreaterThan(20);
      // The first tick, then the first tick of each new year.
      const expected = days.filter((d, n) => n === 0 || d.slice(0, 4) !== days[n - 1].slice(0, 4)).map((d) => [d, d.slice(0, 4)]);
      expect(expected.length, "the span crosses a new year").toBeGreaterThan(1);
      expect(years, source).toEqual(expected);
    }
  });

  test("E-4: the Gantt's day scale names the month over its first column and each 1st", async ({ page }) => {
    await open(page, { format: "gantt" });
    await page.getByTestId("unit-day").click();
    const chart = page.getByTestId("chart-svg");
    await expect(chart.getByTestId("axis-tick").first()).toBeVisible();
    const { days, months } = await chart.evaluate((svg) => ({
      days: [...svg.querySelectorAll('[data-testid="chart-axis"] > g[data-day]')].map((g) => g.getAttribute("data-day")!),
      months: [...svg.querySelectorAll('[data-testid="axis-month"]')].map((t) => [t.closest("g[data-day]")?.getAttribute("data-day"), t.textContent]),
    }));
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const expected = days.filter((d, n) => n === 0 || d.endsWith("-01")).map((d, n) => [d, n === 0 || d.slice(5, 7) === "01" ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : MONTHS[Number(d.slice(5, 7)) - 1]]);
    expect(expected.length).toBeGreaterThan(1);
    expect(months).toEqual(expected);
  });

  test("E-17: the Waterfall's quarters read one way: the year in full on the first and each Q1", async ({ page }) => {
    await open(page, { format: "waterfall" });
    const ticks = await page.getByTestId("chart-svg").getByTestId("axis-tick").allTextContents();
    expect(ticks.length).toBeGreaterThan(4);
    ticks.forEach((t, n) => expect(t, `quarter ${n + 1}`).toMatch(n === 0 || t.startsWith("Q1") ? /^Q[1-4] \d{4}$/ : /^Q[2-4] '\d{2}$/));
  });

  test("E-16: a feature that runs reads Exists, with the day it was checked, never 'proof old'", async ({ page }) => {
    await open(page, { format: "gantt" });
    const old = page.locator('[data-testid="chart-labels"] [data-testid="cs-mark"][data-mark="exists_old"]').first();
    await expect(old).toBeVisible();
    await expect(old).toHaveText(/^Exists( · checked (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(, \d{4})?)?$/);
    await expect(page.getByTestId("chart-labels")).not.toContainText(/proof old/i);
  });
});

test.describe("500 items", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(180_000);

  test("E-2 / E-7: the PDF is Letter pages with page numbers, Flate not JPEG; the PNG says it is busy and saves", async ({ page }) => {
    await open(page, { scenario: "simple-500", format: "gantt" });
    await expect(page.getByTestId("chart-svg")).toBeVisible();
    const png = page.getByRole("button", { name: "Export PNG" });
    const [file] = await Promise.all([
      page.waitForEvent("download", { timeout: 90_000 }),
      (async () => {
        await png.click();
        // Busy while it draws.
        await expect(page.getByRole("button", { name: /Exporting/ }).first()).toBeVisible();
      })(),
    ]);
    expect(file.suggestedFilename()).toBe("roadmap-gantt.png");
    await expect(png).toBeEnabled();

    await page.evaluate(() => (window.__poExports = []));
    const { bytes } = await exported(page, "PDF");
    const [drawn] = await page.evaluate(() => window.__poExports ?? []);
    const pdf = bytes.toString("latin1");
    const pages = pdf.match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length, "several pages").toBeGreaterThan(1);
    // Each page holds at most a page's height of the picture, its header again on top.
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(drawn.height / 1300));
    expect(pdf).toContain("/MediaBox [0 0 792 612]");
    expect(pdf).toContain("/FlateDecode");
    expect(pdf).not.toContain("/DCTDecode");
    expect(pdf).toContain(`(Page 1 of ${pages.length})`);
    expect(pdf).toContain(`(Page ${pages.length} of ${pages.length})`);
    // The footer's last line ends at the right margin, measured in Helvetica (Page n of N).
    const at = Number(/BT \/F1 8 Tf [\d. ]+rg ([\d.]+) \d+ Td \(Page 1 of /.exec(pdf)?.[1]);
    expect(at).toBeGreaterThan(700);
    expect(at).toBeLessThan(740);

    // The day scale would take hundreds of pages: it says so, and to filter it.
    await page.getByTestId("unit-day").click();
    await page.getByRole("button", { name: "Export PDF" }).click();
    await expect(page.getByText("The view would take more than 200 PDF pages: filter it to export it")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Export PDF" })).toBeEnabled();
  });
});

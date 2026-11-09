import { readFileSync } from "node:fs";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Export QA on Simple > Roadmap > Timeline > Export PDF, against the mock's invented data: the
 * Today pill sits centred on its line, a bar cut by the window's edge carries an arrow that says
 * it goes on, and the PDF's words can be selected and searched (a text layer over the picture).
 */

declare global {
  interface Window {
    __cueSvgs?: string[];
  }
}

async function openTimeline(page: Page) {
  await page.context().addInitScript(() => {
    // Keep each SVG picture the export draws onto its canvas.
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...d,
      set(v: string) {
        const src = String(v);
        if (src.startsWith("data:image/svg+xml")) (window.__cueSvgs ??= []).push(decodeURIComponent(src.slice(src.indexOf(",") + 1)));
        d.set!.call(this, v);
      },
    });
  });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-timeline").click();
  await expect(page.getByTestId("format-timeline")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("zoom-3m").click();
  await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
}

async function exportPdf(page: Page): Promise<{ svg: string; pdf: string }> {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.getByRole("button", { name: "Export PDF" }).click()]);
  expect(file.suggestedFilename()).toBe("roadmap-timeline.pdf");
  const all = await page.evaluate(() => window.__cueSvgs ?? []);
  expect(all.length).toBeGreaterThan(0);
  return { svg: all[all.length - 1], pdf: readFileSync((await file.path())!).toString("latin1") };
}

test("the Timeline's PDF: Today's pill on its line, an arrow on each cut bar, its words as text", async ({ page }) => {
  await openTimeline(page);

  // The bars the page shows cut by the window's right or left edge (part of each in sight).
  const onScreen = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="timeline-scroll"]')!;
    const names = scroll.querySelector<HTMLElement>('[data-testid="timeline-names-head"]')!;
    const left = names.getBoundingClientRect().right;
    const right = scroll.getBoundingClientRect().left + scroll.clientWidth;
    let later = 0;
    let earlier = 0;
    for (const bar of scroll.querySelectorAll<HTMLElement>('[data-testid="timeline-bar"]')) {
      const r = bar.getBoundingClientRect();
      if (r.right <= left || r.left >= right) continue;
      if (r.right > right + 1) later++;
      if (r.left < left - 1) earlier++;
    }
    return { later, earlier };
  });
  expect(onScreen.later, "the mock shows a bar running past the last month").toBeGreaterThan(0);
  expect(onScreen.earlier, "the mock shows a bar starting before the first month").toBeGreaterThan(0);

  const { svg, pdf } = await exportPdf(page);
  const drawn = await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
    host.innerHTML = markup;
    document.body.append(host);
    const pill = host.querySelector<SVGGraphicsElement>('[data-testid="export-today-pill"] rect')!.getBBox();
    const line = Number(host.querySelector('[data-testid="export-today"]')!.getAttribute("x1"));
    const cuts = [...host.querySelectorAll('[data-testid="export-row"] [data-testid="export-bar-cut"]')].map((a) => a.getAttribute("data-side"));
    // The earlier side's arrow: on its bar's left end, pointing left.
    const earlier = [...host.querySelectorAll<SVGGraphicsElement>('[data-testid="export-bar-cut"][data-side="earlier"]')].map((a) => {
      const bar = a.parentElement!.querySelector<SVGGraphicsElement>('[data-testid="export-bar"]')!.getBBox();
      const d = (a.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
      return { barLeft: bar.x, tip: d[2], back: d[0] };
    });
    host.remove();
    return { centre: pill.x + pill.width / 2, line, cuts, earlier };
  }, svg);

  // (1) The pill's centre on Today's line, as the page draws it.
  expect(Math.abs(drawn.centre - drawn.line)).toBeLessThanOrEqual(1);
  // (3) Each cut bar carries an arrow at the edge it runs past.
  expect(drawn.cuts.filter((s) => s === "later")).toHaveLength(onScreen.later);
  expect(drawn.cuts.filter((s) => s === "earlier")).toHaveLength(onScreen.earlier);
  for (const e of drawn.earlier) {
    expect(e.tip, "the earlier arrow points left").toBeLessThan(e.back);
    expect(e.tip - e.barLeft, "on the bar's left end").toBeGreaterThanOrEqual(0);
    expect(e.tip - e.barLeft).toBeLessThanOrEqual(4);
  }
  // (2) The words are text in the PDF (invisible over the picture, so it looks the same): the
  // header, Today and each goal's lane can be selected and searched.
  expect(pdf).toContain("3 Tr");
  expect(pdf).toMatch(/\(Roadmap \S Timeline\) Tj/);
  expect(pdf).toContain("(Today) Tj");
  const lanes = (await page.getByTestId("timeline-lane").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim().split(" · ")[0].replace(/^\d+\s*/, ""));
  expect(lanes.length).toBeGreaterThan(0);
  const ascii = lanes.filter((l) => /^[ -~]+$/.test(l) && !/[()\\]/.test(l));
  for (const lane of ascii) expect(pdf).toContain(lane.slice(0, 12));
});

for (const side of ["later", "earlier"] as const) {
  test(`a one-week bar the ${side} edge cuts to a sliver: its arrow in the chart, its name and dates readable`, async ({ page }) => {
    await openTimeline(page);
    const scroll = page.getByTestId("timeline-scroll");
    // The chart's shortest bar (a week), and where the window shows it.
    const at = () =>
      scroll.evaluate((el) => {
        const labelW = el.querySelector<HTMLElement>('[data-testid="timeline-names-head"]')!.offsetWidth;
        const bars = [...el.querySelectorAll<HTMLElement>('[data-testid="timeline-bar"]')];
        const bar = bars.sort((a, b) => a.offsetWidth - b.offsetWidth)[0];
        const r = bar.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const row = bar.closest<HTMLElement>('[data-testid="timeline-row"]')!;
        return {
          labelW,
          width: el.clientWidth,
          start: bar.dataset.start ?? "",
          end: bar.dataset.end ?? "",
          name: row.querySelector("button[title]")?.getAttribute("title") ?? "",
          // The bar's ends in the chart's own x (the names column from 0 to labelW).
          x0: r.left - box.left,
          x1: r.right - box.left,
        };
      });
    const first = await at();
    expect((Date.parse(first.end) - Date.parse(first.start)) / 86_400_000, "a one-week bar").toBeLessThanOrEqual(7);
    // Scrolled (the mouse's wheel, sideways) until 4 px of it are left in sight at that edge.
    await page.getByTestId("timeline-row").first().scrollIntoViewIfNeeded();
    const box = (await scroll.boundingBox())!;
    const top = (await page.getByTestId("timeline-row").first().boundingBox())!;
    await page.mouse.move(box.x + first.labelW + 100, top.y + top.height / 2);
    for (let n = 0; n < 4; n++) {
      const now = await at();
      const dx = side === "later" ? now.x0 - (now.width - 4) : now.x1 - (now.labelW + 4);
      if (Math.abs(dx) < 1) break;
      await page.mouse.wheel(dx, 0);
      await expect.poll(async () => (await at()).x0).not.toBe(now.x0);
    }
    const shown = await at();
    const piece = side === "later" ? shown.width - shown.x0 : shown.x1 - shown.labelW;
    expect(piece, "a sliver of it in sight").toBeGreaterThan(1);
    expect(piece).toBeLessThan(8);

    const { svg } = await exportPdf(page);
    const row = await page.evaluate(
      ([markup, name]) => {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
        host.innerHTML = markup;
        document.body.append(host);
        const g = [...host.querySelectorAll('[data-testid="export-row"]')].find((r) => [...r.querySelectorAll("text")].some((t) => (t.textContent ?? "").startsWith(name)))!;
        const box = (el: Element | null) => {
          if (!el) return null;
          const b = (el as SVGGraphicsElement).getBBox();
          return { x0: b.x, x1: b.x + b.width };
        };
        const arrow = g.querySelector('[data-testid="export-bar-cut"]');
        const words = g.querySelector('[data-testid="export-bar-words"]');
        const out = {
          side: arrow?.getAttribute("data-side") ?? null,
          arrow: box(arrow),
          words: words?.textContent ?? "",
          wordsBox: box(words),
          // The white behind the dates.
          backing: box(words?.previousElementSibling ?? null),
          names: [...g.querySelectorAll("text")].map((t) => t.textContent ?? ""),
        };
        host.remove();
        return out;
      },
      [svg, shown.name] as const,
    );
    // The name reads whole in the names column.
    expect(row.names).toContain(shown.name);
    // The arrow on the edge it runs past, wholly inside the chart (right of the names column).
    expect(row.side).toBe(side);
    expect(row.arrow!.x0).toBeGreaterThanOrEqual(shown.labelW);
    expect(row.arrow!.x1).toBeLessThanOrEqual(shown.width);
    // Its dates in the chart too, clear of the arrow: neither they nor the white behind them over it.
    expect(row.words).toMatch(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/);
    for (const b of [row.wordsBox!, row.backing!]) {
      expect(b.x0).toBeGreaterThanOrEqual(shown.labelW);
      expect(b.x1).toBeLessThanOrEqual(shown.width);
      expect(b.x1 <= row.arrow!.x0 + 0.5 || b.x0 >= row.arrow!.x1 - 0.5, `${JSON.stringify(b)} clear of the arrow ${JSON.stringify(row.arrow)}`).toBe(true);
    }
  });
}

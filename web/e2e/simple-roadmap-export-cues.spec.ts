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

  const { svg, pdf } = await exportPdf(page);
  const drawn = await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden";
    host.innerHTML = markup;
    document.body.append(host);
    const pill = host.querySelector<SVGGraphicsElement>('[data-testid="export-today-pill"] rect')!.getBBox();
    const line = Number(host.querySelector('[data-testid="export-today"]')!.getAttribute("x1"));
    const cuts = [...host.querySelectorAll('[data-testid="export-row"] [data-testid="export-bar-cut"]')].map((a) => a.getAttribute("data-side"));
    host.remove();
    return { centre: pill.x + pill.width / 2, line, cuts };
  }, svg);

  // (1) The pill's centre on Today's line, as the page draws it.
  expect(Math.abs(drawn.centre - drawn.line)).toBeLessThanOrEqual(1);
  // (3) Each cut bar carries an arrow at the edge it runs past.
  expect(drawn.cuts.filter((s) => s === "later")).toHaveLength(onScreen.later);
  expect(drawn.cuts.filter((s) => s === "earlier")).toHaveLength(onScreen.earlier);
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

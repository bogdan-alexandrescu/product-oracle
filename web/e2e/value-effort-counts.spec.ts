import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * PV-1 One count per spot (BGD's pick, Nov 7), on Simple's Priorities, Value / effort, phone (390) and desktop (1440),
 * on the mock's default company (13 features with no effort at goal value 0, 2 at effort 1 week) and its "simple-plan" scenario (the dated
 * plan, 40 features): marks that would cover each other are one dark count mark; no two marks overlap (a count is a
 * mark); every mark and count sits within half a mark of its real values (or just clear of a corner's name); a count
 * opens a sheet listing its features by rank, a row opens the one feature panel, and a lone mark opens it too.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const R = 18;

async function open(page: Page, viewport: { width: number; height: number }, scenario: string | null): Promise<void> {
  await page.setViewportSize(viewport);
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await login(page, ADMIN.email);
  await page.goto("/simple/priorities?tab=value-effort");
  await expect(page.getByTestId("simple-priorities")).toBeVisible();
  await expect(page.getByTestId("vxe-point").first()).toBeVisible();
  // The plot is measured and laid out (marks and counts at their pixels).
  await page.waitForTimeout(300);
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** What the chart draws, in page pixels: its marks and counts, the plot, its axes' ticks and the corners' names. */
async function chart(page: Page) {
  return page.evaluate(() => {
    const rect = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    };
    const mid = (e: Element) => {
      const b = e.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    const plotEl = document.querySelector('[data-testid="vxe-plot"]') as HTMLElement;
    const p = plotEl.getBoundingClientRect();
    // The marks sit in the plot's padding box (inside its 1 px border).
    const plot = { left: p.left + plotEl.clientLeft, top: p.top + plotEl.clientTop, right: p.left + plotEl.clientLeft + plotEl.clientWidth, bottom: p.top + plotEl.clientTop + plotEl.clientHeight };
    const drawn = [
      ...[...document.querySelectorAll('[data-testid="vxe-point"]')].map((e) => ({ kind: "mark" as const, name: (e as HTMLElement).dataset.code ?? "", label: e.getAttribute("aria-label") ?? "", n: 1, box: rect(e.querySelector("svg")!) })),
      ...[...document.querySelectorAll('[data-testid="vxe-crowd"]')].map((e) => ({ kind: "count" as const, name: `count of ${(e as HTMLElement).dataset.count}`, label: e.getAttribute("aria-label") ?? "", n: Number((e as HTMLElement).dataset.count), box: rect(e.querySelector("svg")!) })),
    ];
    return {
      plot,
      // The effort ticks sit under the plot, across its outer width: the same share of the padding box's width.
      xTicks: [...document.querySelectorAll('[data-testid="vxe-tick"]')].map((e) => {
        const row = e.parentElement!.getBoundingClientRect();
        return { v: Number(e.textContent), at: plot.left + ((mid(e)[0] - row.left) / row.width) * (plot.right - plot.left) };
      }),
      yTicks: [...document.querySelectorAll('[data-testid="vxe-value-tick"]')].map((e) => ({ v: Number(e.textContent), at: mid(e)[1] })),
      // The room the chart keeps for each corner's name ("Quick wins · 3"): 8.6 px a character from its outer edge.
      corners: [...document.querySelectorAll('[data-testid="vxe-quadrant"]')].map((e, k) => {
        const b = rect(e);
        const len = (e.textContent ?? "").length * 8.6;
        return k % 2 ? { ...b, left: b.right - len } : { ...b, right: b.left + len };
      }),
      drawn,
      features: document.querySelectorAll('[data-testid="side-row"]').length,
    };
  });
}

const apart = (a: Rect, b: Rect, gap: number) => a.right + gap <= b.left || b.right + gap <= a.left || a.bottom + gap <= b.top || b.bottom + gap <= a.top;

/** A mark's numbers from its name ("goal value 4, effort 2 weeks"; PM-owned work has no effort and sits at 0.25 wk). */
function markValues(label: string): { e: [number, number]; v: [number, number] } {
  const v = /goal value ([\d.]+|–)/.exec(label)![1];
  const e = /effort ([\d.]+) weeks?/.exec(label)?.[1];
  const value = v === "–" ? 0 : Number(v);
  const effort = e == null ? 0.25 : Number(e);
  return { e: [effort, effort], v: [value, value] };
}

/**
 * A count's numbers from its name ("15 features at effort 1 week · goal value 0", spans "effort 3–5 weeks · goal value
 * 5–7"); PM-owned work sits at 0.25 wk, and a feature with no goal value at 0.
 */
function countValues(label: string): { e: [number, number]; v: [number, number] } {
  const where = /^\d+ features at (.*?): /.exec(label)?.[1] ?? "";
  const pm = where.includes("PM-owned");
  const e = /effort ([\d.]+)(?:⁠–⁠([\d.]+))? weeks?/.exec(where);
  const v = /goal value ([\d.]+)(?:⁠–⁠([\d.]+))?/.exec(where);
  expect(e || pm, `a count names what its features share: ${label}`).toBeTruthy();
  const es = e ? [Number(e[1]), Number(e[2] ?? e[1])] : [0.25, 0.25];
  const vs = v ? [Number(v[1]), Number(v[2] ?? v[1])] : [0, 0];
  return { e: [pm ? 0.25 : es[0], es[1]], v: [where.includes("no goal") ? 0 : vs[0], vs[1]] };
}

/**
 * How far each mark or count sits from its real values, in px: from the nearest point of its values' spot (a count's
 * features' span; one decimal of rounding either way), kept inside the plot as the chart keeps marks. `blocked`: a
 * corner's name covers that spot, so the mark may sit just clear of it instead.
 */
function offsets(c: Awaited<ReturnType<typeof chart>>) {
  const [x0, x1] = [c.xTicks[0], c.xTicks.at(-1)!];
  const [y0, y1] = [c.yTicks[0], c.yTicks.at(-1)!];
  const xAt = (e: number) => x0.at + ((Math.log2(Math.max(0.25, e)) - Math.log2(x0.v)) / (Math.log2(x1.v) - Math.log2(x0.v))) * (x1.at - x0.at);
  const yAt = (v: number) => y0.at + ((Math.max(0, v) - y0.v) / (y1.v - y0.v)) * (y1.at - y0.at);
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return c.drawn.map((d) => {
    const { e, v } = d.kind === "mark" ? markValues(d.label) : countValues(d.label);
    const xs = [xAt(e[0] - 0.05), xAt(e[1] + 0.05)].map((x) => clamp(x, c.plot.left + R, c.plot.right - R));
    const ys = [yAt(v[1] + 0.05), yAt(v[0] - 0.05)].map((y) => clamp(y, c.plot.top + R, c.plot.bottom - R));
    const cx = (d.box.left + d.box.right) / 2;
    const cy = (d.box.top + d.box.bottom) / 2;
    const dx = Math.max(0, Math.min(...xs) - cx, cx - Math.max(...xs));
    const dy = Math.max(0, Math.min(...ys) - cy, cy - Math.max(...ys));
    // Its real spot's box, where a corner's name (3 px clear) would cover it.
    const spot = { left: Math.min(...xs) - R, right: Math.max(...xs) + R, top: Math.min(...ys) - R, bottom: Math.max(...ys) + R };
    const blocked = c.corners.find((q) => !apart(spot, q, 3));
    return { d, off: Math.hypot(dx, dy), blocked };
  });
}

for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  for (const scenario of [null, "simple-plan"]) {
    const where = `${size}, ${scenario ? "the 40-feature dated plan" : "the default company"}`;

    test(`${where}: no two marks overlap (a count is a mark) and every feature is drawn once`, async ({ page }) => {
      await open(page, viewport, scenario);
      const c = await chart(page);
      // Some marks would cover each other in both scenarios, at both widths: they are counted, not pushed away.
      expect(c.drawn.filter((d) => d.kind === "count").length, "marks that would cover each other are one count").toBeGreaterThan(0);
      expect(c.drawn.reduce((n, d) => n + d.n, 0), "every feature is one mark or in one count").toBe(c.features);
      if (scenario) expect(c.features).toBe(40);
      // V-4: every two marks keep a 4 px gap (less a layout rounding hair).
      for (let i = 0; i < c.drawn.length; i++)
        for (let j = i + 1; j < c.drawn.length; j++) expect(apart(c.drawn[i].box, c.drawn[j].box, 4 - 0.05), `${c.drawn[i].name} and ${c.drawn[j].name} touch`).toBe(true);
      for (const d of c.drawn) {
        expect(d.box.right - d.box.left, `${d.name} keeps today's 36 px size`).toBeCloseTo(2 * R, 0);
        expect(d.box.left >= c.plot.left - 0.5 && d.box.right <= c.plot.right + 0.5 && d.box.top >= c.plot.top - 0.5 && d.box.bottom <= c.plot.bottom + 0.5, `${d.name} stays inside the plot`).toBe(true);
      }
    });

    test(`${where}: every mark and count sits within half a mark of its real values`, async ({ page }) => {
      await open(page, viewport, scenario);
      const c = await chart(page);
      for (const { d, off, blocked } of offsets(c)) {
        if (off <= R + 1) continue;
        // Only a corner's name may push it further, and then it sits just clear of that name.
        expect(blocked, `${d.name} sits ${off.toFixed(1)} px off its values`).toBeTruthy();
        expect(apart(d.box, blocked!, 3 - 0.5), `${d.name} sits clear of the corner's name`).toBe(true);
        expect(off, `${d.name} sits just clear of the corner's name`).toBeLessThanOrEqual(2 * R + (blocked!.bottom - blocked!.top) + 6);
        const gap = Math.max(blocked!.left - d.box.right, d.box.left - blocked!.right, blocked!.top - d.box.bottom, d.box.top - blocked!.bottom);
        expect(gap, `${d.name} sits just clear of the corner's name`).toBeLessThanOrEqual(R / 2);
      }
    });

    test(`${where}: a count opens a sheet of its features by rank, and a row opens the feature panel`, async ({ page }) => {
      await open(page, viewport, scenario);
      const counts = page.getByTestId("vxe-crowd");
      const sizes = await counts.evaluateAll((es) => es.map((e) => Number((e as HTMLElement).dataset.count)));
      // The biggest count.
      const count = counts.nth(sizes.indexOf(Math.max(...sizes)));
      const n = Number(await count.getAttribute("data-count"));
      await count.click();
      const sheet = page.getByTestId("vxe-crowd-sheet");
      await expect(sheet).toBeVisible();
      const rows = sheet.getByTestId("vxe-crowd-row");
      await expect(rows).toHaveCount(n);
      await expect(sheet.getByRole("dialog")).toHaveAccessibleName(new RegExp(`^${n} features · (effort|PM-owned)`));
      const ranks = (await rows.allInnerTexts()).map((t) => Number(/^\s*(\d+)/.exec(t)![1]));
      expect(ranks, "by rank").toEqual([...ranks].sort((a, b) => a - b));
      // A row names its feature with its code; a tap opens its one feature panel.
      const row = rows.nth(1);
      const title = (await row.locator("span.truncate").innerText()).trim();
      await row.click();
      await expect(sheet).toHaveCount(0);
      const panel = page.getByTestId("item-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(title);
      // The count holds the selected feature, so it reads as selected.
      await expect(count).toHaveClass(/ring-accent/);
    });

    test(`${where}: a lone mark opens its feature panel`, async ({ page }) => {
      await open(page, viewport, scenario);
      const mark = page.getByTestId("vxe-point").first();
      const title = /^#\d+ (?:[A-Z]{1,3}-\d+[a-j]? · )?(.*)$/.exec((await mark.getByTestId("vxe-name").textContent()) ?? "")![1];
      await mark.click();
      const panel = page.getByTestId("item-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(title);
      await expect(mark).toHaveAttribute("aria-pressed", "true");
    });
  }
}

test("phone, the default company: the 13 features with no effort, goal value 0 are one count of 13, listed by rank", async ({ page }) => {
  await open(page, PHONE, null);
  // The features the mock does not list have no effort (as the API reads them): PM-owned.
  const count = page.locator('[data-testid="vxe-crowd"][data-count="13"]');
  await expect(count).toHaveAccessibleName("13 features at PM-owned, no effort · goal value 0 or no goal: F-110 Annual plan offer, F-104 Complaint early warning, F-109 Guided first week and 10 more; show them");
  await count.click();
  const sheet = page.getByTestId("vxe-crowd-sheet");
  await expect(sheet.getByRole("heading")).toHaveText("13 features · PM-owned, no effort · goal value 0 or no goal");
  // Every feature there has the same numbers, so the title says them and the rows do not.
  await expect(sheet.getByTestId("vxe-crowd-row").first()).toHaveText(/^\d+\s*F-110\s*Annual plan offer$/);
  // Escape closes the sheet; the chart is as it was.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(count).toBeFocused();
});

test("phone, the 40-feature dated plan: a count whose features differ gives their span, each row its own numbers", async ({ page }) => {
  await open(page, PHONE, "simple-plan");
  const spread = page.locator('[data-testid="vxe-crowd"][aria-label*="–"]').first();
  await spread.click();
  const rows = page.getByTestId("vxe-crowd-sheet").getByTestId("vxe-crowd-row");
  await expect(rows.first()).toBeVisible();
  for (const t of await rows.allInnerTexts()) expect(t.replace(/\s+/g, " ")).toMatch(/ ([\d.]+|–) · ([\d.]+ weeks?|PM-owned)$/);
});

test("the (i) says what a count is; nothing new shows on the page", async ({ page }) => {
  await open(page, PHONE, null);
  await expect(page.locator("#prio-about-text")).toContainText("Where marks would cover each other, one dark mark counts them; tap it for their list.");
  await expect(page.getByText("one dark mark counts them")).toBeHidden();
});

test("desktop: a mark moved onto another's spot with the arrow keys joins its count, which takes the focus", async ({ page }) => {
  await open(page, DESKTOP, null);
  // Setup checklist (goal value 4, 2 wk) down to Alert routing by team's spot (goal value 3, 2 wk).
  const sc = page.locator('[data-testid="vxe-point"][data-code="setup-checklist"]');
  await sc.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sc).toHaveAttribute("aria-label", /goal value 3\.5,/);
  await sc.focus();
  await page.keyboard.press("ArrowDown");
  await expect(sc).toHaveCount(0);
  const count = page.getByRole("button", { name: /^2 features at effort 2 weeks · goal value 3: / });
  await expect(count).toHaveAccessibleName("2 features at effort 2 weeks · goal value 3: Setup checklist, Alert routing by team; show them");
  await expect(count).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("vxe-crowd-sheet").getByTestId("vxe-crowd-row")).toHaveText([/Setup checklist/, /Alert routing by team/]);
});

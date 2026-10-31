import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's exports and span years (qa4-simple-roadmap-2, the export's
 * footer time, yearSpan's "this year"), driven as a person does against the mock's invented
 * data. The export's picture is read as the page draws it: the SVG it hands to the canvas
 * (the same picture the PNG and the PDF hold).
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };

declare global {
  interface Window {
    __exportSvgs?: string[];
  }
}

async function open(page: Page, opts: { scenario?: string; url?: string } = {}) {
  const { scenario = "", url = "/simple/roadmap" } = opts;
  await page.context().addInitScript(
    ([key, s, themeKey]) => {
      if (s) localStorage.setItem(key, s);
      localStorage.setItem(themeKey, "light");
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
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY] as const,
  );
  await page.emulateMedia({ colorScheme: "light" });
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-timeline").click();
  await expect(page.getByTestId("format-timeline")).toHaveAttribute("aria-pressed", "true");
}

/** Clicks Export PNG or PDF, waits for the file, and gives back the picture it was drawn from. */
async function exported(page: Page, kind: "PNG" | "PDF"): Promise<string> {
  const before = await page.evaluate(() => window.__exportSvgs?.length ?? 0);
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: `Export ${kind}` }).click()]);
  expect(file.suggestedFilename()).toBe(`roadmap-timeline.${kind.toLowerCase()}`);
  const all = await page.evaluate(() => window.__exportSvgs ?? []);
  // The export's picture is the last one drawn (the logo, if any, is read before it).
  expect(all.length).toBeGreaterThan(before);
  return all[all.length - 1];
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa4-2: every bar in the exported Timeline (PNG and PDF) carries its item name, in the bar, beside it or by a numbered key", async ({ page }) => {
    await open(page, { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await expect(page.locator('g[data-testid="bar"]').first()).toBeVisible();
    // On screen some pills are too short for their names (blank, or cut to "…").
    const short = await page.locator('g[data-testid="bar"][data-lane]').evaluateAll(
      (gs) =>
        gs.filter((g) => {
          const words = [...g.querySelectorAll('[data-testid="bar-label"], [data-testid="slice-label"]')].map((t) => (t.textContent ?? "").trim());
          return !words.some((w) => w && !w.endsWith("…"));
        }).length,
    );
    expect(short).toBeGreaterThan(0);

    for (const kind of ["PNG", "PDF"] as const) {
      const svg = await exported(page, kind);
      const result = await page.evaluate((markup) => {
        const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
        const months = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
        const keyText = (n: string) => doc.querySelector(`text[data-export-key="${n}"]`)?.textContent?.trim() ?? "";
        const bars = [...doc.querySelectorAll('g[data-testid="bar"][data-lane]')];
        const unnamed: string[] = [];
        let keyed = 0;
        for (const g of bars) {
          const said = g.getAttribute("aria-label") ?? "";
          const name = (new RegExp(`^(.*?): (?:${months}) \\d`).exec(said)?.[1] ?? said).trim();
          const words = [...g.querySelectorAll('[data-testid="bar-label"], [data-testid="slice-label"]')].map((t) => (t.textContent ?? "").trim());
          if (words.some((w) => w && !w.endsWith("…"))) continue;
          const n = g.querySelector("[data-export-key]")?.getAttribute("data-export-key");
          const key = n ? keyText(n) : "";
          const named = !!key && (key === name || (key.endsWith("…") && name.startsWith(key.slice(0, -1))));
          if (named) keyed++;
          else unnamed.push(name);
        }
        return { bars: bars.length, keyed, unnamed };
      }, svg);
      expect(result.bars).toBeGreaterThan(0);
      expect(result.unnamed, `${kind}: bars with no name in the file`).toEqual([]);
      expect(result.keyed).toBeGreaterThan(0);
    }
  });

  test("qa4 export footer: the file says the day and the time it was made, in the company's zone", async ({ page }) => {
    // 2:49 PM in Los Angeles (the mock company's zone) on Oct 30, 2026.
    await page.clock.setSystemTime(new Date("2026-10-30T21:49:00Z"));
    await open(page);
    await expect(page.locator('g[data-testid="bar"]').first()).toBeVisible();
    const svg = await exported(page, "PNG");
    const footer = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      return [...doc.querySelectorAll("svg > text")].map((t) => t.textContent ?? "").find((t) => /\d{4}/.test(t) && /[AP]M/.test(t)) ?? "";
    }, svg);
    expect(footer).toMatch(/^Oct 30, 2026, 2:(49|5\d) PM PDT( · Made with Product Oracle)?$/);
  });

  test("qa4 span years: a bar's spoken dates take this year from the company's day, not the browser's UTC year", async ({ page }) => {
    // 3 AM on Jan 1, 2027 in UTC is still Dec 31, 2026 in Los Angeles (the company's day).
    await page.clock.setSystemTime(new Date("2027-01-01T03:00:00Z"));
    await open(page);
    await expect(page.locator('g[data-testid="bar"]').first()).toBeVisible();
    const spans = await page.locator('g[data-testid="bar"][data-start][data-end]').evaluateAll((gs) =>
      gs.map((g) => ({ start: g.getAttribute("data-start") ?? "", end: g.getAttribute("data-end") ?? "", said: g.getAttribute("aria-label") ?? "" })),
    );
    // A span wholly in 2027 is not in the company's year (2026): it says 2027.
    const next = spans.filter((s) => s.start.startsWith("2027") && s.end.startsWith("2027"));
    expect(next.length).toBeGreaterThan(0);
    for (const s of next) expect(s.said, s.said).toMatch(/: [A-Z][a-z]{2} \d{1,2} to [A-Z][a-z]{2} \d{1,2}, 2027/);
    // A span wholly in 2026 is in the company's year: no year.
    for (const s of spans.filter((x) => x.start.startsWith("2026") && x.end.startsWith("2026"))) {
      expect(s.said, s.said).toMatch(/: [A-Z][a-z]{2} \d{1,2} to [A-Z][a-z]{2} \d{1,2}(?!\d|, \d{4})/);
    }
  });
});

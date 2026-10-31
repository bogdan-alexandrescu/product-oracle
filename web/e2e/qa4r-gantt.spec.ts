import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 4, the Simple roadmap's Gantt (qa4-simple-roadmap-24, -25, -34), driven as a person
 * does against the mock's invented data: the default scenario (Weekly alert digest's broken
 * link) and "simple-plan-lanes" (the plan's features cut into slices, "<name>, part i of n").
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

async function gantt(page: Page) {
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa4-24: a Gantt broken-link pill's whole sentence reads on hover and keyboard focus, inside the chart", async ({ page }) => {
    await open(page);
    await gantt(page);
    await page.getByTestId("unit-week").click();
    const callouts = page.getByTestId("broken-callout");
    await expect(callouts.first()).toBeVisible();
    const chart = (await page.getByTestId("simple-chart").boundingBox())!;
    for (const c of await callouts.all()) {
      const key = await c.getAttribute("data-item");
      const words = c.locator("span[title]").first();
      const sentence = (await words.getAttribute("title"))!;
      await expect(words).toHaveText(`⚠ ${sentence}`);
      // A person can reach the words with the keyboard.
      await expect(words).toHaveAttribute("tabindex", "0");
      await words.scrollIntoViewIfNeeded();
      await words.hover();
      await expect
        .poll(() => words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), { message: `${key}'s sentence is whole on hover` })
        .toBe(true);
      const box = (await c.boundingBox())!;
      expect(box.x, `${key}'s pill starts inside the chart`).toBeGreaterThanOrEqual(chart.x - 1);
      expect(box.x + box.width, `${key}'s pill ends inside the chart`).toBeLessThanOrEqual(chart.x + chart.width + 1);
      await page.mouse.move(0, 0);
      await words.focus();
      await expect
        .poll(() => words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), { message: `${key}'s sentence is whole on focus` })
        .toBe(true);
      await words.blur();
    }
  });

  test("qa4-25: a Gantt slice reads its whole name (in, or beside a short bar) or its part, never cut mid-word", async ({ page }) => {
    await open(page, { scenario: "simple-plan-lanes", url: "/simple/roadmap?roadmap=onboarding-roadmap" });
    await gantt(page);
    const labels = page.locator('g[data-testid="slice-bar"] [data-testid="slice-label"]');
    await expect(labels.first()).toBeAttached();
    const read = await page.locator('g[data-testid="slice-bar"]').evaluateAll((gs) =>
      gs.flatMap((g) => {
        const t = g.querySelector('[data-testid="slice-label"]');
        if (!t) return [];
        const name = (g.querySelector("title")?.textContent ?? "").split(" · ")[0];
        const body = g.querySelector("rect[data-slice-body]")!.getBoundingClientRect();
        const tb = t.getBoundingClientRect();
        return [{ code: g.getAttribute("data-code"), name, words: t.textContent ?? "", beside: t.getAttribute("data-beside") === "true", body: { left: body.left, right: body.right }, text: { left: tb.left, right: tb.right } }];
      }),
    );
    expect(read.length).toBeGreaterThan(3);
    for (const r of read) {
      const part = r.name.match(/,\s*(part \d+ of \d+)$/i)?.[1];
      const ok = [r.name, ...(part ? [part[0].toUpperCase() + part.slice(1)] : [])];
      expect(ok, `${r.code} reads "${r.words}", not a cut of "${r.name}"`).toContain(r.words);
      if (r.beside) expect(r.text.left, `${r.code}'s name sits beside its bar`).toBeGreaterThanOrEqual(r.body.right - 0.5);
      else expect(r.text.right, `${r.code}'s name fits in its bar`).toBeLessThanOrEqual(r.body.right + 0.5);
    }
    // The finding's own bars: Self-serve checkout's and Referral link's first parts.
    for (const code of ["F-11a", "F-12a"]) {
      const words = (await page.locator(`g[data-testid="slice-bar"][data-code="${code}"] [data-testid="slice-label"]`).textContent()) ?? "";
      expect(words).not.toContain("…");
    }
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa4-34: the phone's Gantt names its red line with a Today pill", async ({ page }) => {
    await open(page);
    await gantt(page);
    const chart = page.getByTestId("simple-chart");
    const pill = chart.getByTestId("today-pill");
    await expect(pill).toHaveText("Today");
    const p = (await pill.locator("rect").boundingBox())!;
    const line = (await chart.getByTestId("today-line").boundingBox())!;
    // The pill sits at the line, above where the line runs down the rows.
    expect(Math.abs(p.x - line.x) < 4 || Math.abs(p.x + p.width - line.x) < 4, "the pill touches its line").toBe(true);
    expect(p.y + p.height).toBeLessThanOrEqual(line.y + line.height);
    // It touches no milestone end's words.
    for (const m of await chart.getByTestId("milestone-end-label").all()) {
      const b = await m.boundingBox();
      if (!b) continue;
      const touch = p.x < b.x + b.width - 0.5 && b.x < p.x + p.width - 0.5 && p.y < b.y + b.height - 0.5 && b.y < p.y + p.height - 0.5;
      expect(touch, "the Today pill sits clear of a milestone's words").toBe(false);
    }
  });
});

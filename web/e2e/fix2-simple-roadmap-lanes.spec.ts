import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix2, the goal lanes (B2/B3): QA findings written against the old one-row-per-item
 * Timeline, re-checked against the lanes that replaced it (_lanes.tsx). Each test's
 * comment names the finding it protects.
 */

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const phoneLane = (page: Page, title: string): Locator => page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: new RegExp(`^${title}$`) }) });

/** The "simple-plan-lanes" scenario (every piece planned, nothing broken or waiting). */
async function openLanes(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-plan-lanes", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
}

/** The default scenario (alert-rules -> alert-digest red; setup-checklist -> setup-import amber): the only one of the two with broken/accepted-risk links to draw an arrow against. */
async function openDefault(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([themeKey, theme]) => localStorage.setItem(themeKey, theme),
    [THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  /** Finding 11: a short run of work is a blob a few px wide at a coarse scale; every slice pill keeps a minimum readable width. */
  test("B2: no slice pill is drawn narrower than its minimum width", async ({ page }) => {
    await openLanes(page, "light");
    const slices = page.locator('g[data-testid="slice-bar"] rect[data-slice-body]');
    const n = await slices.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const box = (await slices.nth(i).boundingBox())!;
      expect(box.width, `slice ${i} too narrow to read`).toBeGreaterThanOrEqual(26);
    }
  });

  /** Finding 17: look()'s "dated" and "estimated" border used --line-strong on --na-bg (≈3:1 in dark mode); it now reads with --text2. */
  test("B2: a plain pill's border is the higher-contrast token in dark mode", async ({ page }) => {
    await openDefault(page, "dark");
    await expect(bar(page, "alert-mobile")).toBeVisible();
    await expect(page.locator('g[data-testid="bar"] rect[data-body][stroke="var(--line-strong)"]')).toHaveCount(0);
    expect(await page.locator('g[data-testid="bar"] rect[data-body][stroke="var(--text2)"]').count()).toBeGreaterThan(0);
  });

  /** Finding 14: a pill's aria-label reads a plain word (sourceWord), not the API's raw "typed". */
  test("B2: a pill's aria-label reads sourceWord's words, not the raw source", async ({ page }) => {
    await openLanes(page, "light");
    const label = await bar(page, "setup-checklist").getAttribute("aria-label");
    expect(label).toContain("Dates set by you");
    expect(label).not.toMatch(/,\s*typed(?!\w)/);
  });

  /** Finding 40: the dependency arrow used to land its head on the dependent bar's left edge (overlapping the pill), and was never named in the legend. */
  test("B2: a dependency arrow sits beside the bar, and the legend names it", async ({ page }) => {
    await openDefault(page, "light");
    const arrow = page.locator('[data-testid="dep-arrow"][data-from="setup-checklist"][data-to="setup-import"]');
    await expect(arrow).toHaveAttribute("data-state", "amber");
    // The arrow's path ends (its head) beside the bar's left edge, not on it (screen pixels).
    const endX = await arrow.evaluate((el) => {
      const p = (el.tagName === "path" ? el : el.querySelector("path")) as SVGPathElement;
      const pt = p.getPointAtLength(p.getTotalLength());
      const m = p.getScreenCTM()!;
      return pt.x * m.a + pt.y * m.c + m.e;
    });
    const barX = (await bar(page, "setup-import").locator("rect[data-body]").boundingBox())!.x;
    expect(endX).toBeLessThan(barX);
    const legend = page.getByTestId("simple-chart").getByTestId("legend");
    await expect(legend.getByTestId("legend-item").filter({ hasText: "Dependency order accepted as a risk" })).toHaveCount(1);
  });

  /** Finding 21: a lone "?" and its dashed outline said nothing on hover; now both carry a title. */
  test("B2: Oracle's suggestion says what it is on hover", async ({ page }) => {
    await openDefault(page, "light");
    const outline = page.locator('[data-testid="suggestion-outline"][data-item="alert-sso"]');
    await expect(outline.locator("title")).toHaveText(/Oracle suggests dates/);
    const open = page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]');
    await expect(open.locator("title")).toHaveText("Oracle suggests dates");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  /** Finding 18: B3's today-line started inside the month row (y1=20), drawing straight through the month label's text. */
  test("B3: the today line starts below the month row, not through its text", async ({ page }) => {
    await openLanes(page, "light");
    const y1 = Number(await page.getByTestId("today-line").getAttribute("y1"));
    expect(y1).toBeGreaterThanOrEqual(44);
  });

  /** Finding 6: a lane's name carries a title (its full name) for a hover/long-press, even once drawn at phone width. */
  test("B3: a lane's name has its own title for the full text", async ({ page }) => {
    await openLanes(page, "light");
    const fa = phoneLane(page, "Faster activation");
    await expect(fa.locator("title")).toHaveText("Faster activation");
  });
});

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix2, the goal lanes (B2/B3): QA findings first written against the goal lanes. The new
 * Timeline (_zoom.tsx) draws no pills, arrows or suggestion marks, so the findings that still
 * hold are checked on the Gantt, which draws them. Each test's comment names its finding.
 */

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

async function gantt(page: Page) {
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
}

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
  await gantt(page);
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
  await gantt(page);
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  /** Finding 14: a bar's aria-label reads a plain word (sourceWord), not the API's raw "typed". */
  test("B2: a Gantt bar's aria-label reads sourceWord's words, not the raw source", async ({ page }) => {
    await openLanes(page, "light");
    const label = await bar(page, "setup-checklist").getAttribute("aria-label");
    expect(label).toContain("Dates set by you");
    expect(label).not.toMatch(/,\s*typed(?!\w)/);
  });

  /** Finding 40: the dependency arrow used to land its head on the dependent bar's left edge (overlapping the bar). */
  test("B2: a Gantt dependency arrow ends beside the bar, not on it", async ({ page }) => {
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
  });

  /** Finding 21: a lone "?" said nothing on hover; now it carries a title. */
  test("B2: Oracle's suggestion on the Gantt says what it is on hover", async ({ page }) => {
    await openDefault(page, "light");
    await expect(page.locator('[data-testid="suggestion-outline"][data-item="alert-sso"]')).toBeAttached();
    const open = page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]');
    await expect(open.locator("title")).toHaveText(/^Oracle suggests dates/);
  });
});

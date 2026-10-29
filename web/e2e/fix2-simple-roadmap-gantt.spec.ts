import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix2-simple-roadmap-gantt: the Gantt and Waterfall charts' QA findings (reported first on
 * the old Timeline, now _lanes.tsx; these fixes are in _timeline.tsx, which draws the Gantt
 * and the Waterfall): a phone row always shows its name with its chips shrinking instead
 * (findings 6, 7); a bar never draws thinner than 24px (finding 11); a row's code sits in its
 * tooltip, never as a visible, possibly-repeated prefix (findings 15, 16); an undated bar's
 * outline keeps contrast in dark mode (finding 17); the axis's marks pack in date order and
 * Today's line never crosses a label (finding 18); the right-most axis labels stay inside the
 * chart (finding 19); a suggestion marker says what it is (finding 21); a phone Waterfall's
 * quarter header keeps its year (finding 28); the dependency arrow sits beside a bar, not over
 * its edge (finding 40); a suggestion's outline clamps to the chart's width (finding 49); the
 * Gantt opens scrolled to the plan's dated work, not a blank window (finding 8/38).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

async function open(page: Page, scenario: string, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

const row = (page: Page, title: string): Locator => page.getByTestId("chart-label").filter({ has: page.getByTestId("label-title").getByText(title, { exact: true }) });
const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);
const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

test.describe("desktop", () => {
  test.use(DESKTOP);

  for (const format of ["gantt", "waterfall"] as const) {
    test(`${format}: a row shows its own code first, never a repeated one (findings 15, 16)`, async ({ page }) => {
      await open(page, "simple-plan");
      await page.getByTestId(`format-${format}`).click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
      // fix2 review: design D's "F-05 Team invites", the code first, when it is the row's alone.
      await expect(row(page, "Team invites").getByTestId("label-code")).toHaveText("F-05");
      await expect(row(page, "Team invites").getByTestId("label-title")).toHaveAttribute("title", "F-05 Team invites");
      // A code two rows share (two PRDs' F-06) is never drawn: it would read as one item twice.
      const codes = await page.getByTestId("label-code").allTextContents();
      expect(new Set(codes).size).toBe(codes.length);
    });
  }

  test("gantt: the axis's right-most tick stays inside the chart (finding 19)", async ({ page }) => {
    await open(page, "default");
    await page.getByTestId("format-gantt").click();
    const chart = (await page.getByTestId("chart-svg").boundingBox())!;
    const ticks = await page.getByTestId("axis-tick").all();
    for (const t of ticks.slice(-3)) {
      const box = (await t.boundingBox())!;
      expect(box.x + box.width, "a tick's label stays left of the chart's right edge").toBeLessThanOrEqual(chart.x + chart.width + 1);
    }
  });

  for (const format of ["gantt", "waterfall"] as const) {
    test(`${format}: Today's line never runs through the axis's own labels (finding 18)`, async ({ page }) => {
      await open(page, "default");
      await page.getByTestId(`format-${format}`).click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", format);
      const axisBottom = await page.getByTestId("axis-tick").evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().bottom)));
      const lineTop = (await page.getByTestId("today-line").boundingBox())!.y;
      expect(lineTop, "the red line starts at or below the axis tick row").toBeGreaterThanOrEqual(axisBottom - 1);
    });
  }

  test("gantt: a dependency's arrow sits beside the bar it points to, not over its edge (finding 40)", async ({ page }) => {
    await open(page, "default");
    await page.getByTestId("format-gantt").click();
    const arrow = page.locator('[data-testid="dep-arrow"][data-from="setup-checklist"][data-to="setup-import"]');
    await expect(arrow).toBeVisible();
    // The arrow's path ends (its head) beside the bar's left edge, not on it.
    const d = (await arrow.evaluate((el) => (el.tagName === "path" ? el : el.querySelector("path"))?.getAttribute("d") ?? ""));
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const endX = nums[nums.length - 2];
    const barX = Number(await bar(page, "setup-import").locator("rect[data-body]").getAttribute("x"));
    expect(endX, "the arrow's head stops before the bar's left edge").toBeLessThan(barX);
  });

  for (const format of ["gantt", "waterfall"] as const) {
    test(`${format}: Oracle's date-suggestion marker says what it is, and its outline never runs past the chart (findings 21, 49)`, async ({ page }) => {
      await open(page, "default");
      await page.getByTestId(`format-${format}`).click();
      const open_ = page.locator('[data-testid="suggestion-open"][data-item="alert-sso"]');
      await expect(open_).toBeVisible();
      await expect(open_).toHaveAccessibleName(/Oracle suggests dates for/);
      const chart = (await page.getByTestId("chart-svg").boundingBox())!;
      const outlines = page.locator('[data-testid="suggestion-outline"]');
      const n = await outlines.count();
      for (let i = 0; i < n; i++) {
        const box = (await outlines.nth(i).boundingBox())!;
        expect(box.x + box.width, "a suggestion's dashed outline stays inside the chart's width").toBeLessThanOrEqual(chart.x + chart.width + 1);
      }
    });
  }

  test("gantt: opens scrolled to the plan's dated work, not a window with no bars in it (finding 8/38)", async ({ page }) => {
    await open(page, "simple-plan");
    await page.getByTestId("format-gantt").click();
    const scroller = page.getByTestId("chart-scroll");
    const sv = (await scroller.boundingBox())!;
    const a = (await slice(page, "F-05a").boundingBox())!;
    expect(a.x, "the current milestone's work is in view without scrolling first").toBeGreaterThanOrEqual(sv.x - 1);
    expect(a.x).toBeLessThan(sv.x + sv.width);
  });

  test("dark: an undated bar's outline keeps contrast, like a dated bar's (finding 17)", async ({ page }) => {
    await open(page, "simple-plan", "dark");
    await page.getByTestId("format-gantt").click();
    await expect(bar(page, "setup-ideas")).toBeVisible();
    // No bar body is outlined in the dark accent any more; undated ones use the line token.
    await expect(page.locator('g[data-testid="bar"] rect[data-body][stroke="var(--accent)"]')).toHaveCount(0);
    expect(await page.locator('g[data-testid="bar"] rect[data-body][stroke="var(--line-strong)"]').count()).toBeGreaterThan(0);
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("gantt: every row shows its name; its chips shrink instead of hiding it (findings 6, 7)", async ({ page }) => {
    await open(page, "simple-plan");
    await page.getByTestId("format-gantt").click();
    const nudges = row(page, "Team invite nudges");
    await expect(nudges).toBeVisible();
    const name = nudges.getByTestId("label-title");
    await expect(name).toHaveText("Team invite nudges");
    const nameBox = (await name.boundingBox())!;
    expect(nameBox.width, "the row's name keeps a real, readable width").toBeGreaterThan(30);
    await expect(nudges.getByTestId("draft-tag")).toBeVisible();
    await expect(nudges.getByTestId("pending-tag")).toHaveText("Pending decision");

    // finding 6: the goal's metric line fits inside its own row, not spilling into the next one.
    const activation = page.getByTestId("chart-group").filter({ hasText: "Faster activation" });
    const groupBox = (await activation.boundingBox())!;
    const metricBox = (await activation.getByTestId("group-metric").boundingBox())!;
    expect(metricBox.y + metricBox.height, "the subtitle's bottom stays inside its row").toBeLessThanOrEqual(groupBox.y + groupBox.height + 1);
  });

  test("waterfall: a bar never draws narrower than 24px, even at a zoomed-out scale (finding 11)", async ({ page }) => {
    await open(page, "default");
    await page.getByTestId("format-waterfall").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "waterfall");
    const bodies = page.locator('rect[data-body]');
    const n = await bodies.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const box = (await bodies.nth(i).boundingBox())!;
      expect(box.width, "a bar's narrowest visible width").toBeGreaterThanOrEqual(23);
    }
  });

  test("waterfall: a quarter header keeps its year even when it is squeezed (finding 28)", async ({ page }) => {
    await open(page, "default");
    await page.getByTestId("format-waterfall").click();
    const ticks = await page.getByTestId("axis-tick").allTextContents();
    const quarters = ticks.filter((t) => /^Q[1-4]/.test(t));
    expect(quarters.length, "the chart has quarter headers").toBeGreaterThan(0);
    // None reads as a bare "Q4" with no year; a squeezed one abbreviates the year instead of dropping it.
    for (const t of quarters) expect(t, `"${t}" names its year`).toMatch(/^Q[1-4]( \d{4}| '\d{2})$/);
    expect(quarters.some((t) => /'\d{2}$/.test(t)), "at least one header is squeezed and keeps an abbreviated year").toBe(true);
  });
});

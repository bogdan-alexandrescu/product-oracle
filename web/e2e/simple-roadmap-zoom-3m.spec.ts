import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * The owner (Nov 4): "on the roadmap we also need to see the next 3 months not just the next
 * 6. add a button for that". The Timeline's Show control leads with 3 months: the next three
 * months from today, weeks marked; 6 months stays the default. Driven against the mock's
 * invented data, with the mock clock pinned at Oct 22, 2026.
 *
 * The review's follow-ups (Nov 5): a week mark reads without a hover (each month's first one
 * names its month: "Nov 9", then "16"), a month that starts on a Monday draws only its month
 * line, a milestone's label stays clear of the names column when the chart is scrolled, in
 * light and dark; a phone keeps the list by quarter and has no Show control.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scheme: "light" | "dark" = "light") {
  await page.context().addInitScript(
    ([key, themeKey, theme]) => {
      localStorage.setItem(key, "");
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("zoom-timeline")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
}

/** The week marks whose left edge sits inside the chart's view, in order, as they read. */
async function weeksInView(page: Page) {
  const head = (await page.getByTestId("timeline-names-head").boundingBox())!;
  const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
  const out: string[] = [];
  for (const w of await page.getByTestId("timeline-week").all()) {
    const b = await w.boundingBox();
    if (b && b.x >= head.x + head.width - 1 && b.x < view.x + view.width) out.push((await w.innerText()).trim());
  }
  return out;
}

/** Slides the chart sideways with the mouse wheel, as a person would, by about `dx` pixels. */
async function slide(page: Page, dx: number) {
  const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, view.y + 200);
  const sl = () => page.getByTestId("timeline-scroll").evaluate((el) => el.scrollLeft);
  const from = await sl();
  await page.mouse.wheel(dx, 0);
  await expect.poll(sl).not.toBe(from);
  return (await sl()) - from;
}

/** Each check, in light and in dark, at 1440 wide. */
function readsWhole(scheme: "light" | "dark") {
  test(`${scheme}: at 3 months each month's first week mark names its month, and no mark touches a month`, async ({ page }) => {
    await open(page, scheme);
    await page.getByTestId("zoom-3m").click();
    // Today is Oct 22: the marks run Oct 26, then Nov 9 (Nov 2 gives way to "Nov"), 16, 23, then
    // Dec 7 (Nov 30 gives way to "Dec")...
    await expect.poll(() => weeksInView(page)).toEqual(expect.arrayContaining(["Oct 26", "Nov 9", "16", "23", "Dec 7", "14"]));
    const words = await weeksInView(page);
    // A bare day only ever follows its month's named mark.
    expect(words[0]).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    const boxes = async (id: string) => (await Promise.all((await page.getByTestId(id).all()).map((l) => l.boundingBox()))).filter((b) => b !== null);
    const months = await boxes("timeline-month");
    for (const w of await boxes("timeline-week"))
      for (const m of months) expect(w.x + w.width <= m.x - 2 || m.x + m.width <= w.x - 2, "a week mark touches a month's name").toBe(true);
  });

  test(`${scheme}: a month that starts on a Monday draws only its month line`, async ({ page }) => {
    await open(page, scheme);
    await page.getByTestId("zoom-3m").click();
    // Feb 1 and Mar 1, 2027 are Mondays: slide the chart along to them.
    const feb = page.getByTestId("timeline-month").filter({ hasText: /^Feb$/ }).first();
    const right = async () => {
      const v = (await page.getByTestId("timeline-scroll").boundingBox())!;
      return v.x + v.width;
    };
    for (let n = 0; n < 12 && (await feb.boundingBox())!.x > (await right()) - 200; n++) await slide(page, 400);
    await expect(feb).toBeInViewport();
    for (const day of ["2027-02-01", "2027-03-01"]) {
      await expect(page.locator(`[data-testid="timeline-month-line"][data-day="${day}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-testid="timeline-week-line"][data-day="${day}"]`)).toHaveCount(0);
    }
    // The other Mondays keep their week line.
    await expect(page.locator('[data-testid="timeline-week-line"][data-day="2027-02-08"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="timeline-week-line"][data-day="2027-03-08"]')).toHaveCount(1);
  });

  test(`${scheme}: a milestone's label stays clear of the names column at every zoom`, async ({ page }) => {
    await open(page, scheme);
    const head = page.getByTestId("timeline-names-head");
    const label = page.getByTestId("timeline-milestone").filter({ hasText: "Beta · Nov 30" });
    // The label reads whole: all of it between the names column and the chart's right edge.
    const clear = async () => {
      const h = (await head.boundingBox())!;
      const v = (await page.getByTestId("timeline-scroll").boundingBox())!;
      const b = (await label.boundingBox())!;
      expect(b.x, "the label starts right of the names column").toBeGreaterThanOrEqual(h.x + h.width);
      expect(b.x + b.width).toBeLessThanOrEqual(v.x + v.width);
      await expect(label).toHaveText("◆ Beta · Nov 30");
    };
    for (const z of ["3m", "6m", "1y", "all"]) {
      await page.getByTestId(`zoom-${z}`).click();
      await expect(label).toBeVisible();
      await clear();
      if (z === "all") continue;
      // Slide the chart until the milestone's line sits just left of the names column.
      const h = (await head.boundingBox())!;
      const line = (await label.boundingBox())!.x - 4;
      const moved = await slide(page, line - (h.x + h.width) + 20);
      expect(line - moved).toBeLessThan(h.x + h.width);
      await expect(label).toBeVisible();
      await clear();
    }
  });
}

test.describe("desktop, light", () => {
  test.use(DESKTOP);
  readsWhole("light");
});

test.describe("desktop, dark", () => {
  test.use(DESKTOP);
  readsWhole("dark");

  test("dark: 3 months shows Oct to Jan with weeks marked", async ({ page }) => {
    await open(page, "dark");
    await page.getByRole("button", { name: "3 months", exact: true }).click();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => monthsInView(page)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027"]);
    await expect(page.getByTestId("timeline-week").first()).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  for (const scheme of ["light", "dark"] as const)
    test(`${scheme}: a phone keeps the list by quarter, with no Show control`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("timeline-quarter").first()).toBeVisible();
      await expect(page.getByRole("group", { name: "Show" })).toHaveCount(0);
      await expect(page.getByTestId("zoom-3m")).toHaveCount(0);
      await expect(page.getByTestId("timeline-scroll")).toHaveCount(0);
    });
});

/** The month labels whose left edge sits inside the chart's view, in order. */
async function monthsInView(page: Page) {
  const scroll = page.getByTestId("timeline-scroll");
  const head = (await page.getByTestId("timeline-names-head").boundingBox())!;
  const view = (await scroll.boundingBox())!;
  const out: string[] = [];
  for (const m of await page.getByTestId("timeline-month").all()) {
    const b = await m.boundingBox();
    if (b && b.x >= head.x + head.width - 1 && b.x < view.x + view.width) out.push((await m.innerText()).trim());
  }
  return out;
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("3 months leads the Show buttons, 6 months stays the default", async ({ page }) => {
    await open(page);
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button")).toHaveText(["3 months", "6 months", "1 year", "All 3 years"]);
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "false");
  });

  test("3 months shows Oct to Jan with weeks marked, and an item starting soon in sight", async ({ page }) => {
    await open(page);
    // 6 months reaches well past January.
    await expect.poll(() => monthsInView(page)).toContain("Mar");

    await page.getByRole("button", { name: "3 months", exact: true }).click();
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "false");
    // About three months from today: from October to January (each year shown once), no further.
    await expect.poll(() => monthsInView(page)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027"]);

    // Weeks are marked, each one wide enough to read.
    const weeks = page.getByTestId("timeline-week");
    await expect(weeks.first()).toBeAttached();
    const a = (await weeks.nth(0).boundingBox())!;
    const b = (await weeks.nth(1).boundingBox())!;
    expect(b.x - a.x).toBeGreaterThan(60);

    // Today is in sight, and so is an item that starts within the next three months.
    const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
    const today = (await page.getByTestId("today-line").boundingBox())!;
    expect(today.x).toBeGreaterThan(view.x);
    expect(today.x).toBeLessThan(view.x + view.width);
    const bar = page.locator('[data-testid="timeline-row"][data-item="alert-digest"]').getByTestId("timeline-bar");
    await expect(bar).toBeInViewport();
    const bb = (await bar.boundingBox())!;
    expect(bb.x).toBeGreaterThan(today.x);
    expect(bb.x).toBeLessThan(view.x + view.width);
    await expect(page.getByRole("button", { name: "Back to today" })).toBeVisible();
  });

  test("switching through all four keeps the pick and brings today back in sight", async ({ page }) => {
    await open(page);
    const scroll = page.getByTestId("timeline-scroll");
    for (const z of ["3m", "6m", "1y", "all", "3m"]) {
      await page.getByTestId(`zoom-${z}`).click();
      for (const o of ["3m", "6m", "1y", "all"])
        await expect(page.getByTestId(`zoom-${o}`)).toHaveAttribute("aria-pressed", String(o === z));
      const view = (await scroll.boundingBox())!;
      const today = (await page.getByTestId("today-line").boundingBox())!;
      expect(today.x).toBeGreaterThan(view.x);
      expect(today.x).toBeLessThan(view.x + view.width);
    }
    // Weeks are marked only at 3 months.
    await page.getByTestId("zoom-6m").click();
    await expect(page.getByTestId("timeline-week")).toHaveCount(0);
  });
});

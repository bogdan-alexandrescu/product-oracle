import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The owner (Nov 4): "on the roadmap we also need to see the next 3 months not just the next
 * 6. add a button for that". The Timeline's Show control leads with 3 months: the next three
 * months from today, weeks marked; 6 months stayed the default till the owner's Nov 9 pick of 3 months. Driven against the mock's
 * invented data, with the mock clock pinned at Oct 22, 2026.
 *
 * The review's follow-ups (Nov 5): a week mark reads without a hover (each month's first one
 * names its month: "Nov 9", then "16"), a month that starts on a Monday draws only its month
 * line, a milestone's label stays clear of the names column when the chart is scrolled, in
 * light and dark; a phone keeps the list by quarter and has no Show control.
 *
 * The next review (Nov 5): two milestones two weeks apart (the "approved-roadmap" scenario's
 * invented "Trail beta · Jan 15" and "Trail launch · Jan 29") never draw one label over the other,
 * scrolled or not, at every zoom: the earlier one gives way. No label, no "+ Milestone" hint and no
 * milestone line sits over the names column, and the hint stays inside the chart.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scheme: "light" | "dark" = "light", scenario = "") {
  const trails = scenario === "approved-roadmap";
  await page.context().addInitScript(
    ([key, themeKey, theme, value]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, scheme, scenario] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  if (trails) {
    // Approving the roadmap Example trails' version 3 in Detailed puts its milestones on Simple.
    await page.goto("/documents/example-trails/v/3");
    await page.getByTestId("approve-version").filter({ visible: true }).click();
    await page.getByRole("group", { name: "Confirm approval" }).filter({ visible: true }).getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(/✓ Approved Oct 22, 2026/).filter({ visible: true }).first()).toBeVisible();
  }
  await page.goto(trails ? "/simple/roadmap?roadmap=example-trails" : "/simple/roadmap");
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
  // The chart's top on screen, the pointer over a part of it in sight: the Goal map's goals add
  // counters above the chart since P-1 (P-6), so its top can sit low on the page.
  await page.getByTestId("timeline-names-head").scrollIntoViewIfNeeded();
  const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
  await page.mouse.move(view.x + view.width / 2, Math.min(view.y + 200, page.viewportSize()!.height - 20));
  const sl = () => page.getByTestId("timeline-scroll").evaluate((el) => el.scrollLeft);
  const from = await sl();
  await page.mouse.wheel(dx, 0);
  await expect.poll(sl).not.toBe(from);
  return (await sl()) - from;
}

/** Each check, in light and in dark, at 1440 wide. */
function readsWhole(scheme: "light" | "dark") {
  test(`${scheme}: at 3 months each month's first week mark names its month, and no mark touches a month`, async ({ page }) => {
    // protects: with today at Oct 22, 2026 and 3 months picked, the week marks in view include Oct 26, Nov 9, 16, 23, Dec 7 and 14, the first reads month and day, and no week mark comes within 2 px of a month name
    // fails_when: a mark is missing or reads differently, the first is a bare day, or a week mark touches a month's name
    // no_claim: marks beyond the six listed; other zoom levels; this runs in light and dark at 1440 wide
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
    // protects: at 3 months, after sliding to February, Feb 1 and Mar 1, 2027 (both Mondays) each have a month line and no week line, while Feb 8 and Mar 8 keep their week line
    // fails_when: a Monday that starts a month also draws a week line or no month line, or another Monday loses its week line
    // no_claim: other months or zoom levels; how the lines look; this runs in light and dark
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
    // protects: the "◆ M1 Beta · Nov 30" label, at 3 months, 6 months, 1 year and All, and after sliding the chart till its line is left of the names column, starts at or right of the names column, ends inside the chart, reads whole, and is not covered by the + Milestone hint
    // fails_when: the label sits over the names column, runs past the chart's right edge, reads differently, or the hint covers it
    // no_claim: other milestones or two close ones (the next test); this runs in light and dark at 1440 wide
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
      // roadmap-milestone-codes: its roadmap code first (M6, after the 17 seeded date-suggestion
      // items shifted the company's milestone order).
      await expect(label).toHaveText("◆ M6 Beta · Nov 30");
      // The "+ Milestone" hint on the axis keeps off it.
      const hint = page.getByTestId("ms-add-hint");
      if (await hint.isVisible()) {
        const k = (await hint.boundingBox())!;
        expect(k.x + k.width <= b.x || b.x + b.width <= k.x, "the + Milestone hint covers the label").toBe(true);
      }
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

/** The approved-roadmap scenario's milestones, at every zoom, scrolled and not. */
function milestonesApart(scheme: "light" | "dark") {
  test(`${scheme}: two milestones two weeks apart never overlap, and keep off the names column`, async ({ page }) => {
    // protects: after Example trails is approved, its Trail beta and Trail launch milestones, at every zoom unscrolled and slid along, have no label over the names column or over another label, no milestone line inside the names column, and the + Milestone hint stays inside the chart and off every label
    // fails_when: a label is over the names column, two labels overlap, a line shows in the names column, or the hint runs past the chart or covers a label
    // no_claim: that labels fold into +N chips (not checked here); the slide steps are capped, so not every scroll position is tried
    await open(page, scheme, "approved-roadmap");
    await expect(page.getByTestId("timeline-milestone").filter({ hasText: "Trail launch · Jan 29" })).toBeVisible();
    const box = async (l: Locator) => (await l.isVisible()) ? await l.boundingBox() : null;
    const check = async (where: string) => {
      const h = (await page.getByTestId("timeline-names-head").boundingBox())!;
      const v = (await page.getByTestId("timeline-scroll").boundingBox())!;
      const edge = h.x + h.width;
      const labels = (await Promise.all((await page.getByTestId("timeline-milestone").all()).map(box))).filter((b) => b !== null);
      for (const [n, a] of labels.entries()) {
        expect(a.x, `${where}: a milestone's label is over the names column`).toBeGreaterThanOrEqual(edge);
        for (const b of labels.slice(n + 1))
          expect(a.x + a.width <= b.x || b.x + b.width <= a.x, `${where}: two milestone labels overlap`).toBe(true);
      }
      const hint = await box(page.getByTestId("ms-add-hint"));
      if (hint) {
        expect(hint.x, `${where}: the + Milestone hint is over the names column`).toBeGreaterThanOrEqual(edge);
        expect(hint.x + hint.width, `${where}: the + Milestone hint runs past the chart`).toBeLessThanOrEqual(v.x + v.width);
        for (const a of labels) expect(hint.x + hint.width <= a.x || a.x + a.width <= hint.x, `${where}: the + Milestone hint covers a label`).toBe(true);
      }
      for (const l of await page.getByTestId("timeline-milestone-line").all()) {
        const b = await l.boundingBox();
        if (b) expect(b.x, `${where}: a milestone's line shows inside the names column`).toBeGreaterThanOrEqual(edge - 1);
      }
    };
    // How far to slide, a step at a time, till both lines are well behind the names column.
    const steps: Record<string, number> = { "3m": 13, "6m": 7, "1y": 4 };
    for (const z of ["3m", "6m", "1y", "all"]) {
      await page.getByTestId(`zoom-${z}`).click();
      await expect(page.getByTestId(`zoom-${z}`)).toHaveAttribute("aria-pressed", "true");
      await check(`${z}, unscrolled`);
      const atEnd = () => page.getByTestId("timeline-scroll").evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
      for (let n = 0; n < (steps[z] ?? 0) && !(await atEnd()); n++) {
        await slide(page, 120);
        await check(`${z}, slid ${n + 1}`);
      }
    }
  });
}

test.describe("desktop, light", () => {
  test.use(DESKTOP);
  readsWhole("light");
  milestonesApart("light");
});

test.describe("desktop, dark", () => {
  test.use(DESKTOP);
  readsWhole("dark");
  milestonesApart("dark");

  test("dark: 3 months shows Oct to Jan with weeks marked", async ({ page }) => {
    // protects: in the dark theme at 1440 wide, picking 3 months presses its button, the months in view read Oct 2026, Nov, Dec, Jan 2027, and week marks show
    // fails_when: the button is not pressed, the months in view differ, or no week mark shows
    // no_claim: colours or contrast; other zoom levels
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
      // protects: at 390 px wide, in light and dark, the Roadmap shows the list by quarter and has no Show group, no 3 months button and no sideways chart
      // fails_when: no quarter shows, or the Show group, the 3 months button or the chart scroll area appears on a phone
      // no_claim: what the quarters list; tapping anything
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

  test("3 months leads the Show buttons and is the default", async ({ page }) => {
    // protects: on a fresh load at 1440 wide the Show buttons read 3 months, 6 months, 1 year, All 3 years in that order, with 3 months pressed and 6 months not
    // fails_when: the order or names differ, 3 months is not first, or 6 months is the pressed one
    // no_claim: what the chart shows for the default; a saved pick from an earlier visit
    await open(page);
    const show = page.getByRole("group", { name: "Show" });
    await expect(show.getByRole("button")).toHaveText(["3 months", "6 months", "1 year", "All 3 years"]);
    await expect(page.getByTestId("zoom-3m")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("zoom-6m")).toHaveAttribute("aria-pressed", "false");
  });

  test("3 months shows Oct to Jan with weeks marked, and an item starting soon in sight", async ({ page }) => {
    // protects: 6 months reaches March; 3 months shows Oct 2026, Nov, Dec, Jan 2027, week marks over 60 px apart, today in view, and the Weekly alert digest bar in view right of today with a "Back to today" button; page scroll does not move the chart sideways
    // fails_when: 6 months stops short of March, the months differ, week marks are crowded, today or the bar is out of view or left of today, or the page scroll moves the chart sideways
    // no_claim: the exact bar length; dark and phone (other tests)
    await open(page);
    await page.getByTestId("zoom-6m").click();
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
    // Its row is below the fold (the Goal map's goals lead the lanes since P-1, P-6): the person
    // scrolls the page down with the wheel over the page's header, the chart left where it is sideways.
    const sl = await page.getByTestId("timeline-scroll").evaluate((el) => el.scrollLeft);
    const rowTop = (await bar.boundingBox())!.y;
    const fold = page.viewportSize()!.height;
    if (rowTop > fold - 60) {
      await page.mouse.move(view.x + view.width / 2, 40);
      await page.mouse.wheel(0, rowTop - fold / 2);
      await expect.poll(async () => (await bar.boundingBox())!.y).toBeLessThan(fold - 60);
    }
    expect(await page.getByTestId("timeline-scroll").evaluate((el) => el.scrollLeft)).toBe(sl);
    await expect(bar).toBeInViewport();
    const bb = (await bar.boundingBox())!;
    expect(bb.x).toBeGreaterThan(today.x);
    expect(bb.x).toBeLessThan(view.x + view.width);
    await expect(page.getByRole("button", { name: "Back to today" })).toBeVisible();
  });

  test("switching through all four keeps the pick and brings today back in sight", async ({ page }) => {
    // protects: going through 3 months, 6 months, 1 year, All and back to 3 months presses only the picked button each time and keeps today's line inside the chart's view; at 6 months no week marks show
    // fails_when: two or no buttons are pressed, today's line leaves the view after a switch, or week marks show at 6 months
    // no_claim: week marks at 1 year or All (only 6 months is checked); what else the chart shows
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

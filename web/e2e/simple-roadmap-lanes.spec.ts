import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * timeline-overlap B (the owner's pick, 2026-10-28) drew the roadmap's Timeline as goal lanes
 * (frames B2 desktop, B3 phone). Train AH's build-roadmap (47361c89, the owner's picked
 * mk-qa4-roadmap designs) replaced it on screen: the Timeline is one row per item under its
 * goal's lane (QR1 A, _zoom.tsx), always grouped by goal, and a phone's Timeline is a list by
 * quarter; the pieces, milestone ends, holidays and Group by live on the Gantt (and the
 * Waterfall). Each test keeps its card's promise on the new design. Driven through the UI
 * against the mock's "simple-plan-lanes" scenario (invented data: Guided setup's plan on the
 * onboarding roadmap, M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec, M3 Open to
 * all 28 Dec - 12 Feb, a year-end break 28 Dec - 1 Jan, and only planned work on the roadmap),
 * on a desktop (1366x820) and a phone (390x844), light and dark.
 */

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);
const group = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ has: page.locator("span", { hasText: new RegExp(`^${title}$`) }) });
const row = (page: Page, key: string): Locator => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);
const label = (page: Page, title: string): Locator => page.getByTestId("chart-label").filter({ has: page.getByTestId("label-title").getByText(title, { exact: true }) });

async function open(page: Page, scheme: "light" | "dark") {
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
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
}

async function format(page: Page, f: "gantt" | "waterfall" | "timeline") {
  await page.getByTestId(`format-${f}`).click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
}

/** The Timeline's lane (its title) an item's row sits under: the nearest lane header above it. */
async function laneOf(page: Page, key: string) {
  return row(page, key).evaluate((el) => {
    let e = el.previousElementSibling;
    while (e && e.getAttribute("data-testid") !== "timeline-lane") e = e.previousElementSibling;
    return (e?.textContent ?? "").split(" · ")[0].trim();
  });
}

/** The Gantt's group (its title) an item's row sits under. */
async function groupOf(page: Page, title: string) {
  return label(page, title).evaluate((el) => {
    let e = el.parentElement!.previousElementSibling;
    while (e && e.getAttribute("data-testid") !== "chart-group") e = e.previousElementSibling;
    return (e?.querySelector("span")?.textContent ?? "").trim();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ ...DESKTOP, colorScheme: scheme });

    /**
     * Card lanes-b2-draw: protects = the goal lanes: one lane per goal with its name and item
     * count, then PM-owned, as the Timeline (QR1 A) draws them; PM-owned work (F-04, F-10,
     * F-18) in its own lane and drawn grey and dashed on the Gantt; pieces that overlap never
     * share a row (Setup checklist and Sample data import, both Activation's), pieces one after
     * the other sit in their lane in start order (Setup failure alerts, then Setup error report);
     * a feature's two slices are one bar on one row of the Gantt, each piece named by its name and
     * its milestone (F-05a in M1, F-05b in M2); the Timeline's months and Today, the Gantt's
     * weeks and Today pill, each milestone's end "M1 ends Nov 27" with a dashed line, the
     * year-end break, the legend (One bar per part of a feature, Milestone ends, Holidays, No
     * engineering work, Today); the Timeline always groups by goal, so it offers no Group by and
     * no lanes hint; fails_when = a lane, a count, the PM-owned lane, a milestone, the one-bar
     * slices, the stacking, a milestone end or a legend entry is missing or wrong; no_claim =
     * pixels, the slices' colours (the Gantt draws every bar in the accent by design).
     */
    test(`B2: goal lanes with stacked pieces (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "zoom");
      const lanes = await page.getByTestId("timeline-lane").allInnerTexts();
      // P-1: the Goal map's 12 features are roadmap items from the first load; their roadmap items name no goal.
      expect(lanes).toEqual(["Activation · 5 items", "Reliability · 5 items", "Revenue · 3 items", "Growth · 4 items", "PM-owned · 3 items", "No goal · 12 items"]);
      // The Timeline always draws its rows under their goal: no Group by, no stale lanes hint.
      await expect(page.getByTestId("group-milestone")).toHaveCount(0);
      await expect(page.getByTestId("lanes-hint")).toHaveCount(0);
      // PM-owned work (F-04, F-10, F-18) sits in its own lane.
      for (const key of ["plan-f-04", "plan-f-10", "plan-f-18"]) expect(await laneOf(page, key)).toBe("PM-owned");
      // Overlapping pieces never share a row; pieces one after the other sit in start order in their lane.
      expect(await laneOf(page, "setup-checklist")).toBe("Activation");
      expect(await laneOf(page, "setup-import")).toBe("Activation");
      const [checklist, sample] = [(await row(page, "setup-checklist").boundingBox())!, (await row(page, "setup-import").boundingBox())!];
      expect(Math.abs(checklist.y - sample.y)).toBeGreaterThanOrEqual(checklist.height - 1);
      await expect(row(page, "setup-checklist").getByTestId("timeline-bar")).toHaveAttribute("data-end", "2026-11-20");
      await expect(row(page, "setup-import").getByTestId("timeline-bar")).toHaveAttribute("data-start", "2026-11-09");
      expect(await laneOf(page, "plan-f-03")).toBe("Reliability");
      expect(await laneOf(page, "plan-f-06")).toBe("Reliability");
      expect((await row(page, "plan-f-03").boundingBox())!.y).toBeLessThan((await row(page, "plan-f-06").boundingBox())!.y);
      // The Timeline's axis: months, Today (its line and its day in the key).
      await expect(page.getByTestId("timeline-month").filter({ hasText: /^Dec$/ })).toHaveCount(1);
      await expect(page.getByTestId("today-line")).toHaveCount(1);
      await expect(page.getByTestId("timeline-key").locator('li[data-key="today"]')).toHaveText(/^Today \w{3} \d+$/);
      let w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w).toBeLessThanOrEqual(1367);

      await format(page, "gantt");
      // The Gantt draws PM-owned work grey and dashed, in the PM-owned group.
      await expect(group(page, "PM-owned")).toHaveCount(1);
      for (const [code, title] of [["F-04", "Pricing page words"], ["F-10", "Launch email"], ["F-18", "Pricing questions page"]]) {
        await expect(slice(page, code)).toHaveAttribute("data-pm-owned", "true");
        await expect(slice(page, code).locator("rect[data-slice-body]")).toHaveAttribute("stroke-dasharray", /\d/);
        expect(await groupOf(page, title)).toBe("PM-owned");
      }
      // A feature's two slices: one bar, one row, each piece in its own milestone, named by its name.
      await expect(bar(page, "plan-f-05").getByTestId("slice-bar")).toHaveCount(2);
      await expect(slice(page, "F-05a")).toHaveAttribute("data-milestone", "M1");
      await expect(slice(page, "F-05b")).toHaveAttribute("data-milestone", "M2");
      await expect(bar(page, "plan-f-05")).toHaveAttribute("aria-label", /F-05a in M1 Prove it, F-05b in M2 Scale volume/);
      const a = (await slice(page, "F-05a").locator("rect[data-slice-body]").boundingBox())!;
      const b = (await slice(page, "F-05b").locator("rect[data-slice-body]").boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(1);
      await expect(slice(page, "F-05a").locator("title")).toHaveText(/^Team invites, part 1 of 2 · M1 Prove it/);
      await expect(slice(page, "F-05b").locator("title")).toHaveText(/^Team invites, part 2 of 2 · M2 Scale volume/);
      // Each piece's visible label reads its name or its part, never its code.
      for (const [code, part] of [["F-05a", "1"], ["F-05b", "2"]]) {
        await expect(slice(page, code).getByTestId("slice-label")).toBeVisible();
        await expect(slice(page, code).getByTestId("slice-label")).toHaveText(new RegExp(`^(Team invites|Tea…|Part ${part} of 2)`));
        await expect(slice(page, code).getByTestId("slice-label")).not.toHaveText(/F-\d/);
      }
      // The Gantt's axis: weeks, the Today pill; the milestones' ends; the holidays; the legend.
      await expect(page.getByTestId("axis-tick").filter({ hasText: /^Dec 7$/ })).toHaveCount(1);
      await expect(page.getByTestId("today-pill")).toHaveText("Today");
      const m1 = page.getByTestId("milestone-end").filter({ has: page.getByTestId("milestone-end-label").getByText(/^M1 ends/) });
      await expect(m1.getByTestId("milestone-end-label")).toHaveText("M1 ends Nov 27");
      await expect(m1.getByTestId("milestone-end-line")).toHaveAttribute("stroke-dasharray", /\d/);
      await expect(page.getByTestId("milestone-end-label").filter({ hasText: /^M2 ends/ })).toHaveText("M2 ends Dec 25");
      await expect(page.getByTestId("no-work")).toHaveAttribute("data-start", "2026-12-28");
      const legend = page.getByTestId("legend");
      for (const words of ["One bar per part of a feature", "Milestone ends (dashed line)", "Holidays year-end break", "No engineering work", /^Today$/])
        await expect(legend.getByTestId("legend-item").filter({ hasText: words })).toHaveCount(1);
      w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w).toBeLessThanOrEqual(1367);

      // The Waterfall shows the whole plan: all three milestones' ends, each with its dashed line.
      await format(page, "waterfall");
      const ends = page.getByTestId("milestone-end");
      await expect(ends).toHaveCount(3);
      await expect(ends.getByTestId("milestone-end-label")).toHaveText(["M1 ends Nov 27", "M2 ends Dec 25", /^M3 ends Feb 12/]);
      for (let n = 0; n < 3; n++) await expect(ends.nth(n).getByTestId("milestone-end-line")).toHaveAttribute("stroke-dasharray", /\d/);
      await expect(group(page, "PM-owned").getByTestId("lane-count")).toHaveText("3 items");
    });

    /**
     * Card lanes-b2-card: protects = clicking an item opens the item's card, naming the item and
     * its slices: on the Timeline its bar opens the card in the side panel (QR4 A) and marks its
     * row open; on the Gantt a piece (F-05b) opens the same item's card; fails_when = a click
     * opens nothing or another item; no_claim = the card's lines (simple-roadmap specs).
     */
    test(`B2: a piece opens its item's card (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await row(page, "plan-f-05").getByTestId("timeline-bar").click();
      const panel = page.getByTestId("item-panel");
      await expect(panel.getByRole("heading", { name: "Team invites" })).toBeVisible();
      await expect(panel.getByTestId("card-slice")).toHaveCount(2);
      await expect(row(page, "plan-f-05")).toHaveAttribute("data-open", "true");
      await panel.getByRole("button", { name: "Close" }).click();
      await expect(panel).toHaveCount(0);

      await format(page, "gantt");
      await slice(page, "F-05b").locator("rect[data-slice-body]").click();
      const card = page.getByTestId("floating-card");
      await expect(card.getByRole("heading", { name: "Team invites" })).toBeVisible();
      await expect(card.getByTestId("card-slice")).toHaveCount(2);
      await expect(bar(page, "plan-f-05")).toHaveAttribute("data-open", "true");
    });

    /**
     * Card lanes-group-by: protects = Group by Track, PRD and Milestone draw groups of that
     * grouping (on the Gantt: the Timeline always groups by goal and offers no Group by): by
     * Milestone, M1 Prove it, M2 Scale volume and M3 Open to all (Team invites under M1, its
     * first slice, still drawn as both slices), by Track the track "Guided setup track", by PRD
     * Guided setup; in each, Setup checklist and Sample data import (they overlap) sit in one
     * group on two rows, and PM-owned work stays in its group; fails_when = a grouping draws the
     * goal groups, a group is missing, or overlapping pieces share a row; on the Waterfall each
     * milestone's group heads its count of items (M1 6, M2 6, M3 8); no_claim = the groups'
     * order beyond the API's.
     */
    test(`Group by Milestone, Track and PRD draw their own lanes (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("group-milestone")).toHaveCount(0);
      await format(page, "gantt");
      await page.getByTestId("group-milestone").click();
      await expect(page.getByTestId("group-milestone")).toHaveAttribute("aria-pressed", "true");
      for (const t of ["M1 Prove it", "M2 Scale volume", "M3 Open to all"]) await expect(group(page, t)).toHaveCount(1);
      await expect(group(page, "PM-owned")).toHaveCount(0);
      await expect.poll(() => groupOf(page, "Team invites")).toBe("M1 Prove it");
      await expect(slice(page, "F-05b")).toBeAttached();
      for (const g of ["milestone", "track", "prd"] as const) {
        await page.getByTestId(`group-${g}`).click();
        await expect(page.getByTestId(`group-${g}`)).toHaveAttribute("aria-pressed", "true");
        const title = g === "track" ? "Guided setup track" : g === "prd" ? "Guided setup" : "M1 Prove it";
        await expect(group(page, title)).toHaveCount(1);
        await expect(group(page, "Activation")).toHaveCount(0);
        await expect
          .poll(async () => {
            const [gc, gs] = [await groupOf(page, "Setup checklist"), await groupOf(page, "Sample data import")];
            const [c, s] = [(await bar(page, "setup-checklist").boundingBox())!, (await bar(page, "setup-import").boundingBox())!];
            return gc === title && gs === title && Math.abs(c.y - s.y) >= 1 ? "one group, two rows" : `${gc}:${c.y} ${gs}:${s.y} want ${title}`;
          }, { message: `${g}: Setup checklist and Sample data import share ${title} on two rows` })
          .toBe("one group, two rows");
        await expect(group(page, "PM-owned")).toHaveCount(0);
      }
      // The Waterfall, by Milestone, heads each milestone's group with its count of items.
      await page.getByTestId("group-milestone").click();
      await format(page, "waterfall");
      await expect(page.getByTestId("group-milestone")).toHaveAttribute("aria-pressed", "true");
      // (Team invites counts once, under M1, its first slice.)
      for (const [t, n] of [["M1 Prove it", "6 items"], ["M2 Scale volume", "6 items"], ["M3 Open to all", "8 items"]])
        await expect(group(page, t).getByTestId("lane-count")).toHaveText(n);
    });
  });

  test.describe(`phone, ${scheme}`, () => {
    test.use({ ...PHONE, colorScheme: scheme });

    /**
     * Card lanes-b3-phone: protects = a phone's Timeline (the list by quarter that replaced B3's
     * thin lanes): each quarter names itself and its count, today's quarter carries the Today
     * pill; each item reads its name, its dates and its goal, its PRD's as on the desktop's lanes
     * (Setup checklist, Nov 2 – Nov 20, Activation), in start order; tapping an item opens its card as a bottom sheet, its
     * row marked open; the page never scrolls sideways; Group by is the Gantt's (Milestone: a
     * group per milestone, no PM-owned); fails_when = a quarter, a row, the dates, the sheet or
     * a grouping is missing or wrong; no_claim = pixels.
     */
    test(`B3: thin lanes, the open one listed below (phone, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "zoom");
      const list = page.getByTestId("timeline-list");
      const quarters = list.getByTestId("timeline-quarter");
      await expect(quarters).toHaveCount(2);
      await expect(quarters.nth(0).locator("h3")).toHaveText(/^Q4 2026\s*Oct – Dec 2026 · 12 items\s*Today \w{3} \d+$/);
      // P-1: Q1 2027 also lists the Goal map's 12 features (roadmap items from the first load, next quarter).
      await expect(quarters.nth(1).locator("h3")).toHaveText(/^Q1 2027\s*Jan – Mar 2027 · 20 items$/);
      await expect(list.getByTestId("timeline-row")).toHaveCount(32);
      await expect(row(page, "setup-checklist")).toHaveText(/^Setup checklist\s*Nov 2 – Nov 20 · Activation$/);
      await expect(row(page, "plan-f-03")).toHaveText(/^Setup failure alerts\s*Nov 2 – Nov 13/);
      // P-1: the Goal map's One-tap sign-up link (Jan 1) starts before Public signup (Jan 4), in start order.
      await expect(quarters.nth(1).getByTestId("timeline-row").first()).toHaveText(/^One-tap sign-up link\s*Jan 1 – Jun 30, 2027/);
      await expect(quarters.nth(1).getByTestId("timeline-row").filter({ hasText: "Public signup" })).toHaveText(/^Public signup\s*Jan 4 – Jan 29, 2027/);
      await expect(page.getByTestId("group-milestone")).toHaveCount(0);

      await row(page, "plan-f-05").getByTestId("timeline-bar").click();
      const card = page.getByTestId("floating-card");
      await expect(card).toHaveAttribute("data-sheet", "bottom");
      await expect(card.getByRole("heading", { name: "Team invites" })).toBeVisible();
      await expect(card.getByTestId("card-slice")).toHaveCount(2);
      await expect(row(page, "plan-f-05")).toHaveAttribute("data-open", "true");
      await card.getByRole("button", { name: "Close" }).click();
      await expect(card).toHaveCount(0);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w).toBeLessThanOrEqual(391);

      // Group by Milestone (the Gantt's): a group per milestone.
      await format(page, "gantt");
      await page.getByTestId("group-milestone").click();
      await expect(page.getByTestId("group-milestone")).toHaveAttribute("aria-pressed", "true");
      for (const t of ["M1 Prove it", "M2 Scale volume", "M3 Open to all"]) await expect(group(page, t)).toHaveCount(1);
      await expect(group(page, "PM-owned")).toHaveCount(0);
    });
  });
}

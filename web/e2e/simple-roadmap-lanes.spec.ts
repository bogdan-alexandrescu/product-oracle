import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * timeline-overlap B (the owner's pick, 2026-10-28): the roadmap's Timeline as goal lanes,
 * built to frames B2 (desktop) and B3 (phone). Driven through the UI against the mock's
 * "simple-plan-lanes" scenario (invented data: Guided setup's plan on the onboarding roadmap,
 * M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov - 25 Dec, M3 Open to all 28 Dec - 12 Feb,
 * a year-end break 28 Dec - 1 Jan, and only planned work on the roadmap, as B2 draws it), on a
 * desktop (1366x820) and a phone (390x844), light and dark.
 */

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const lane = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ has: page.locator("b", { hasText: new RegExp(`^${title}$`) }) });
const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);
const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);
const phoneLane = (page: Page, title: string): Locator => page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: new RegExp(`^${title}$`) }) });

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

/** The lane (its key) a bar sits in, and its row there. */
async function placeOf(page: Page, key: string) {
  const b = bar(page, key);
  return { lane: await b.getAttribute("data-lane"), row: Number(await b.getAttribute("data-row")) };
}

async function laneKey(page: Page, title: string) {
  return lane(page, title).getAttribute("data-lane");
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ ...DESKTOP, colorScheme: scheme });

    /**
     * Card lanes-b2-draw: protects = B2's goal lanes: one lane per goal with its name and item
     * count, then PM-owned ("3 items · no engineering"); each piece a pill coloured by its
     * milestone (F-05a in M1 and F-05b in M2 differ), a feature's slices on one row joined by a
     * dotted line; pieces that overlap stack (Setup checklist and Sample data import take two
     * rows of Faster activation), pieces one after the other share a row (Setup failure alerts
     * and Setup error report); the month row, the week row with the Today pill, each milestone's
     * end a flag "M1 ends Nov 27" with a dashed line, the year-end break hatched, the legend in
     * the card (M1, M2, M3, PM-owned, Today, Holidays, slices of one feature) and the Group by's
     * hint; fails_when = a lane, a count, the PM-owned lane, a colour, the connector, the
     * stacking, a flag or a legend entry is missing or wrong; no_claim = pixels.
     */
    test(`B2: goal lanes with stacked pieces (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      const titles = await page.getByTestId("chart-group").locator("b").allInnerTexts();
      expect(titles).toEqual(["Faster activation", "Reliability", "Revenue", "Growth", "Activation", "PM-owned"]);
      await expect(lane(page, "Reliability").getByTestId("lane-count")).toHaveText("5 items");
      await expect(lane(page, "PM-owned").getByTestId("lane-count")).toHaveText("3 items · no engineering");
      // PM-owned work (F-04, F-10, F-18) sits in its own lane, grey and dashed.
      const pm = await laneKey(page, "PM-owned");
      for (const code of ["F-04", "F-10", "F-18"]) {
        await expect(slice(page, code)).toHaveAttribute("data-pm-owned", "true");
        expect(await slice(page, code).locator("xpath=..").getAttribute("data-lane")).toBe(pm);
      }
      // Overlapping pieces stack; pieces one after the other share a row.
      const [checklist, sample] = [await placeOf(page, "setup-checklist"), await placeOf(page, "setup-import")];
      expect(checklist.lane).toBe(sample.lane);
      expect(checklist.row).not.toBe(sample.row);
      const [alerts, report] = [await placeOf(page, "plan-f-03"), await placeOf(page, "plan-f-06")];
      expect(alerts.lane).toBe(report.lane);
      expect(alerts.row).toBe(report.row);
      // A feature's two slices: one row, two milestone colours, a dotted line between them.
      await expect(slice(page, "F-05a")).toHaveAttribute("data-milestone", "M1");
      await expect(slice(page, "F-05b")).toHaveAttribute("data-milestone", "M2");
      expect(await slice(page, "F-05a").getAttribute("data-colour")).not.toBe(await slice(page, "F-05b").getAttribute("data-colour"));
      const a = (await slice(page, "F-05a").locator("rect[data-slice-body]").boundingBox())!;
      const b = (await slice(page, "F-05b").locator("rect[data-slice-body]").boundingBox())!;
      expect(Math.abs(a.y - b.y)).toBeLessThan(1);
      await expect(page.locator('[data-testid="slice-connector"][data-feature="F-05"]')).toHaveAttribute("stroke-dasharray", /\d/);
      // fix4 qa-simple-roadmap-3: a slice is labelled by its name, never its code.
      await expect(slice(page, "F-05a").getByTestId("slice-label")).toHaveText(/^Team invites/);
      // The axis: months, weeks, Today; the milestones' flags; the holidays.
      await expect(page.getByTestId("axis-tick").filter({ hasText: "Dec" })).toHaveCount(1);
      await expect(page.getByTestId("axis-week").filter({ hasText: /^16$/ })).toHaveCount(1);
      await expect(page.getByTestId("today-pill")).toHaveText("Today");
      const ends = page.getByTestId("milestone-end");
      await expect(ends).toHaveCount(3);
      await expect(ends.nth(0).getByTestId("milestone-end-label")).toHaveText("M1 ends Nov 27");
      await expect(ends.nth(1).getByTestId("milestone-end-label")).toHaveText("M2 ends Dec 25");
      await expect(ends.nth(2).getByTestId("milestone-end-label")).toHaveText("M3 ends Feb 12, 2027");
      await expect(ends.nth(0).getByTestId("milestone-flag")).toBeAttached();
      await expect(ends.nth(0).getByTestId("milestone-end-line")).toHaveAttribute("stroke-dasharray", /\d/);
      await expect(page.getByTestId("no-work")).toHaveAttribute("data-start", "2026-12-28");
      const legend = page.getByTestId("simple-chart").getByTestId("legend");
      for (const words of ["M1", "M2", "M3", "PM-owned, no engineering", /^Today \w{3} \d+$/, "Holidays Dec 28 – Jan 1, 2027", "slices of one feature"])
        await expect(legend.getByTestId("legend-item").filter({ hasText: words })).toHaveCount(1);
      await expect(page.getByTestId("lanes-hint")).toHaveText("Pieces stack inside a lane when they run at once");
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w).toBeLessThanOrEqual(1367);
    });

    /**
     * Card lanes-b2-card: protects = clicking a piece in its lane opens the item's floating card
     * (as the row model did), naming the item and its slices; fails_when = a click opens
     * nothing or another item; no_claim = the card's lines (simple-roadmap specs).
     */
    test(`B2: a piece opens its item's card (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await slice(page, "F-05b").click();
      const card = page.getByTestId("floating-card");
      await expect(card.getByRole("heading", { name: "Team invites" })).toBeVisible();
      await expect(card.getByTestId("card-slice")).toHaveCount(2);
      await expect(bar(page, "plan-f-05")).toHaveAttribute("data-open", "true");
    });

    /**
     * Card lanes-group-by: protects = Group by Track, PRD and Milestone draw lanes of that
     * grouping with the same stacking: by Milestone, M1 Prove it, M2 Scale volume and M3 Open to
     * all (Team invites under M1, its first slice, still drawn as both slices), by Track the
     * track "Guided setup track", by PRD Guided setup; in each, Setup checklist and Sample data import
     * (they overlap) take two rows of one lane, and PM-owned work stays in its group's lane;
     * fails_when = a grouping draws the goal lanes, a lane is missing, or overlapping pieces
     * share a row; no_claim = the groups' order beyond the API's.
     */
    test(`Group by Milestone, Track and PRD draw their own lanes (desktop, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await page.getByTestId("group-milestone").click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", "milestone");
      for (const t of ["M1 Prove it", "M2 Scale volume", "M3 Open to all"]) await expect(lane(page, t)).toHaveCount(1);
      await expect(lane(page, "PM-owned")).toHaveCount(0);
      expect((await placeOf(page, "plan-f-05")).lane).toBe(await laneKey(page, "M1 Prove it"));
      await expect(slice(page, "F-05b")).toBeAttached();
      for (const group of ["milestone", "track", "prd"] as const) {
        await page.getByTestId(`group-${group}`).click();
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", group);
        // The chart takes the new grouping at once but keeps the last answer's lanes until the new one lands
        // (train AB re-review): wait for the new grouping's own lane, matched exactly, and for both bars in it.
        const title = group === "track" ? "Guided setup track" : group === "prd" ? "Guided setup" : null;
        if (title) await expect(lane(page, title)).toHaveCount(1);
        await expect
          .poll(async () => {
            const want = title ? await lane(page, title).getAttribute("data-lane") : null;
            const [checklist, sample] = [await placeOf(page, "setup-checklist"), await placeOf(page, "setup-import")];
            const inLane = title ? checklist.lane === want && sample.lane === want : checklist.lane === sample.lane;
            return inLane && checklist.row !== sample.row ? "one lane, two rows" : `${checklist.lane}:${checklist.row} ${sample.lane}:${sample.row} want ${want}`;
          }, { message: `${group}: Setup checklist and Sample data import share ${title ?? "one"} lane on two rows` })
          .toBe("one lane, two rows");
        await expect(lane(page, "PM-owned")).toHaveCount(0);
      }
    });
  });

  test.describe(`phone, ${scheme}`, () => {
    test.use({ ...PHONE, colorScheme: scheme });

    /**
     * Card lanes-b3-phone: protects = B3: one thin lane per goal with its name and count, each
     * lane's work as one bar per run of a milestone (Faster activation's two M1 pieces are one
     * bar, 2 Nov - 27 Nov), the lane with the most work open below ("open below", its pieces
     * listed with code, name, milestone dot and dates, "5 items, up to 1 at once"); tapping
     * another lane opens it, tapping a listed piece opens the item's card as a sheet; the page
     * never scrolls sideways; fails_when = a lane, a run, the list or the card is missing or
     * wrong; no_claim = pixels.
     */
    test(`B3: thin lanes, the open one listed below (phone, ${scheme})`, async ({ page }) => {
      await open(page, scheme);
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-view", "lanes-phone");
      await expect(page.getByTestId("phone-lane")).toHaveCount(6);
      const fa = phoneLane(page, "Faster activation");
      await expect(fa.getByTestId("lane-count")).toHaveText("2 items");
      await expect(fa.getByTestId("lane-run")).toHaveCount(1);
      await expect(fa.getByTestId("lane-run")).toHaveAttribute("data-start", "2026-11-02");
      await expect(fa.getByTestId("lane-run")).toHaveAttribute("data-end", "2026-11-27");
      await expect(phoneLane(page, "Growth").getByTestId("lane-run")).toHaveCount(3);
      // The milestones' ends (flags "M1", "M2", "M3" and their lines), Today and the holidays, as B3 draws them.
      await expect(page.getByTestId("milestone-end")).toHaveCount(3);
      await expect(page.getByTestId("milestone-end").first().getByTestId("milestone-end-label")).toHaveText("M1");
      await expect(page.getByTestId("today-pill")).toHaveText("Today");
      await expect(page.getByTestId("no-work")).toHaveAttribute("data-start", "2026-12-28");
      await expect(phoneLane(page, "Reliability")).toHaveAttribute("data-open", "true");
      await expect(phoneLane(page, "Reliability").getByTestId("lane-open-chip")).toHaveText("open below");
      const list = page.getByTestId("lane-list");
      await expect(list).toContainText("Reliability");
      await expect(list.getByTestId("lane-list-count")).toHaveText("5 items, up to 1 at once");
      await expect(list.getByTestId("lane-row")).toHaveCount(5);
      await expect(list.getByTestId("lane-row").first()).toContainText(/F-03\s*Setup failure alerts\s*Nov 2 – Nov 13/);

      await phoneLane(page, "Growth").click();
      await expect(phoneLane(page, "Growth")).toHaveAttribute("aria-expanded", "true");
      await expect(list.getByTestId("lane-list-count")).toHaveText("4 items, up to 1 at once");
      await expect(list.getByTestId("lane-row")).toHaveCount(6);
      await list.locator('[data-testid="lane-row"][data-code="F-05b"]').click();
      const card = page.getByTestId("floating-card");
      await expect(card).toHaveAttribute("data-sheet", "bottom");
      await expect(card.getByRole("heading", { name: "Team invites" })).toBeVisible();
      await card.getByRole("button", { name: "Close" }).click();
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w).toBeLessThanOrEqual(391);

      // Group by Milestone: a thin lane per milestone (the same runs).
      await page.getByTestId("group-milestone").click();
      await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-lanes", "milestone");
      for (const t of ["M1 Prove it", "M2 Scale volume", "M3 Open to all"]) await expect(phoneLane(page, t)).toHaveCount(1);
      await expect(phoneLane(page, "PM-owned")).toHaveCount(0);
    });
  });
}

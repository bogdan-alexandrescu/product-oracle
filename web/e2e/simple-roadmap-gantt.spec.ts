import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The roadmap-gantt lane (BGD's picks D and B, 2026-10-28): the roadmap's Timeline and Gantt
 * draw a planned feature as one bar per slice (F-05a in M1, F-05b in M2) on one row, joined
 * by a dotted line, coloured by milestone and labelled with code and name; the plan's
 * milestone ends are diamonds with a dashed line down the chart; the no-work week is grey;
 * rows sit in goal lanes (Group by Goal | Milestone | Track | PRD) whose headers name the
 * goal and its item count; the item card lists the slices. Driven through the UI on a desktop
 * (1366x820) and a phone (390x844), light and dark, against the mock's "simple-plan" scenario
 * (invented data: Guided setup's plan, M1 Prove it 2 Nov - 27 Nov, M2 Scale volume 30 Nov -
 * 25 Dec, M3 Open to all 28 Dec - 12 Feb with a year-end break 28 Dec - 1 Jan).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);
const lane = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ hasText: title });

async function open(page: Page, scheme: "light" | "dark", email = ADMIN.email) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-plan", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

/**
 * Opens a planned piece's item card: its pill on a desktop; on a phone (timeline-overlap B3,
 * no pills) its row in the lane's list, the lane opened first.
 */
async function openPiece(page: Page, phone: boolean, code: string, laneTitle: string) {
  if (!phone) {
    await slice(page, code).scrollIntoViewIfNeeded();
    await slice(page, code).click();
    return;
  }
  await page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: new RegExp(`^${laneTitle}$`) }) }).click();
  await page.locator(`[data-testid="lane-row"][data-code="${code}"]`).click();
}

/** The lane (its key) an item's pills sit in, and their row there (timeline-overlap B2). */
async function placeOf(page: Page, key: string) {
  const b = page.locator(`g[data-testid="bar"][data-item="${key}"]`);
  return { lane: await b.getAttribute("data-lane"), row: Number(await b.getAttribute("data-row")) };
}

/** The row (y) and the span (x) a slice's bar takes on screen. */
async function boxOf(l: Locator) {
  const b = (await l.locator("rect[data-slice-body]").boundingBox())!;
  return { x: b.x, right: b.x + b.width, mid: b.y + b.height / 2 };
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });

      // A phone's Timeline is timeline-overlap B3 (thin lanes, no pills): simple-roadmap-lanes.spec.
      for (const format of phone ? (["gantt"] as const) : (["timeline", "gantt"] as const)) {
        /**
         * Card gantt-slices: protects = Team invites (F-05) is drawn as two bars on ONE row,
         * F-05a inside M1 (9 Nov - 27 Nov) and F-05b inside M2 (30 Nov - 11 Dec); on the
         * Timeline joined by a dotted connector, each coloured by its milestone (M1 and M2
         * differ); on the Gantt both in the accent with no connector (roadmap-milestones D); dated from
         * the plan; the milestone ends are three diamonds (M1 Prove it, M2 Scale volume, M3
         * Open to all) with a dashed line down the chart at each end date; the year-end break
         * is a grey no-work band; the Today line is drawn; fails_when = the feature is one bar,
         * its slices sit on two rows or lose the connector, a slice takes the item's span
         * instead of the plan's dates, both slices share a colour, a diamond or its line is
         * missing, or the no-work week is not grey; no_claim = pixel colours, the label's
         * exact cut-off width, the API's placement rules (api pytest).
         */
        test(`${format}: a two-slice feature on one row, the milestone diamonds and the no-work week (${where})`, async ({ page }) => {
          await open(page, scheme);
          if (format === "gantt") {
            await page.getByTestId("format-gantt").click();
            await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
          }
          const a = slice(page, "F-05a");
          const b = slice(page, "F-05b");
          await expect(a).toHaveAttribute("data-start", "2026-11-09");
          await expect(a).toHaveAttribute("data-end", "2026-11-27");
          await expect(a).toHaveAttribute("data-milestone", "M1");
          await expect(b).toHaveAttribute("data-start", "2026-11-30");
          await expect(b).toHaveAttribute("data-end", "2026-12-11");
          await expect(b).toHaveAttribute("data-milestone", "M2");
          // roadmap-milestones D: the Gantt draws every slice in the accent, with no connector;
          // the Timeline (timeline-overlap B2) colours them by milestone, joined by a dotted line.
          if (format === "gantt") expect(await a.getAttribute("data-colour")).toBe(await b.getAttribute("data-colour"));
          else expect(await a.getAttribute("data-colour")).not.toBe(await b.getAttribute("data-colour"));
          await a.scrollIntoViewIfNeeded();
          const [ba, bb] = [await boxOf(a), await boxOf(b)];
          expect(Math.abs(ba.mid - bb.mid), "both slices on the same row").toBeLessThan(1);
          expect(ba.right).toBeLessThanOrEqual(bb.x + 1);
          const link = page.locator('[data-testid="slice-connector"][data-feature="F-05"]');
          if (format === "gantt") await expect(link).toHaveCount(0);
          else if (bb.x - ba.right < 10) {
            // timeline-overlap B2: a gap too short to show the dotted line draws none.
            await expect(link).toHaveCount(0);
          } else {
            await expect(link).toHaveAttribute("stroke-dasharray", /\d/);
            const lb = (await link.boundingBox())!;
            expect(Math.abs(lb.y + lb.height / 2 - ba.mid)).toBeLessThan(2);
          }

          const ends = page.getByTestId("milestone-end");
          await expect(ends).toHaveCount(3);
          await expect(ends.nth(0)).toHaveAttribute("data-date", "2026-11-27");
          await expect(ends.nth(0)).toHaveAccessibleName(/M1 Prove it ends 27 Nov|M1 Prove it ends Nov 27/);
          await expect(ends.nth(1)).toHaveAccessibleName(/M2 Scale volume/);
          await expect(ends.nth(2)).toHaveAccessibleName(/M3 Open to all/);
          await expect(ends.nth(0).locator('line[data-testid="milestone-end-line"]')).toHaveAttribute("stroke-dasharray", /\d/);
          await expect(page.getByTestId("no-work")).toHaveCount(1);
          await expect(page.getByTestId("no-work")).toHaveAttribute("data-start", "2026-12-28");
          await expect(page.getByTestId("today-line")).toBeAttached();
        });
      }

      if (!phone) {
        /**
         * Card gantt-goal-lanes: protects = by default the Timeline's lanes are the goals, each
         * header naming the goal and its item count ("Growth", "4 items": its PM-owned Launch
         * email sits in the PM-owned lane, timeline-overlap B2), the plan's features in the lane
         * of the goal they move most; inside the Growth lane Usage dashboard (F-08) and Referral
         * link (F-12) run at the same time and stack on two rows; Group by Milestone puts Team
         * invites in "M1 Prove it" (its first slice) with a count, still drawn as its two
         * slices; fails_when = the plan's features fall under "No goal", a lane has no count,
         * overlapping items share a row, or Group by Milestone is missing; no_claim = the lanes'
         * order beyond the API's (simple-roadmap-lanes.spec: Track, PRD and the phone's lanes).
         */
        test(`goal lanes stack parallel work, and Group by Milestone (${where})`, async ({ page }) => {
          await open(page, scheme);
          const growth = lane(page, "Growth");
          await expect(growth).toHaveCount(1);
          await expect(growth.getByTestId("lane-count")).toHaveText("4 items");
          const f08 = await boxOf(slice(page, "F-08"));
          const f12 = await boxOf(slice(page, "F-12a"));
          expect(Math.abs(f08.mid - f12.mid), "two rows").toBeGreaterThan(10);
          expect(f08.x < f12.right && f12.x < f08.right, "they overlap in time").toBe(true);
          // Both sit in the Growth lane, on two of its rows.
          const growthKey = await growth.getAttribute("data-lane");
          const [usage, referral] = [await placeOf(page, "plan-f-08"), await placeOf(page, "plan-f-12")];
          expect(usage.lane).toBe(growthKey);
          expect(referral.lane).toBe(growthKey);
          expect(usage.row).not.toBe(referral.row);

          await page.getByTestId("group-milestone").click();
          const m1 = lane(page, "M1 Prove it");
          await expect(m1).toHaveCount(1);
          await expect(m1.getByTestId("lane-count")).toHaveText(/^\d+ items?$/);
          await expect(lane(page, "M2 Scale volume")).toHaveCount(1);
          await expect(lane(page, "M3 Open to all")).toHaveCount(1);
          await expect(slice(page, "F-05b")).toBeAttached();
          expect((await placeOf(page, "plan-f-05")).lane).toBe(await m1.getAttribute("data-lane"));
          expect((await placeOf(page, "plan-f-05")).lane).not.toBe(await lane(page, "M2 Scale volume").getAttribute("data-lane"));
        });
      }

      /**
       * Card gantt-card-slices: protects = opening Team invites (its bar) shows a Milestone
       * line naming M1 Prove it and M2 Scale volume and lists each slice with its code and
       * name, milestone, dates and engineer-weeks; a PM-owned feature's slice says PM-owned
       * instead of weeks; fails_when = the card has no Milestone line, lists one span for a
       * two-slice feature, or loses a slice's milestone, dates or weeks; no_claim = the
       * card's other lines (simple-roadmap specs).
       */
      test(`the item card lists its slices (${where})`, async ({ page }) => {
        await open(page, scheme);
        await openPiece(page, phone, "F-05a", "Growth");
        const card = page.getByTestId("floating-card");
        await expect(card).toBeVisible();
        await expect(card.getByTestId("card-milestone")).toHaveText("M1 Prove it, M2 Scale volume");
        const rows = card.getByTestId("card-slice");
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toContainText("F-05a Team invites");
        await expect(rows.nth(0)).toContainText("M1 Prove it");
        await expect(rows.nth(0)).toContainText(/9 Nov – 27 Nov|Nov 9 – Nov 27/);
        await expect(rows.nth(0)).toContainText("3 engineer-weeks");
        await expect(rows.nth(1)).toContainText("F-05b Team invites");
        await expect(rows.nth(1)).toContainText("M2 Scale volume");
        await expect(rows.nth(1)).toContainText("2 engineer-weeks");
        await card.getByRole("button", { name: "Close" }).click();

        await openPiece(page, phone, "F-10", "PM-owned");
        await expect(page.getByTestId("card-slice")).toHaveCount(1);
        await expect(page.getByTestId("card-slice")).toContainText("PM-owned");
      });

      /**
       * Card gantt-dates-per-slice: protects = Self-serve checkout (F-11, no dates yet, two
       * slices) has ONE date to confirm in "Needs a decision" (BGD, 2026-10-28: one row per
       * feature, its slices under it): the span of its slices (14 Dec - 22 Jan), with a line per
       * slice inside its milestone as the plan places it (F-11a in M2 Scale volume 14 Dec -
       * 25 Dec, F-11b in M3 Open to all from 4 Jan, after the year-end break, to 22 Jan);
       * Accept dates the item across both slices and the row leaves the tray; fails_when = the
       * tray shows a row per slice, no slice lines, a date packed from the Now window's start
       * or months after its milestone, or the row stays after Accept; no_claim = how the API
       * stores the suggestions (api pytest), dismissing.
       */
      test(`dates to confirm: one row with its slices, each inside its milestone (${where})`, async ({ page }) => {
        await open(page, scheme);
        await page.getByTestId("needs-decision").click();
        const tray = page.getByTestId("decision-tray");
        const row = tray.getByTestId("tray-date").filter({ hasText: "Self-serve checkout:" });
        await expect(row).toHaveCount(1);
        await expect(row.locator("span").first()).toHaveText(/^Self-serve checkout: (Dec 14 – Jan 22|14 Dec – 22 Jan)$/);
        const parts = row.getByTestId("tray-date-slice");
        await expect(parts).toHaveCount(2);
        await expect(parts.nth(0)).toHaveAttribute("data-slice", "F-11a");
        await expect(parts.nth(0)).toHaveText(/^F-11a (Dec 14 – Dec 25|14 Dec – 25 Dec) · M2 Scale volume$/);
        await expect(parts.nth(1)).toHaveAttribute("data-slice", "F-11b");
        await expect(parts.nth(1)).toHaveText(/^F-11b (Jan 4 – Jan 22|4 Jan – 22 Jan) · M3 Open to all$/);
        await row.getByRole("button", { name: "Accept" }).click();
        await expect(row).toHaveCount(0);
        await tray.getByRole("button", { name: "Close" }).click();
        await openPiece(page, phone, "F-11a", "Revenue");
        await expect(page.getByTestId("card-dates")).toContainText(/Dec 14 – Jan 22|14 Dec – 22 Jan/);
      });

      if (phone) {
        /**
         * Card gantt-phone-scroll: protects = on a phone the Gantt's weeks (roadmap-milestones
         * D3) scroll sideways inside the chart with the item names pinned on the left, and the
         * current milestone (M1 Prove it, the next to run on 22 Oct) is scrolled into view;
         * fails_when = the page itself scrolls sideways, the names scroll away, or M1's start
         * is off screen; no_claim = the exact scroll offset.
         */
        test(`phone: weeks scroll with names pinned, the current milestone in view (${where})`, async ({ page }) => {
          await open(page, scheme);
          await page.getByTestId("format-gantt").click();
          const scroller = page.getByTestId("chart-scroll");
          await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-weeks", "true");
          await expect.poll(async () => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
          const sv = (await scroller.boundingBox())!;
          const a = await boxOf(slice(page, "F-05a"));
          expect(a.x).toBeGreaterThanOrEqual(sv.x - 1);
          expect(a.x).toBeLessThan(sv.x + sv.width);
          const name = page.getByTestId("chart-labels").getByText("Team invites");
          await name.scrollIntoViewIfNeeded();
          const before = (await name.boundingBox())!;
          const left0 = await scroller.evaluate((el) => el.scrollLeft);
          await scroller.evaluate((el) => el.scrollBy({ left: 400 }));
          await expect.poll(async () => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(left0);
          // The weeks moved; the name stayed where it was, on the left.
          const after = (await name.boundingBox())!;
          expect(Math.abs(after.x - before.x)).toBeLessThan(1);
          expect(after.x).toBeLessThan(sv.x);
          await expect(name).toBeInViewport();
          const w = await page.evaluate(() => document.documentElement.scrollWidth);
          expect(w).toBeLessThanOrEqual(391);
        });
      }
    });
  }
}

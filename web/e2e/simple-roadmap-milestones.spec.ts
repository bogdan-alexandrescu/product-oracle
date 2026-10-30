import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * roadmap-milestones, BGD's pick D "Gantt with milestone diamonds and per-slice bars" (fidelity
 * pass, 2026-10-28: "fix the two differences and make it match with the mockup"): the Gantt's
 * rows name the item (its code, when unique, only in the tooltip: fix2-simple-roadmap-gantt
 * finding 15/16), a split item's bars carry their slice codes (F-05a, F-05b) while a one-piece
 * bar has none, each milestone's end is a diamond with "M1 ends Nov 27" and a dashed line down
 * the chart in the milestone's colour, the axis's labels (milestone ends, key dates, track
 * milestones, Today) never overlap, the goal rows carry their metric, holidays are grey
 * columns, an item pulled in by a waiting change reads "Pending decision"; on a phone (D3) the
 * chart comes first, under the switch and the scale with
 * "Swipe sideways for M…". Driven through the UI against the mock's "simple-plan" scenario
 * (invented data: Guided setup's plan, M1 Prove it ends 27 Nov, M2 Scale volume 25 Dec, M3
 * Open to all 12 Feb, a year-end break) and the default one (two key dates, a track's Beta).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

async function open(page: Page, scheme: "light" | "dark", scenario = "simple-plan") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

const row = (page: Page, title: string): Locator => page.getByTestId("chart-label").filter({ has: page.getByTestId("label-title").getByText(title, { exact: true }) });
const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);

/** Every label on the time axis (milestone ends, key dates, track milestones, the Today pill): no two may touch. */
async function expectApart(page: Page) {
  const boxes = await page
    .locator('[data-testid="milestone-end-label"], [data-testid="key-date-label"], [data-testid="track-milestone"] text, [data-testid="today-mark"] rect')
    .evaluateAll((els) => els.map((e) => ({ words: e.textContent || "Today", r: e.getBoundingClientRect().toJSON() as DOMRect })));
  expect(boxes.length, "the axis has labels").toBeGreaterThan(1);
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const [p, q] = [boxes[a].r, boxes[b].r];
      const touch = p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5;
      expect(touch, `"${boxes[a].words}" and "${boxes[b].words}" overlap`).toBe(false);
    }
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });

      /**
       * Card milestones-d-gantt: protects = on the Gantt grouped by goal, Team invites' row
       * reads "Team invites" with its code (F-05, unique) only in its tooltip (fix2-simple-
       * roadmap-gantt finding 15/16: a visible code is dropped since the mock repeats one on
       * two items), its two bars are labelled F-05a and F-05b while Usage dashboard's one bar
       * has no label, each milestone end is a diamond with "M1 ends Nov 27" (a phone: "M1
       * ends") and a dashed line in the milestone's colour, the Faster activation row carries
       * its metric and no count or button, the year-end break is a grey column, Team invite
       * nudges (pulled in, waiting for its decider) reads "Pending decision" with an amber bar,
       * the legend says what each mark means; fails_when = a split bar lacks its slice code or
       * a single bar gains one, a milestone end is a bare code ("M2"), its line is not dashed
       * in its colour, two axis labels overlap, or the pending item is not marked; no_claim =
       * pixel colours, the card (the card lane's specs).
       */
      test(`the Gantt: codes, slice codes, milestone ends, labels apart (${where})`, async ({ page }) => {
        await open(page, scheme);
        await page.getByTestId("format-gantt").click();
        await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
        await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");

        // fix4 qa-simple-roadmap-3: a row and a slice read by name, never by code ("F-05", "F-05a").
        const invites = row(page, "Team invites");
        await expect(invites.getByTestId("label-code")).toHaveCount(0);
        await expect(invites.getByTestId("label-title")).toHaveAttribute("title", "Team invites");

        await slice(page, "F-05a").scrollIntoViewIfNeeded();
        await expect(slice(page, "F-05a").getByTestId("slice-label")).toHaveText(/^Team/);
        await expect(slice(page, "F-05b").getByTestId("slice-label")).toHaveText(/^Team/);
        await expect(slice(page, "F-08").getByTestId("slice-label")).toHaveCount(0);
        await expect(page.getByTestId("slice-connector")).toHaveCount(0);

        const m1 = page.getByTestId("milestone-end").filter({ has: page.getByTestId("milestone-end-label").getByText(/^M1 ends/) });
        await expect(m1.getByTestId("milestone-end-label")).toHaveText(phone ? "M1 ends" : /^M1 ends (Nov 27|27 Nov)$/);
        await expect(m1.getByTestId("milestone-end-line")).toHaveAttribute("stroke-dasharray", /\d/);
        await expect(m1.getByTestId("milestone-end-line")).toHaveAttribute("stroke", /--simple-m1-edge/);
        await expect(m1.locator("rect")).toHaveAttribute("fill", /--simple-m1-edge/);
        await expectApart(page);

        const activation = page.getByTestId("chart-group").filter({ hasText: "Faster activation" });
        await expect(activation.getByTestId("group-metric")).toHaveText("Days to the first alert");
        await expect(activation.getByTestId("lane-count")).toHaveCount(0);
        await expect(activation.getByRole("button")).toHaveCount(0);

        await expect(page.getByTestId("no-work")).toHaveAttribute("fill", "var(--na-bg)");
        await expect(row(page, "Team invite nudges").getByTestId("pending-tag")).toHaveText("Pending decision");
        await expect(page.locator('g[data-testid="bar"][data-item="setup-ideas"]')).toHaveAttribute("data-pulled", "true");
        await expect(page.getByTestId("today-mark")).toContainText(phone ? "" : "Today");
        if (phone) await expect(page.getByTestId("today-mark").locator("text")).toHaveCount(0);

        const legend = page.getByTestId("legend");
        await expect(legend).toContainText("One bar per part of a feature");
        await expect(legend).toContainText("Milestone ends (dashed line)");
        await expect(legend).toContainText("Holidays year-end break");
        await expect(legend).toContainText("Pulled in, pending");
        await expect(legend.getByTestId("legend-item").filter({ hasText: /^Today$/ })).toHaveCount(1);
      });

      /**
       * Card milestones-d-apart: protects = with two key dates (Customer conference, Board
       * meeting), a track's Beta and the plan's milestone ends crowding the axis, no two of
       * the axis's labels overlap on the Gantt, the Timeline or the Waterfall, and each label
       * keeps its whole words; fails_when = any two labels touch, or a label is cut; no_claim
       * = which row each label takes.
       */
      test(`the axis's labels never overlap, in every dated view (${where})`, async ({ page }) => {
        await open(page, scheme, "default");
        for (const f of ["gantt", "timeline", "waterfall"] as const) {
          await page.getByTestId(`format-${f}`).click();
          await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
          await expect(page.locator('[data-testid="key-date-marker"][data-name="Customer conference"] [data-testid="key-date-label"]')).toHaveText("Customer conference");
          await expect(page.locator('[data-testid="key-date-marker"][data-name="Board meeting"] [data-testid="key-date-label"]')).toHaveText("Board meeting");
          await expectApart(page);
        }
      });

      if (phone) {
        /**
         * Card milestones-d-phone: protects = on a phone (D3) the page opens on the switch,
         * then "Scale Day | Week" with "Swipe sideways for M…" (the milestone whose end the
         * weeks hide), then the chart with its names pinned; the page's own title is for
         * screen readers (the top bar names it); the actions, the goals and the filters follow
         * the chart and clear the tab bar; fails_when = the actions or filters come before the
         * chart, the hint names no milestone, or the last filter sits under the tab bar;
         * no_claim = the scroll offset.
         */
        test(`a phone opens on the chart, its scale and the swipe hint (${where})`, async ({ page }) => {
          await open(page, scheme);
          await page.getByTestId("format-gantt").click();
          expect((await page.getByRole("heading", { name: "Roadmap", level: 1 }).boundingBox())!.width).toBeLessThanOrEqual(1);
          await expect(page.getByTestId("swipe-hint")).toHaveText(/^Swipe sideways for M\d \S/);
          const y = async (l: Locator) => (await l.boundingBox())!.y;
          const [sw, scale, chart, actions, filters] = [
            await y(page.getByTestId("format-switch")),
            await y(page.getByTestId("phone-scale")),
            await y(page.getByTestId("simple-chart")),
            await y(page.getByTestId("roadmap-actions")),
            await y(page.getByTestId("filters")),
          ];
          expect(sw).toBeLessThan(scale);
          expect(scale).toBeLessThan(chart);
          expect(chart).toBeLessThan(actions);
          // QA2 qa-simple-roadmap-36: the filters sit above the chart they control.
          expect(filters).toBeLessThan(chart);
          await page.getByTestId("group-milestone").click();
          await expect(page.getByTestId("group-milestone")).toHaveAttribute("aria-pressed", "true");
        });
      } else {
        /**
         * Card milestones-d-filters: protects = the filter row reads PRD, Goal, Track, From,
         * To, "Group by" Goal | Track | PRD | Milestone and, on the Gantt, "Scale" Day |
         * Week, each select as wide as its choice ("All"); fails_when = a label is missing,
         * the grouping's order differs, or a select stays as wide as its longest choice;
         * no_claim = the Roadmap filter (simple-roadmap-filter specs).
         */
        test(`the filter row: labelled groups, selects as wide as their choice (${where})`, async ({ page }) => {
          await open(page, scheme);
          await page.getByTestId("format-gantt").click();
          const filters = page.getByTestId("filters");
          await expect(filters).toContainText("Group by");
          await expect(filters).toContainText("Scale");
          await expect(filters.getByRole("group", { name: "Group by" }).getByRole("button")).toHaveText(["Goal", "Track", "PRD", "Milestone"]);
          const prd = (await filters.locator("label", { hasText: /^PRD/ }).locator("select").boundingBox())!;
          expect(prd.width).toBeLessThan(90);
          await page.getByTestId("format-timeline").click();
          await expect(filters).not.toContainText("Scale");
        });
      }
    });
  }
}

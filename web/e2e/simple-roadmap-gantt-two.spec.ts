import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The roadmap-gantt lane's review fixes: the roadmap with two planned PRDs (Guided setup and
 * Usage alerts, both on the plan M1 Prove it / M2 Scale volume / M3 Open to all; Weekly alert
 * digest, F-06, is Usage alerts' M1 work) and Public signup (F-13) under a goal of its own
 * named Growth, the goal the plan's other Growth features move. The reader cannot open Usage
 * alerts' plan. Driven through the UI on a desktop (1366x820) and a phone (390x844), light and
 * dark, against the mock's "simple-plan-two" scenario (invented data).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1366, height: 820 } };

const slice = (page: Page, code: string): Locator => page.locator(`g[data-testid="slice-bar"][data-code="${code}"]`);
const lane = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ hasText: title });

async function open(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-plan-two", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-chart")).toBeVisible();
}

/**
 * The items (their keys) in a lane of the Gantt (build-roadmap: the lanes, Group by, the
 * diamonds and the grey weeks live on the Gantt; the new Timeline is a list by goal, by
 * quarter on a phone): the bars drawn between the lane's header and the next one's.
 */
async function itemsIn(page: Page, title: string): Promise<string[]> {
  const named = new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`);
  const header = page.getByTestId("chart-group").filter({ has: page.locator("span", { hasText: named }) });
  await expect(header, `a lane "${title}"`).toHaveCount(1);
  const top = (await header.boundingBox())!.y;
  const tops = await page.locator('[data-testid="chart-group"], [data-testid="below-the-line"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  const next = Math.min(...tops.filter((t) => t > top + 1), Number.POSITIVE_INFINITY);
  return page.locator('g[data-testid="bar"]').evaluateAll(
    (els, [from, to]) =>
      els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          return mid > from && mid < to;
        })
        .map((e) => e.getAttribute("data-item") ?? ""),
    [top, next] as const,
  );
}

/** The Gantt, with its lanes (a phone's and a desktop's alike). */
async function gantt(page: Page) {
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });

      /**
       * Card gantt-one-goal-lane: protects = an item under the goal Growth and the plan's items
       * whose slices move Growth share ONE Growth lane ("4 items": Team invites, Usage
       * dashboard, Referral link, Public signup; the PM-owned Launch email sits in the PM-owned
       * lane, timeline-overlap B); its suggested features open from the goal's card above the
       * chart (no button on the lane); fails_when = two lanes are titled Growth; no_claim =
       * the lanes' order, other goals' lanes. build-roadmap (8ba0ac46): a desktop's Timeline
       * draws the goal lanes as rows under a "Growth · 4 items" header; a phone's Timeline is a
       * list by quarter, so a phone reads the lanes on the Gantt.
       */
      test(`one lane per goal, whether the goal is the item's or its slices' (${where})`, async ({ page }) => {
        await open(page, scheme);
        if (!phone) {
          const growth = page.getByTestId("timeline-lane").filter({ hasText: /^Growth · \d+ items?$/ });
          await expect(growth).toHaveCount(1);
          await expect(growth).toHaveText("Growth · 4 items");
          await expect(growth.getByRole("button")).toHaveCount(0);
          // The Growth lane's rows: those after its header, up to the next lane's.
          const rows = await page.locator('[data-testid="timeline-lane"], [data-testid="timeline-row"]').evaluateAll((els) => {
            const at = els.findIndex((e) => e.getAttribute("data-testid") === "timeline-lane" && /^Growth ·/.test(e.textContent ?? ""));
            const out: string[] = [];
            for (const e of els.slice(at + 1)) {
              if (e.getAttribute("data-testid") === "timeline-lane") break;
              out.push(e.getAttribute("data-item") ?? "");
            }
            return out;
          });
          expect(rows).toHaveLength(4);
          expect(rows).toContain("plan-f-13");
          expect(rows).toContain("plan-f-05");
        }
        await gantt(page);
        await expect(lane(page, "Growth")).toHaveCount(1);
        const rows = await itemsIn(page, "Growth");
        expect(rows).toHaveLength(4);
        expect(rows).toContain("plan-f-13");
        expect(rows).toContain("plan-f-05");
      });

      /**
       * Card gantt-two-prds: protects = with two planned PRDs, Group by Milestone keeps each
       * PRD's milestone in a lane of its own, titled with its PRD ("M1 Prove it (Usage
       * alerts)" holds Weekly alert digest, "M1 Prove it (Guided setup)" holds Team invites),
       * and each PRD's milestone ends are diamonds named with their PRD; fails_when = both
       * PRDs' M1 items share one lane, a lane or a diamond does not say its PRD; no_claim =
       * where the diamonds' labels sit when two ends fall on one day. build-roadmap
       * (8ba0ac46): the diamonds and Group by are the Gantt's (the Timeline has neither).
       */
      test(`two planned PRDs: milestone lanes and diamonds name their PRD (${where})`, async ({ page }) => {
        await open(page, scheme);
        await gantt(page);
        const ends = page.getByTestId("milestone-end");
        await expect(ends).toHaveCount(6);
        await expect(ends.filter({ has: page.locator("text", { hasText: "Usage alerts" }) })).toHaveCount(3);
        await expect(page.getByRole("img", { name: /^M1 Prove it \(Usage alerts\) ends/ })).toBeAttached();
        await expect(page.getByRole("img", { name: /^M1 Prove it \(Guided setup\) ends/ })).toBeAttached();

        await page.getByTestId("group-milestone").click();
        await expect(lane(page, "M1 Prove it (Usage alerts)")).toHaveCount(1);
        await expect(lane(page, "M1 Prove it (Guided setup)")).toHaveCount(1);
        expect(await itemsIn(page, "M1 Prove it (Usage alerts)")).toEqual(["alert-digest"]);
        const guided = await itemsIn(page, "M1 Prove it (Guided setup)");
        expect(guided).toContain("plan-f-05");
        expect(guided).not.toContain("alert-digest");
      });

      /**
       * Card gantt-plan-unread: protects = a PRD whose plan the reader cannot open does not
       * take the other PRD's no-work week away (the year-end break stays grey); fails_when =
       * one plan that does not open removes every plan's grey weeks; no_claim = how the API
       * decides who reads a PRD. build-roadmap (8ba0ac46): the grey weeks are the Gantt's.
       */
      test(`a plan the reader cannot open keeps the other plan's no-work week (${where})`, async ({ page }) => {
        await open(page, scheme);
        await gantt(page);
        await expect(page.getByTestId("no-work")).toHaveCount(1);
        await expect(page.getByTestId("no-work")).toHaveAttribute("data-start", "2026-12-28");
      });

      /**
       * Card gantt-planned-label: protects = a planned item's bar, which is not dragged or
       * moved with the arrows, tells a keyboard or screen reader user how its dates change
       * (they follow the PRD's plan); fails_when = its label says nothing of how to change
       * its dates; no_claim = the words of unplanned bars (simple-roadmap specs).
       */
      test(`a planned bar says how its dates change (${where})`, async ({ page }) => {
        await open(page, scheme);
        // build-roadmap (8ba0ac46): the Timeline draws no slices; the planned bar is the Gantt's.
        await gantt(page);
        const bar = page.locator('g[data-testid="bar"]').filter({ has: slice(page, "F-05a") });
        await expect(bar).toHaveCount(1);
        await expect(bar).toHaveAccessibleName(/Its dates follow the PRD's plan: change them in the PRD/);
        await expect(bar).not.toHaveAccessibleName(/Arrows move/);
      });
    });
  }
}

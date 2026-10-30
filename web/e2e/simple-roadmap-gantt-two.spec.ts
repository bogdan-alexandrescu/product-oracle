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
 * The items (their keys) in a lane of the Timeline (timeline-overlap B2: the items whose pills
 * sit in it; B3 on a phone: the lane opened, its list's rows).
 */
async function itemsIn(page: Page, phone: boolean, title: string): Promise<string[]> {
  const named = new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`);
  if (phone) {
    const l = page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: named }) });
    await expect(l, `a lane "${title}"`).toHaveCount(1);
    await l.click();
    await expect(page.getByTestId("lane-list")).toHaveAttribute("data-lane", (await l.getAttribute("data-lane"))!);
    return page.getByTestId("lane-list").getByTestId("lane-row").evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-item") ?? ""))]);
  }
  const key = await page.getByTestId("chart-group").filter({ has: page.locator("b", { hasText: named }) }).getAttribute("data-lane");
  expect(key, `a lane "${title}"`).toBeTruthy();
  return page.locator(`g[data-testid="bar"][data-lane="${key}"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-item") ?? ""));
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
       * the lanes' order, other goals' lanes.
       */
      test(`one lane per goal, whether the goal is the item's or its slices' (${where})`, async ({ page }) => {
        await open(page, scheme);
        const growth = phone ? page.getByTestId("phone-lane").filter({ has: page.locator('[data-testid="phone-lane-name"]', { hasText: /^Growth$/ }) }) : lane(page, "Growth");
        await expect(growth).toHaveCount(1);
        await expect(growth.getByTestId("lane-count")).toHaveText("4 items");
        if (!phone) await expect(growth.getByRole("button")).toHaveCount(0);
        const rows = await itemsIn(page, phone, "Growth");
        expect(rows).toContain("plan-f-13");
        expect(rows).toContain("plan-f-05");
      });

      /**
       * Card gantt-two-prds: protects = with two planned PRDs, Group by Milestone keeps each
       * PRD's milestone in a lane of its own, titled with its PRD ("M1 Prove it (Usage
       * alerts)" holds Weekly alert digest, "M1 Prove it (Guided setup)" holds Team invites),
       * and each PRD's milestone ends are diamonds named with their PRD; fails_when = both
       * PRDs' M1 items share one lane, a lane or a diamond does not say its PRD; no_claim =
       * where the diamonds' labels sit when two ends fall on one day.
       */
      test(`two planned PRDs: milestone lanes and diamonds name their PRD (${where})`, async ({ page }) => {
        await open(page, scheme);
        const ends = page.getByTestId("milestone-end");
        await expect(ends).toHaveCount(6);
        await expect(ends.filter({ has: page.locator("text", { hasText: "Usage alerts" }) })).toHaveCount(3);
        await expect(page.getByRole("img", { name: /^M1 Prove it \(Usage alerts\) ends/ })).toBeAttached();
        await expect(page.getByRole("img", { name: /^M1 Prove it \(Guided setup\) ends/ })).toBeAttached();

        await page.getByTestId("group-milestone").click();
        if (!phone) {
          await expect(lane(page, "M1 Prove it (Usage alerts)")).toHaveCount(1);
          await expect(lane(page, "M1 Prove it (Guided setup)")).toHaveCount(1);
          await expect(lane(page, "M1 Prove it (Usage alerts)").getByTestId("lane-count")).toHaveText("1 item");
        }
        expect(await itemsIn(page, phone, "M1 Prove it (Usage alerts)")).toEqual(["alert-digest"]);
        const guided = await itemsIn(page, phone, "M1 Prove it (Guided setup)");
        expect(guided).toContain("plan-f-05");
        expect(guided).not.toContain("alert-digest");
      });

      /**
       * Card gantt-plan-unread: protects = a PRD whose plan the reader cannot open does not
       * take the other PRD's no-work week away (the year-end break stays grey); fails_when =
       * one plan that does not open removes every plan's grey weeks; no_claim = how the API
       * decides who reads a PRD.
       */
      test(`a plan the reader cannot open keeps the other plan's no-work week (${where})`, async ({ page }) => {
        await open(page, scheme);
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
        // A phone's Timeline (timeline-overlap B3) has no bars: its Gantt's.
        if (phone) await page.getByTestId("format-gantt").click();
        const bar = page.locator('g[data-testid="bar"]').filter({ has: slice(page, "F-05a") });
        await expect(bar).toHaveCount(1);
        await expect(bar).toHaveAccessibleName(/Its dates follow the PRD's plan: change them in the PRD/);
        await expect(bar).not.toHaveAccessibleName(/Arrows move/);
      });
    });
  }
}

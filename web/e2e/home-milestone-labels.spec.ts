import { HOME_MILESTONES_SCENARIO } from "../lib/api/mock/home-milestones";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * home-milestones-current, on invented data (the mock's "home-milestones-current" scenario):
 * Alerts' M1 was renamed and its M2 removed after features were placed in them; Sample data
 * import keeps an old typed "M1 · Import first" and Welcome video types "First alert within a
 * day" (Onboarding's current M1, by code and by name); New plan tiers types an "M4 · Old launch"
 * no roadmap has. Track milestones: an undated "M2 · Launch (beta)" with two items, an "M3" with
 * no name, a dropped "Old pilot" holding Team invite nudges. Two PRDs each have an "M2 · Pilot"
 * on the same day.
 *
 * Card home-plan-current-milestones: protects = Home's "The plan this quarter" groups items by
 * the roadmap's current milestones, dated or not, a dropped one never, each read whole by its
 * own code and name; a typed text goes under the current milestone it names by code or name; an
 * item whose milestone is gone goes under "Not in a milestone"; two PRDs' alike milestones are
 * two rows; fails_when = a row keeps an old name ("M1 · Alerts for 20 teams", "M1 · Import
 * first"), reads "Milestone M3" or a cut "M2 · Launch", an undated milestone's items or a typed
 * current one's fall under "Not in a milestone", the dropped one holds an item, or the two
 * Pilots share a row; no_claim = the one-pager's strip (the API's plan_strip).
 *
 * Card home-next-milestone-goal: protects = "What the next milestone delivers" reads the
 * roadmap's own (goal) milestones too, so the next one is M1 · Alerts live for 50 teams (Nov
 * 20), before the track's Beta (Nov 30); fails_when = it shows Beta's items or "No milestone
 * ahead yet."
 *
 * Card home-labels-whole: protects = every milestone and group label on Home reads whole at
 * 1440, 1024 and 390 wide (wrapped between words, never cut or clipped by its row), the QA's
 * "Not in a milestone · 11 items" at 1024 among them; fails_when = a label overflows its box,
 * ends in an ellipsis, its words run past its box, or is clipped by a box round it.
 */

async function home(page: Page, width: number, email: string = ADMIN.email) {
  await page.setViewportSize({ width, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, HOME_MILESTONES_SCENARIO] as const);
  await login(page, email);
  await page.goto("/simple");
  await expect(page.getByRole("heading", { name: "The plan this quarter" })).toBeVisible();
  await expect(page.getByTestId("home-strip-label").first()).toBeVisible();
}

/** A row's items, as its tooltip lists them under its label. */
async function itemsOf(page: Page, label: string) {
  const el = page.getByTestId("home-strip-row").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  await el.first().hover();
  return Promise.all((await el.all()).map(async (l) => ((await l.getAttribute("title")) ?? "").split("\n").slice(1).sort()));
}

test("Home's plan groups by the roadmap's current milestones, a removed one's items under Not in a milestone", async ({ page }) => {
  await home(page, 1440);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels).toEqual([
    "M1 · Alerts live for 50 teams · 1 item",
    "Beta · 1 item",
    "M1 · First alert within a day · 3 items",
    "M2 · Pilot · 2 items",
    "M2 · Pilot · 2 items",
    "M2 · Launch (beta) · 2 items",
    "M3 · 1 item",
    "Not in a milestone · 11 items",
  ]);
  for (const l of labels) {
    expect(l).not.toMatch(/Milestone M\d/);
    expect(l).not.toContain("Alerts for 20 teams");
    expect(l).not.toContain("Import first");
    expect(l).not.toContain("Old pilot");
  }
  // The renamed M1 by its current name, with the feature placed in it.
  expect(await itemsOf(page, "M1 · Alerts live for 50 teams · 1 item")).toEqual([["Alert rules engine"]]);
  // Typed texts naming Onboarding's current M1 by its code and by its name.
  expect(await itemsOf(page, "M1 · First alert within a day · 3 items")).toEqual([["Sample data import", "Setup checklist", "Welcome video"]]);
  // An undated track milestone holds its items, its name whole.
  expect(await itemsOf(page, "M2 · Launch (beta) · 2 items")).toEqual([["Alert history export", "Alert routing by team"]]);
  expect(await itemsOf(page, "M3 · 1 item")).toEqual([["Health log"]]);
  // Two PRDs' "M2 · Pilot" on one day: two rows.
  expect(await itemsOf(page, "M2 · Pilot · 2 items")).toEqual([
    ["Complaint early warning", "Rep call script hints"],
    ["Lead list ranking", "Refund in one step"],
  ]);
  // Mobile alert push (placed in the removed M2), Team invite nudges (in the dropped Old pilot)
  // and New plan tiers (an "M4 · Old launch" no roadmap has) are not in one.
  const [loose] = await itemsOf(page, "Not in a milestone · 11 items");
  expect(loose).toEqual(expect.arrayContaining(["Mobile alert push", "Team invite nudges", "New plan tiers"]));
  expect(loose).not.toEqual(expect.arrayContaining(["Sample data import"]));
  expect(loose).not.toEqual(expect.arrayContaining(["Welcome video"]));
  expect(loose).not.toEqual(expect.arrayContaining(["Alert history export"]));
  // The Simple roadmap's Milestone lanes name the same current M1.
  await page.goto("/simple/roadmap");
  await page.getByTestId("format-gantt").click();
  await page.getByTestId("group-milestone").click();
  await expect(page.getByText("M1 Alerts live for 50 teams", { exact: true }).first()).toBeVisible();
});

test("What the next milestone delivers reads the roadmap's own milestones too", async ({ page }) => {
  // A reader's Home has the card: Alerts' own M1 (Nov 20) comes before the track's Beta (Nov 30).
  await home(page, 1440, "viewer@example.com");
  const next = page.getByTestId("home-next-milestone").getByTestId("home-milestone-row");
  await expect(next).toHaveCount(1);
  await expect(next).toContainText("Alert rules engine");
  await expect(next).toContainText("M1 · Alerts live for 50 teams");
  await expect(page.getByTestId("home-next-milestone")).not.toContainText("Weekly alert digest");
});

for (const width of [1440, 1024, 390]) {
  test(`every milestone and group label on Home reads whole at ${width}`, async ({ page }) => {
    await home(page, width);
    const labels = page.locator('[data-testid="home-strip-label"], [data-testid="home-milestone-row"] .simple-small');
    expect(await labels.count()).toBeGreaterThan(0);
    for (const l of await labels.all()) {
      await l.scrollIntoViewIfNeeded();
      const m = await l.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const clipped: string[] = [];
        // Its words, line by line, as drawn: each inside its own box.
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()];
        const outside = (b: DOMRect) => lines.some((x) => x.left < b.left - 1 || x.right > b.right + 1 || x.top < b.top - 1 || x.bottom > b.bottom + 1);
        // Any box round it that hides what overflows it must hold the whole label.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if ([s.overflowX, s.overflowY].some((o) => o !== "visible")) {
            const b = p.getBoundingClientRect();
            if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1 || outside(b)) clipped.push(p.className);
          }
        }
        return {
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
          over: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
          ellipsis: getComputedStyle(el).textOverflow === "ellipsis",
          spills: getComputedStyle(el).overflowX !== "visible" && outside(r),
          offscreen: r.left < 0 || r.right > window.innerWidth + 1,
          clipped,
        };
      });
      expect(m.over, m.text).toBe(false);
      expect(m.ellipsis, m.text).toBe(false);
      expect(m.spills, m.text).toBe(false);
      expect(m.offscreen, m.text).toBe(false);
      expect(m.clipped, m.text).toEqual([]);
    }
    // The QA saw this one cut ("Not in a milestone · 11 i…") at 1024.
    await expect(page.getByTestId("home-strip-label").filter({ hasText: /^Not in a milestone · 11 items$/ })).toBeVisible();
  });
}

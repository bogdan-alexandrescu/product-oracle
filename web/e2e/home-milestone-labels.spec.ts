import { HOME_MILESTONE_GOALS_SCENARIO, HOME_MILESTONE_TRACKS_SCENARIO, HOME_MILESTONES_SCENARIO } from "../lib/api/mock/home-milestones";
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

async function home(page: Page, width: number, email: string = ADMIN.email, scenario: string = HOME_MILESTONES_SCENARIO) {
  await page.setViewportSize({ width, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple");
  await expect(page.getByRole("heading", { name: "The plan this quarter" })).toBeVisible();
  await expect(page.getByTestId("home-strip-label").first()).toBeVisible();
}

/** A row's items, as its (i) lists them when tapped (one list per row of that label). */
async function itemsOf(page: Page, label: string) {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: exact }) });
  await expect(lines.first()).toBeVisible();
  const out: string[][] = [];
  for (const line of await lines.all()) {
    await line.getByTestId("home-strip-items-tip").click();
    const tip = line.getByRole("tooltip");
    await expect(tip).toBeVisible();
    out.push((await tip.getByRole("listitem").allTextContents()).map((t) => t.trim()).sort());
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  }
  return out;
}

test("Home's plan groups by the roadmap's current milestones, a removed one's items under Not in a milestone", async ({ page }) => {
  await home(page, 1440);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels).toEqual([
    "M1 · Alerts live for 50 teams · 1 item",
    "M1 · First alert within a day · 3 items",
    "M2 · Pilot · 2 items",
    "M2 · Pilot · 2 items",
    "M2 · Launch (beta) · 3 items",
    "M3 · 2 items",
    "M3 · Prices live · 2 items",
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
  // An undated track milestone holds its items, its name whole (with the roadmap's own M2, one row).
  expect(await itemsOf(page, "M2 · Launch (beta) · 3 items")).toEqual([["Alert history export", "Alert routing by team", "Weekly alert digest"]]);
  expect(await itemsOf(page, "M3 · 2 items")).toEqual([["Health log", "Setup reminders"]]);
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

/*
 * Card home-goal-milestone-whole (review of PR 1424): protects = a roadmap's own (goal) milestone
 * reads whole as a track one does: its code and name, brackets round the name dropped, its code
 * alone with no name; it and a track milestone of its code on its roadmap are one row; a bare
 * code an item types is its own roadmap's milestone; fails_when = a row reads "M3 · ", "M2 ·
 * [Launch (beta)]", two rows share a code on one roadmap, or Annual billing (Pricing) sits under
 * Onboarding's M3.
 */
test("a roadmap's own milestone reads whole, one row per milestone, a bare code on the item's own roadmap", async ({ page }) => {
  await home(page, 1440);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  for (const l of labels) {
    expect(l).not.toMatch(/·\s*·/);
    expect(l).not.toMatch(/[[\]]/);
  }
  // Onboarding's own M3 (no name) and the track's M3: one row, its code alone.
  expect(labels.filter((l) => /^M3( ·|$)/.test(l) && !l.includes("Prices live"))).toEqual(["M3 · 2 items"]);
  // Alerts' own "[Launch (beta)]" M2 and the track's "M2 · Launch (beta)": one row.
  expect(labels.filter((l) => l.startsWith("M2 · Launch"))).toEqual(["M2 · Launch (beta) · 3 items"]);
  // Annual billing types a bare "M3": Pricing's M3, never Onboarding's.
  expect(await itemsOf(page, "M3 · Prices live · 2 items")).toEqual([["Annual billing", "Usage meter"]]);
  expect((await itemsOf(page, "M3 · 2 items"))[0]).not.toContain("Annual billing");
});

/*
 * Card home-milestones-per-goal (review of PR 1439), on the mock's "home-milestones-goals"
 * scenario: protects = codes are numbered per goal, so two goals' M1 on one roadmap are two rows,
 * each with its own name and items, and a bare "M1" an item types is its own goal's; a track
 * milestone (company-wide) holding items from two roadmaps is one row; a track milestone joining
 * a roadmap's own milestone with no name keeps the track's name; fails_when = the two M1 share a
 * row, Welcome video sits under Faster activation's M1, "M2 · Launch (beta)" shows twice, or the
 * joined row reads a bare "M3".
 */
test("two goals' M1 on one roadmap are two rows, a track milestone across roadmaps one", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Two goals' M1 on Onboarding: two rows, each its own items; the bare "M1" typed on Welcome video (Grow retention's) is Grow retention's.
  expect(labels.filter((l) => l.startsWith("M1"))).toEqual(["M1 · First run in a day · 1 item", "M1 · Return pilot · 2 items"]);
  expect(await itemsOf(page, "M1 · First run in a day · 1 item")).toEqual([["Setup checklist"]]);
  expect(await itemsOf(page, "M1 · Return pilot · 2 items")).toEqual([["Sample data import", "Welcome video"]]);
  // The Alerts track's "M2 · Launch (beta)" holds an item from each of two roadmaps: one row.
  expect(labels.filter((l) => l.startsWith("M2 · Launch"))).toEqual(["M2 · Launch (beta) · 2 items"]);
  expect(await itemsOf(page, "M2 · Launch (beta) · 2 items")).toEqual([["Alert history export", "Partner invite links"]]);
  // Alerts' own M3 (no name) and the track's "M3 · Rules ready": one row, the track's name kept.
  expect(labels.filter((l) => l.startsWith("M3"))).toEqual(["M3 · Rules ready · 2 items"]);
  expect(await itemsOf(page, "M3 · Rules ready · 2 items")).toEqual([["Alert rules engine", "Mobile alert push"]]);
});

/*
 * Card home-track-milestone-one-row (re-review of PR 1439), on the mock's "home-milestones-tracks"
 * scenario: protects = a track milestone is company-wide, so it is one row wherever its items sit,
 * and a roadmap's own milestone of its code joins it there only when it is that roadmap's only
 * one; two goals' own M3 on Pricing are two rows beside the track's M3, each its own name (none
 * borrows the track's), and a bare "M3" typed by an item of no goal guesses neither goal's (it is
 * the track's); fails_when = "M2 · Launch (beta)" shows twice, a goal's nameless M3 reads "M3 ·
 * Prices live", Annual billing sits under a goal's M3, or the twin M3 rows sound the same.
 */
test("a track milestone is one row across roadmaps, two goals' M3 beside it two rows of their own", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Alerts' own "[Launch (beta)]" M2 is Alerts' only M2: it joins the track's row, which holds Onboarding's item too.
  expect(labels.filter((l) => l.startsWith("M2 · Launch"))).toEqual(["M2 · Launch (beta) · 4 items"]);
  expect(await itemsOf(page, "M2 · Launch (beta) · 4 items")).toEqual([["Alert history export", "Alert routing by team", "Partner invite links", "Weekly alert digest"]]);
  // Onboarding's two PRDs' M2 stay their own rows.
  expect(labels.filter((l) => l.startsWith("M2 · Pilot"))).toEqual(["M2 · Pilot · 2 items", "M2 · Pilot · 2 items"]);
  // Pricing: two goals' M3 (no names) and the track's "M3 · Prices live": three rows, none borrowing the track's name.
  expect(labels.filter((l) => l.startsWith("M3 · Prices live"))).toEqual(["M3 · Prices live · 2 items"]);
  expect(await itemsOf(page, "M3 · Prices live · 2 items")).toEqual([["Annual billing", "Usage meter"]]);
  expect(await itemsOf(page, "M3 · 1 item")).toEqual([["Seat bundles"], ["Volume discounts"]]);
  // The two look-alike M3 rows sound different, even for a goal no loaded item carries.
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M3 · 1 item$/ }) });
  await expect(lines).toHaveCount(2);
  const links = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  expect(new Set(links).size, links.join(" / ")).toBe(2);
  expect(new Set(tips).size, tips.join(" / ")).toBe(2);
});

/*
 * Card home-twin-rows-named (review of PR 1439): protects = two rows that read alike (two PRDs'
 * "M2 · Pilot") keep the same visible label but their links and (i) buttons have distinct
 * accessible names; fails_when = a screen reader hears the same name for both.
 */
test("two rows that read alike have distinct accessible names", async ({ page }) => {
  await home(page, 1440);
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M2 · Pilot · 2 items$/ }) });
  await expect(lines).toHaveCount(2);
  const links = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  expect(new Set(links).size, links.join(" / ")).toBe(2);
  expect(new Set(tips).size, tips.join(" / ")).toBe(2);
  expect(links.join(" ")).toContain("Pilot plan A");
  expect(links.join(" ")).toContain("Pilot plan B");
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  /*
   * Card home-plan-items-readable: protects = a quarter plan row's items read on tap and on
   * keyboard focus, not on hover alone, the row still opening the roadmap; fails_when = the
   * items are only in a hover tooltip.
   */
  test("a quarter plan row's items read on tap and on keyboard focus", async ({ page }) => {
    await home(page, 390);
    const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M3 · Prices live · 2 items$/ }) });
    const tip = line.getByRole("tooltip");
    await expect(tip).toBeHidden();
    // Tap.
    await line.getByTestId("home-strip-items-tip").tap();
    await expect(tip).toBeVisible();
    expect((await tip.getByRole("listitem").allTextContents()).sort()).toEqual(["Annual billing", "Usage meter"]);
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    // Keyboard: from the row's link, Tab reaches its (i), which shows the items.
    await line.getByTestId("home-strip-row").focus();
    await page.keyboard.press("Tab");
    await expect(line.getByTestId("home-strip-items-tip")).toBeFocused();
    await expect(tip).toBeVisible();
    expect((await tip.getByRole("listitem").allTextContents()).sort()).toEqual(["Annual billing", "Usage meter"]);
    // The row itself still opens the roadmap.
    await expect(line.getByTestId("home-strip-row")).toHaveAttribute("href", "/simple/roadmap");
  });
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

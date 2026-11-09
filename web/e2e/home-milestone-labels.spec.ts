import { HOME_MILESTONE_GOALS_SCENARIO, HOME_MILESTONE_TRACKS_SCENARIO, HOME_MILESTONE_TWIN_TRACKS_SCENARIO, HOME_MILESTONES_SCENARIO } from "../lib/api/mock/home-milestones";
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
  // (The Onboarding track's "M1 · Measured" is a third row of its own.)
  expect(labels.filter((l) => l.startsWith("M1")).sort()).toEqual(["M1 · First run in a day · 1 item", "M1 · Measured · 3 items", "M1 · Return pilot · 2 items"]);
  expect(await itemsOf(page, "M1 · First run in a day · 1 item")).toEqual([["Setup checklist"]]);
  expect(await itemsOf(page, "M1 · Return pilot · 2 items")).toEqual([["Sample data import", "Welcome video"]]);
  // The Alerts track's "M2 · Launch (beta)" holds an item from each of two roadmaps: one row.
  expect(labels.filter((l) => l.startsWith("M2 · Launch"))).toEqual(["M2 · Launch (beta) · 3 items"]);
  expect(await itemsOf(page, "M2 · Launch (beta) · 3 items")).toEqual([["Alert history export", "Alert sound settings", "Partner invite links"]]);
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
  // Pricing: two goals' M3 (no names) and the track's "M3 · Prices live": three rows, none borrowing the track's name.
  expect(labels.filter((l) => l.startsWith("M3 · Prices live"))).toEqual(["M3 · Prices live · 2 items"]);
  expect(await itemsOf(page, "M3 · Prices live · 2 items")).toEqual([["Annual billing", "Usage meter"]]);
  expect((await itemsOf(page, "M3 · 1 item")).flat().sort()).toEqual(["Refund rules", "Seat bundles", "Volume discounts"]);
  // The look-alike M3 rows sound different, even for a goal no loaded item carries.
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M3 · 1 item$/ }) });
  await expect(lines).toHaveCount(3);
  const links = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  expect(new Set(links).size, links.join(" / ")).toBe(3);
  expect(new Set(tips).size, tips.join(" / ")).toBe(3);
});

/*
 * Card home-milestone-own-roadmap (production regression from PR 1439), on the mock's
 * "home-milestones-goals" scenario: protects = an item typed "M1" (or a stored "M1 Measured and
 * mapped") whose own goal has no M1, on a roadmap where two other goals each have one, sits under
 * its roadmap's own track milestone of that code ("M1 · Measured"), as Priorities shows it in M1,
 * even when that track is not the item's own; fails_when = it lands in "Not in a milestone" or
 * under another goal's M1.
 */
test("an item typed M1 whose goal has none sits under its roadmap's own M1, not in no milestone", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_SCENARIO);
  expect(await itemsOf(page, "M1 · Measured · 3 items")).toEqual([["Health log", "Usage map", "Usage report"]]);
  const loose = (await itemsOf(page, "Not in a milestone · 17 items"))[0];
  expect(loose).not.toContain("Usage report");
  expect(loose).not.toContain("Usage map");
  for (const other of ["M1 · First run in a day · 1 item", "M1 · Return pilot · 2 items"]) expect((await itemsOf(page, other))[0]).not.toContain("Usage report");
});

/*
 * Card home-milestone-twin-tracks (review of PR 1453), on the mock's "home-milestones-twin-tracks"
 * scenario: protects = an item typed "M1" whose own track has no M1 (or that has no track), on a
 * roadmap where two other tracks each have an M1 ("M1 · Measured" and "M1 · Other"), is never put
 * under one of them by a guess: it sits under its roadmap's own M1 of no goal when there is one
 * (Alerts' "M1 · First alerts"), else under "Not in a milestone"; fails_when = Usage report, Setup
 * FAQ or Alert badges sits under "M1 · Measured" or "M1 · Other".
 */
test("an item typed M1 never lands on a guessed track M1 when two tracks have one", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TWIN_TRACKS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(await itemsOf(page, "M1 · Measured · 2 items")).toEqual([["Alert snooze", "Health log"]]);
  expect(await itemsOf(page, "M1 · Other · 2 items")).toEqual([["Alert sounds", "Welcome tips"]]);
  // Alerts has its own M1 of no goal: Alert badges is there.
  expect(await itemsOf(page, "M1 · First alerts · 2 items")).toEqual([["Alert badges", "Alert rules engine"]]);
  // Onboarding has none: Usage report (its track has no M1) and Setup FAQ (no track) are in no milestone.
  const none = labels.find((l) => l.startsWith("Not in a milestone"));
  expect(none, labels.join(" / ")).toBeTruthy();
  const [loose] = await itemsOf(page, none!);
  expect(loose).toEqual(expect.arrayContaining(["Usage report", "Setup FAQ"]));
});

/*
 * Card home-milestone-names-kept (reviews of PR 1439), on "home-milestones-goals": protects = a
 * roadmap's only milestone of a code joins a track's row only when their whole names match or one
 * has none, so Alerts' "M2 · Fleet pilot" stays its own row beside the track's "M2 · Launch (beta)";
 * an item whose own goal has no M2 (Alert sound settings) stays on its track's row, never joining
 * the one other goal's; fails_when = "Fleet pilot" shows nowhere on Home, or Alert sound settings
 * sits under it.
 */
test("a roadmap milestone of another name keeps its own row; a typed code never joins another goal's", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => l.startsWith("M2")).sort()).toEqual(["M2 · Fleet pilot · 1 item", "M2 · Launch (beta) · 3 items"]);
  expect(await itemsOf(page, "M2 · Fleet pilot · 1 item")).toEqual([["Alert routing by team"]]);
  expect((await itemsOf(page, "M2 · Launch (beta) · 3 items"))[0]).toContain("Alert sound settings");
});

/*
 * Card home-next-milestone-whole (review of PR 1439), on "home-milestones-goals": protects = "What
 * the next milestone delivers" names the next milestone as the quarter plan's rows do (Alerts'
 * "[Fleet pilot]" M2, Nov 18, reads "M2 · Fleet pilot"); fails_when = it reads "M2 · [Fleet pilot]"
 * or a bare "M2 · ".
 */
test("the next milestone card reads the milestone's whole name, as the plan rows do", async ({ page }) => {
  await home(page, 1440, "viewer@example.com", HOME_MILESTONE_GOALS_SCENARIO);
  const next = page.getByTestId("home-next-milestone").getByTestId("home-milestone-row");
  await expect(next).toHaveCount(1);
  await expect(next).toContainText("Alert routing by team");
  await expect(next).toContainText("M2 · Fleet pilot ·");
  await expect(next).not.toContainText("[");
  await expect(page.getByTestId("home-strip-label").filter({ hasText: /^M2 · Fleet pilot · 1 item$/ })).toBeVisible();
});

/*
 * Card home-nameless-track-names-kept (reviews of PR 1439), on "home-milestones-tracks": protects =
 * a nameless track milestone ("M3", holding items on Onboarding and Alerts) takes the name of a
 * roadmap milestone that joins it, but a second roadmap's of another name keeps its own row:
 * Onboarding's "M3 · Guided tour" joins it, Alerts' "M3 · Quiet hours" stays apart; fails_when =
 * "Quiet hours" shows nowhere on Home.
 */
test("a nameless track milestone takes one joined name; another roadmap's other name keeps its row", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  expect(await itemsOf(page, "M3 · Guided tour · 3 items")).toEqual([["Alert snooze", "Health log", "Setup reminders"]]);
  expect(await itemsOf(page, "M3 · Quiet hours · 1 item")).toEqual([["Mobile alert push"]]);
});

/*
 * Card home-twin-rows-no-whose (review of PR 1439), on "home-milestones-tracks": protects = two
 * rows that read alike and whose goal no loaded item names (Keep alerts quiet's and Fewer refunds'
 * nameless M3) are told apart by their first item; fails_when = both sound the same.
 */
test("two look-alike rows with no known goal sound apart by their first item", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M3 · 1 item$/ }) });
  await expect(lines).toHaveCount(3);
  const links = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  expect(links.some((l) => l?.includes("Volume discounts")), links.join(" / ")).toBe(true);
  expect(links.some((l) => l?.includes("Refund rules")), links.join(" / ")).toBe(true);
  expect(tips.some((l) => l?.includes("Volume discounts")), tips.join(" / ")).toBe(true);
  expect(tips.some((l) => l?.includes("Refund rules")), tips.join(" / ")).toBe(true);
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

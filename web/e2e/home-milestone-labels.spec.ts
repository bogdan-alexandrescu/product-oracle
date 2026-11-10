import { HOME_MILESTONE_BARE_TRACK_SCENARIO, HOME_MILESTONE_FOLD_SCENARIO, HOME_MILESTONE_GOALS_FOLD_SCENARIO, HOME_MILESTONE_LEAD_GOALS_SCENARIO, HOME_MILESTONE_GOALS_SCENARIO, HOME_MILESTONE_PRD_FOLD_SCENARIO, HOME_MILESTONE_PLAIN_FOLD_SCENARIO, HOME_MILESTONE_PRD_GOAL_FOLD_SCENARIO, HOME_MILESTONE_PRDS_FOLD_SCENARIO, HOME_MILESTONE_TRACKS_SCENARIO, HOME_MILESTONE_TWIN_TRACKS_SCENARIO, HOME_MILESTONE_TWO_ROADMAPS_SCENARIO, HOME_MILESTONE_TWO_ROADMAPS_SWAPPED_SCENARIO, HOME_MILESTONES_SCENARIO } from "../lib/api/mock/home-milestones";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * roadmap-milestone-codes (Nov 9): every milestone on a roadmap now gets one roadmap-wide code
 * (M1, M2, M3 ... by date, undated last), not a code per goal, so two goals' old "M1" are never
 * the same code any more; the codes below were updated to the ones Oracle now assigns, but each
 * test still protects the same thing: which rows exist, which are one row and which are two, and
 * which items sit in each.
 */

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

/** The one label matching `re` (codes are roadmap-wide now, so a milestone's own number is no
 * longer predictable from its name alone; callers match by name and read the live code off this). */
function oneLabel(labels: string[], re: RegExp): string {
  const hits = labels.filter((l) => re.test(l));
  expect(hits, labels.join(" / ")).toHaveLength(1);
  return hits[0];
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
  // Codes are roadmap-wide and ascend by date (M1 earliest), so the two "Pilot" PRDs and the
  // folded Onboarding/track milestones each get their own place in the one sequence, not a
  // repeated per-goal "M1"/"M2"/"M3".
  expect(labels).toEqual([
    "M1 · Alerts live for 50 teams · 1 item",
    "M3 · First alert within a day · 3 items",
    "M4 · Pilot · 2 items",
    "M5 · Pilot · 2 items",
    "M6 · 2 items",
    "M7 · Launch (beta) · 3 items",
    "M8 · Prices live · 2 items",
    "Not in a milestone · 11 items",
  ]);
  const codes = labels.flatMap((l) => (l.match(/^M(\d+)(?: ·|$)/)?.[1] ? [Number(l.match(/^M(\d+)(?: ·|$)/)![1])] : []));
  // Codes are unique (no repeats, even for the two look-alike "Pilot" rows) and ascend in order.
  expect(new Set(codes).size).toBe(codes.length);
  expect(codes).toEqual([...codes].sort((a, b) => a - b));
  for (const l of labels) {
    expect(l).not.toMatch(/Milestone M\d/);
    expect(l).not.toContain("Alerts for 20 teams");
    expect(l).not.toContain("Import first");
    expect(l).not.toContain("Old pilot");
  }
  // The renamed M1 by its current name, with the feature placed in it.
  expect(await itemsOf(page, "M1 · Alerts live for 50 teams · 1 item")).toEqual([["Alert rules engine"]]);
  // Typed texts naming Onboarding's current milestone by its code and by its name.
  expect(await itemsOf(page, "M3 · First alert within a day · 3 items")).toEqual([["Sample data import", "Setup checklist", "Welcome video"]]);
  // An undated track milestone holds its items, its name whole (with the roadmap's own milestone, one row).
  expect(await itemsOf(page, "M7 · Launch (beta) · 3 items")).toEqual([["Alert history export", "Alert routing by team", "Weekly alert digest"]]);
  expect(await itemsOf(page, "M6 · 2 items")).toEqual([["Health log", "Setup reminders"]]);
  // Two PRDs' "Pilot" on one day: two rows, each with its own new code (never sharing one code).
  expect(await itemsOf(page, "M4 · Pilot · 2 items")).toEqual([["Lead list ranking", "Refund in one step"]]);
  expect(await itemsOf(page, "M5 · Pilot · 2 items")).toEqual([["Complaint early warning", "Rep call script hints"]]);
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

/*
 * protects = a pilot PRD's milestone, opened on the roadmap, names the PRD's owner (its track's
 * owner, Ivo Lindqvist); fails_when = it reads "the PRD's owner".
 */
test("a pilot PRD's milestone names its owner on the roadmap", async ({ page }) => {
  await home(page, 1440);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  // roadmap-milestone-codes: the two PRDs' "Pilot" each read their own roadmap code.
  const labels = page.getByTestId("ms-prd-label").filter({ hasText: /^M\d+ Pilot/ });
  await expect(labels).toHaveCount(2);
  const owned: string[] = [];
  for (let i = 0; i < 2; i++) {
    await labels.nth(i).click();
    const prd = page.getByTestId("ms-prd-card");
    await expect(prd).toContainText("From the PRD Pilot plan");
    owned.push((await prd.locator("p").first().textContent()) ?? "");
    await prd.getByRole("button", { name: "Cancel" }).click();
    await expect(prd).toHaveCount(0);
  }
  expect(owned).toContain("From the PRD Pilot plan A · owned by Ivo Lindqvist");
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
  // Onboarding's own M3 (no name) and the track's M3: one row, its code alone (now M6).
  expect(labels.filter((l) => l.startsWith("M6"))).toEqual(["M6 · 2 items"]);
  // Alerts' own "[Launch (beta)]" M2 and the track's "M2 · Launch (beta)": one row (now M7).
  expect(labels.filter((l) => l.startsWith("M7 · Launch"))).toEqual(["M7 · Launch (beta) · 3 items"]);
  // Annual billing types a bare "M3": Pricing's milestone (now M8), never Onboarding's (now M6).
  expect(await itemsOf(page, "M8 · Prices live · 2 items")).toEqual([["Annual billing", "Usage meter"]]);
  expect((await itemsOf(page, "M6 · 2 items"))[0]).not.toContain("Annual billing");
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
test("two goals' old M1 on one roadmap are two rows, each its own roadmap-wide code, a track milestone across roadmaps one", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Two goals' old "M1" on Onboarding: two rows, each its own code now (roadmap-wide, never
  // repeated) and its own items; the bare "M1" typed on Welcome video (Grow retention's) is Grow
  // retention's. (The Onboarding track's "Measured" is a third row of its own, its own code too.)
  const firstRun = oneLabel(labels, /^M\d+ · First run in a day · 1 item$/);
  const returnPilot = oneLabel(labels, /^M\d+ · Return pilot · 2 items$/);
  const measured = oneLabel(labels, /^M\d+ · Measured · 3 items$/);
  const launchBeta = oneLabel(labels, /^M\d+ · Launch \(beta\) · 3 items$/);
  const rulesReady = oneLabel(labels, /^M\d+ · Rules ready · 2 items$/);
  const codes = [firstRun, returnPilot, measured, launchBeta, rulesReady].map((l) => l.match(/^M(\d+)/)![1]);
  expect(new Set(codes).size, codes.join(" / ")).toBe(5);
  expect(await itemsOf(page, firstRun)).toEqual([["Setup checklist"]]);
  expect(await itemsOf(page, returnPilot)).toEqual([["Sample data import", "Welcome video"]]);
  // The Alerts track's "Launch (beta)" holds an item from each of two roadmaps: one row.
  expect(await itemsOf(page, launchBeta)).toEqual([["Alert history export", "Alert sound settings", "Partner invite links"]]);
  // Alerts' own M3 (no name) and the track's "Rules ready": one row, the track's name kept.
  expect(await itemsOf(page, rulesReady)).toEqual([["Alert rules engine", "Mobile alert push"]]);
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
test("a track milestone is one row across roadmaps, two goals' M3 beside it two rows of their own code", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Alerts' own "[Launch (beta)]" M2 is Alerts' only M2: it joins the track's row, which holds Onboarding's item too.
  const launchBeta = oneLabel(labels, /^M\d+ · Launch \(beta\) · 4 items$/);
  expect(await itemsOf(page, launchBeta)).toEqual([["Alert history export", "Alert routing by team", "Partner invite links", "Weekly alert digest"]]);
  // Pricing: two goals' M3 (no names) and the track's "Prices live": three rows, none borrowing the track's name.
  const pricesLive = oneLabel(labels, /^M\d+ · Prices live · 2 items$/);
  expect(await itemsOf(page, pricesLive)).toEqual([["Annual billing", "Usage meter"]]);
  const twins = labels.filter((l) => /^M\d+ · 1 item$/.test(l));
  expect(twins, labels.join(" / ")).toHaveLength(3);
  expect(new Set(twins).size, twins.join(" / ")).toBe(3); // three distinct codes, never a repeat.
  const twinItems: string[] = [];
  for (const l of twins) twinItems.push(...(await itemsOf(page, l)).flat());
  twinItems.sort();
  expect(twinItems).toEqual(["Refund rules", "Seat bundles", "Volume discounts"]);
  // The look-alike rows (same words, each its own code) sound different, even for a goal no loaded item carries.
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M\d+ · 1 item$/ }) });
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
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const measured = oneLabel(labels, /^M\d+ · Measured · 3 items$/);
  expect(await itemsOf(page, measured)).toEqual([["Health log", "Usage map", "Usage report"]]);
  const loose = (await itemsOf(page, "Not in a milestone · 17 items"))[0];
  expect(loose).not.toContain("Usage report");
  expect(loose).not.toContain("Usage map");
  const firstRun = oneLabel(labels, /^M\d+ · First run in a day · 1 item$/);
  const returnPilot = oneLabel(labels, /^M\d+ · Return pilot · 2 items$/);
  for (const other of [firstRun, returnPilot]) expect((await itemsOf(page, other))[0]).not.toContain("Usage report");
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
  const measured = oneLabel(labels, /^M\d+ · Measured · 2 items$/);
  const other = oneLabel(labels, /^M\d+ · Other · 2 items$/);
  const firstAlerts = oneLabel(labels, /^M\d+ · First alerts · 2 items$/);
  expect(await itemsOf(page, measured)).toEqual([["Alert snooze", "Health log"]]);
  expect(await itemsOf(page, other)).toEqual([["Alert sounds", "Welcome tips"]]);
  // Alerts has its own M1 of no goal: Alert badges is there.
  expect(await itemsOf(page, firstAlerts)).toEqual([["Alert badges", "Alert rules engine"]]);
  // Onboarding has none: Usage report (its track has no M1) and Setup FAQ (no track) are in no milestone.
  const none = labels.find((l) => l.startsWith("Not in a milestone"));
  expect(none, labels.join(" / ")).toBeTruthy();
  const [loose] = await itemsOf(page, none!);
  expect(loose).toEqual(expect.arrayContaining(["Usage report", "Setup FAQ"]));
});

/*
 * Card home-milestone-names-kept (reviews of PR 1439), on "home-milestones-goals": protects = a
 * goal's milestone, its roadmap's only one of a code, joins a track's row only when their whole
 * names match or one has none (one of no goal joins whatever its name: home-milestone-fold), so Alerts' "M2 · Fleet pilot" stays its own row beside the track's "M2 · Launch (beta)";
 * an item whose own goal has no M2 (Alert sound settings) stays on its track's row, never joining
 * the one other goal's; fails_when = "Fleet pilot" shows nowhere on Home, or Alert sound settings
 * sits under it.
 */
test("a roadmap milestone of another name keeps its own row; a typed code never joins another goal's", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const fleetPilot = oneLabel(labels, /^M\d+ · Fleet pilot · 1 item$/);
  const launchBeta = oneLabel(labels, /^M\d+ · Launch \(beta\) · 3 items$/);
  expect(fleetPilot.match(/^M\d+/)![0]).not.toBe(launchBeta.match(/^M\d+/)![0]);
  expect(await itemsOf(page, fleetPilot)).toEqual([["Alert routing by team"]]);
  expect((await itemsOf(page, launchBeta))[0]).toContain("Alert sound settings");
});

/*
 * Card home-milestone-fold (the owner's of Nov 9), on "home-milestones-fold": protects = a
 * roadmap's own milestone of no goal folds into the track milestone of its code whatever its name:
 * one row with the longer name ("M1 · Measured and mapped", the owner's "Join whenever names
 * match"), its (i) listing every item and naming the track's ("Also: M1 Measured"); a goal's
 * milestone of that code ("M1 · Return pilot") keeps its own row; fails_when = "M1 · Measured" is
 * a row of its own, the other name shows nowhere, or the goal's M1 joins the track's row.
 */
test("a roadmap's own milestone of another name folds into the track's row of its code; a goal's stays apart", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const measured = oneLabel(labels, /^M\d+ · Measured and mapped · 3 items$/);
  expect(labels.filter((l) => /^M\d+ · Measured · /.test(l))).toEqual([]);
  const returnPilot = oneLabel(labels, /^M\d+ · Return pilot · 1 item$/);
  expect(measured.match(/^M\d+/)![0]).not.toBe(returnPilot.match(/^M\d+/)![0]);
  expect(await itemsOf(page, measured)).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M\d+ · Measured and mapped · 3 items$/ }) });
  await line.getByTestId("home-strip-items-tip").click();
  // The other name still shows in its (i), whatever the row's own code now is.
  await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(`Also: ${measured.split(" · ")[0]} Measured`);
  await page.keyboard.press("Escape");
  expect(await itemsOf(page, returnPilot)).toEqual([["Welcome video"]]);
});

/*
 * Card home-milestone-prd-fold (the owner's "One M1 row, as after train AX"), on
 * "home-milestones-prd-fold": protects = a PRD's own milestone of no goal folds into the track
 * milestone of its code whatever its name: one row "M1 · Measured and mapped" with the PRD's date
 * (Nov 20), its (i) listing both milestones' items and naming the PRD's ("Also: M1 Measured");
 * fails_when = "M1 · Measured" is a row of its own, or the PRD's name shows nowhere.
 */
test("a PRD's own milestone of another name folds into the track's row of its code", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_PRD_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => l.startsWith("M1"))).toEqual(["M1 · Measured and mapped · 3 items"]);
  expect(await itemsOf(page, "M1 · Measured and mapped · 3 items")).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M1 · Measured and mapped · 3 items$/ }) });
  await expect(line).toContainText("Nov 20");
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip")).toContainText("Also: M1 Measured");
});

/*
 * Card home-milestone-prds-fold (review of PR 1489), on "home-milestones-prds-fold": protects =
 * every PRD's own milestone of no goal joins the track milestone of its code, whatever its name:
 * one row "M1 · Measured and mapped", dated the earliest joined date (Nov 12), its (i) naming
 * both PRDs' names; fails_when = two PRDs' M1 keep rows of their own, or the row reads Nov 20.
 */
test("two PRDs' own milestones of no goal fold into the one track row of their code", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_PRDS_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => l.startsWith("M1"))).toEqual(["M1 · Measured and mapped · 3 items"]);
  expect(await itemsOf(page, "M1 · Measured and mapped · 3 items")).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M1 · Measured and mapped · 3 items$/ }) });
  await expect(line).toContainText("Nov 12");
  await expect(line).not.toContainText("Nov 20");
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip")).toContainText("M1 Measured");
  await expect(line.getByRole("tooltip")).toContainText("M1 Mapped");
});

/*
 * Card home-milestone-plain-fold (review of PR 1489, a regression against main), on
 * "home-milestones-plain-fold": protects = the roadmap's own M1 of no goal still joins the track's
 * M1 beside a PRD's M1 of no goal, and so does the PRD's: one M1 row; fails_when = any of the
 * three is a row of its own.
 */
test("the roadmap's own and a PRD's milestones of no goal fold into the one track row of their code", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_PLAIN_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => l.startsWith("M1"))).toEqual(["M1 · Measured and mapped · 3 items"]);
  expect(await itemsOf(page, "M1 · Measured and mapped · 3 items")).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
});

/*
 * Card home-milestone-prd-goal-fold (the owner's "One M1 row" and "Keep joining when names
 * match"), on "home-milestones-prd-goal-fold": protects = a PRD's own milestone under a goal
 * joins the track milestone of its code when one name's words lead the other's ("Measured",
 * "Measured and mapped"): one row "M1 · Measured and mapped", its (i) naming the PRD's ("Also: M1
 * Measured"); a goal's "M3 · Daily scoreboard" beside the track's "M3 · 200 replied threads"
 * keeps its own row; fails_when = "M1 · Measured" is a row of its own, or the two M3 rows join.
 */
test("a PRD's own goal milestone whose name leads the track's folds into the track's row", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_PRD_GOAL_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => l.startsWith("M1"))).toEqual(["M1 · Measured and mapped · 3 items"]);
  expect(await itemsOf(page, "M1 · Measured and mapped · 3 items")).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M1 · Measured and mapped · 3 items$/ }) });
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip")).toContainText("Also: M1 Measured");
  // "Daily scoreboard" and "200 replied threads" are names that do not match: two rows, never one,
  // each its own code now (roadmap-wide, so they need not both read "M3" any more).
  const scoreboard = oneLabel(labels, /^M\d+ · Daily scoreboard · 1 item$/);
  const replies = oneLabel(labels, /^M\d+ · 200 replied threads · 1 item$/);
  expect(scoreboard.match(/^M\d+/)![0]).not.toBe(replies.match(/^M\d+/)![0]);
});

/*
 * Card home-milestone-goals-fold, on "home-milestones-goals-fold" (the owner's "Join whenever
 * names match", Nov 9): protects = a PRD's own M1 "Measured" under a goal joins the track's "M1 ·
 * Measured and mapped" beside another goal's "M1 · First wins" on one roadmap: one row with the
 * longer name, the other in its (i) ("Also: M1 Measured"), and First wins its own row and code;
 * fails_when = "Measured" is a row of its own (the old rule: the roadmap's only one of its old
 * code), a name shows nowhere, two rows share a code, or an item sits in the wrong row.
 */
test("a goal milestone joins the track's of a matching name beside another goal's of its old code, no name hidden", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_GOALS_FOLD_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => /^M\d+ · Measured · /.test(l))).toEqual([]);
  const wins = oneLabel(labels, /^M\d+ · First wins · 1 item$/);
  const mapped = oneLabel(labels, /^M\d+ · Measured and mapped · 3 items$/);
  expect(wins.split(" · ")[0]).not.toBe(mapped.split(" · ")[0]);
  expect(await itemsOf(page, mapped)).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  expect(await itemsOf(page, wins)).toEqual([["Welcome video"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: mapped }) });
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(`Also: ${mapped.split(" · ")[0]} Measured`);
});

/*
 * Card home-milestone-bare-track (review of PR 1489; the owner's "Join whenever names match",
 * Nov 9), on "home-milestones-bare-track": protects = a bare-code track milestone ("M1") takes
 * Onboarding's own "M1 · Measured" (of no goal, its roadmap's one track of the code), and
 * Faster activation's "M1 · Measured and mapped" is that milestone too (its name leads it): one
 * row with the longer name, the other in its (i); fails_when = two rows, or a name shows nowhere.
 */
test("a bare-code track takes a goal's milestone beside one of no goal: one row, the longer name, the other in its (i)", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_BARE_TRACK_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => /^M\d+ · Measured · /.test(l))).toEqual([]);
  const mapped = oneLabel(labels, /^M\d+ · Measured and mapped · 3 items$/);
  expect(await itemsOf(page, mapped)).toEqual([["Health log", "Sample data import", "Setup checklist"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: mapped }) });
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(`Also: ${mapped.split(" · ")[0]} Measured`);
});

/*
 * Card home-milestone-lead-goals (review of PR 1489; the owner's "Join whenever names match",
 * Nov 9), on "home-milestones-lead-goals": protects = two goals' milestones of one old code
 * ("M1 · Measured", "M1 · Measured and") whose names lead the track's "M1 · Measured and mapped"
 * both join it: one row, its (i) listing each other name once; fails_when = a name shows
 * nowhere or as a row of its own.
 */
test("two goals' milestones of one old code whose names lead the track's join its row, each other name once in its (i)", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_LEAD_GOALS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(labels.filter((l) => /^M\d+ · Measured( and)? · /.test(l))).toEqual([]);
  const mapped = oneLabel(labels, /^M\d+ · Measured and mapped · 3 items$/);
  expect(await itemsOf(page, mapped)).toEqual([["Health log", "Setup checklist", "Welcome video"]]);
  const code = mapped.split(" · ")[0];
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: mapped }) });
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(`Also: ${code} Measured, ${code} Measured and`);
});

/*
 * Card home-milestone-two-roadmaps, on "home-milestones-two-roadmaps" (and "-swapped", Alerts'
 * milestones first): protects = each roadmap's milestones join the Guided setup track's bare "M1"
 * on their own, so Onboarding's "M1 · Measured" and Alerts' "M1 · Rules ready" both join its one
 * row, the longer name shown ("Rules ready", the owner's "Join whenever names match"), the other
 * in its (i), whichever roadmap comes first; fails_when = a name one roadmap lent the track
 * decides the other roadmap's (a name its own row, or the rows differ by order).
 */
for (const scenario of [HOME_MILESTONE_TWO_ROADMAPS_SCENARIO, HOME_MILESTONE_TWO_ROADMAPS_SWAPPED_SCENARIO]) {
  test(`each roadmap's milestone joins a bare-code track on its own, whichever roadmap comes first (${scenario})`, async ({ page }) => {
    await home(page, 1440, ADMIN.email, scenario);
    const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    // roadmap-milestone-codes: the row reads the track's roadmap code and the longer name; "Measured" has no row of its own.
    const rules = oneLabel(labels, /^M\d+ · Rules ready · 4 items$/);
    expect(labels.filter((l) => /Measured/.test(l))).toEqual([]);
    expect(await itemsOf(page, rules)).toEqual([["Alert rules engine", "Alert snooze", "Health log", "Setup checklist"]]);
    const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: rules }) });
    await line.getByTestId("home-strip-items-tip").click();
    await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(`Also: ${rules.split(" · ")[0]} Measured`);
  });
}

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
  await expect(next).toContainText(/M\d+ · Fleet pilot ·/);
  await expect(next).not.toContainText("[");
  await expect(page.getByTestId("home-strip-label").filter({ hasText: /^M\d+ · Fleet pilot · 1 item$/ })).toBeVisible();
});

/*
 * Card home-nameless-track-names-kept (reviews of PR 1439), on "home-milestones-tracks": protects =
 * a nameless track milestone ("M3", holding items on Onboarding and Alerts) takes the name of a
 * roadmap milestone that joins it on each roadmap, a name one roadmap lent never deciding the
 * other's: Onboarding's "M3 · Guided tour" and Alerts' "M3 · Quiet hours" both join its one row,
 * the other name in its (i); fails_when = "Quiet hours" shows nowhere on Home.
 */
test("a nameless track milestone takes one joined name; another roadmap's other name is in its (i)", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // roadmap-milestone-codes: a roadmap's own milestone of no goal on the track's code is that one
  // milestone (one roadmap code), so another roadmap's "Quiet hours" joins the row too.
  const guidedTour = oneLabel(labels, /^M\d+ · Guided tour · 4 items$/);
  expect(await itemsOf(page, guidedTour)).toEqual([["Alert snooze", "Health log", "Mobile alert push", "Setup reminders"]]);
  const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: guidedTour }) });
  await line.getByTestId("home-strip-items-tip").click();
  await expect(line.getByRole("tooltip").getByText(/^Also: /)).toHaveText(/^Also: M\d+ Quiet hours$/);
});

/*
 * Card home-twin-rows-no-whose (review of PR 1439), on "home-milestones-tracks": protects = two
 * rows that read alike and whose goal no loaded item names (Keep alerts quiet's and Fewer refunds'
 * nameless M3) are told apart by their first item; fails_when = both sound the same.
 */
test("two look-alike rows with no known goal sound apart by their first item", async ({ page }) => {
  await home(page, 1440, ADMIN.email, HOME_MILESTONE_TRACKS_SCENARIO);
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M\d+ · 1 item$/ }) });
  await expect(lines).toHaveCount(3);
  const links = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1, 2].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  // Each its own roadmap code now, so they never sound alike.
  expect(new Set(links).size, links.join(" / ")).toBe(3);
  expect(new Set(tips).size, tips.join(" / ")).toBe(3);
});

/*
 * Card home-twin-rows-named (review of PR 1439; roadmap-milestone-codes, Nov 9, means the two
 * PRDs' "Pilot" rows never share one code any more, so they no longer read exactly alike):
 * protects = two rows for the same milestone name (two PRDs' "Pilot", each its own roadmap-wide
 * code) still have their own distinct accessible names on their links and (i) buttons;
 * fails_when = a screen reader hears the same name for both, or there is only one "Pilot" row.
 */
test("two rows for the same milestone name, each its own code, have distinct accessible names", async ({ page }) => {
  await home(page, 1440);
  const labels = (await page.getByTestId("home-strip-label").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const pilots = labels.filter((l) => /^M\d+ · Pilot · 2 items$/.test(l));
  expect(pilots, labels.join(" / ")).toHaveLength(2);
  expect(new Set(pilots).size, pilots.join(" / ")).toBe(2); // never the same code twice.
  const lines = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M\d+ · Pilot · 2 items$/ }) });
  await expect(lines).toHaveCount(2);
  const links = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-row").getAttribute("aria-label")));
  const tips = await Promise.all([0, 1].map((k) => lines.nth(k).getByTestId("home-strip-items-tip").getAttribute("aria-label")));
  expect(new Set(links).size, links.join(" / ")).toBe(2);
  expect(new Set(tips).size, tips.join(" / ")).toBe(2);
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
    const line = page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: /^M8 · Prices live · 2 items$/ }) });
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

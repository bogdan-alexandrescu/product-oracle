import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { TRACKS } from "../lib/api/mock/simple-roadmap";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * tb-mk (the owner's picks: track bands C "Name, goal, health tick"; milestone kinds B "Icon in the
 * label"), on invented data (the mock's "roadmap-milestones" scenario; the mock's today is Nov 3, 2026).
 *
 * Card roadmap-track-bands: protects = the Timeline draws one band per track in the tracks' order,
 * then No track; each band's header names its track and goal and ends with a health tick or
 * warning whose tooltip says why; fails_when = the bands are goals, or a header lacks the goal or mark.
 * Card milestone-kind-label: protects = each Milestones band label leads with its kind's icon and
 * ends with its status mark, its tooltip naming kind, status and reason; fails_when = no icon or mark.
 * Card milestone-kind-handoff: protects = the panel changes a milestone's kind to Hand-off and sets
 * its From and To tracks, kept after a reload; fails_when = the kind or the tracks are not saved.
 * Card milestone-kind-first: protects = "+ Milestone" asks for the kind first and the new milestone
 * has that kind; fails_when = the card opens with no kind asked.
 *
 * Fidelity to the picks (tb-variants ?tb=c, mk-variants ?mk=b):
 * Card tb-phone-list: protects = on a phone, an item row in a band reads its dates only, the No
 * track band reads "No track", and each quarter's milestone row leads with its kind's icon and ends
 * with its status mark; fails_when = a row carries its goal, or a milestone row is a plain diamond.
 * Card tb-no-track-head: protects = the desktop Timeline's No track header reads "No track" with no
 * count at 3 and 6 months; fails_when = it reads "No track · N items".
 * Card ms-axis-clear: protects = an approved milestone's chip never lies under a band diamond, and at
 * 6 months no band label is cut to its code; fails_when = they overlap, or a label reads "M…".
 * Card tb-phone-gantt-long: protects = a long track name in the phone Gantt ends in an ellipsis with
 * its health mark and goal line in view; fails_when = the name pushes them out of its column.
 * Card ms-tip-words: protects = a label's tooltip reads "Builds toward <goal>", "Served by N items"
 * and its measure line; fails_when = it reads "Advances" or "Waits on", or lacks the measure.
 * Card ms-panel-rows: protects = the panel sets Date and Track side by side (a hand-off: its From and
 * To instead), Builds toward and Sub-goal of side by side under the measure, the Track kept after a
 * reload; fails_when = they stack, or the Track is lost.
 *
 * Review round (PR 1499):
 * Card ms-measured-fields: protects = a measured milestone's panel reads Measure, Start, Target,
 * Builds toward, Sub-goal of, its sub-goals and the work that serves it, never "Baseline";
 * fails_when = a field is missing or named Baseline.
 * Card ms-kind-clears: protects = a save after switching kind drops the old kind's fields, and a
 * status put back to On track drops its reason; fails_when = they come back when the kind or status does.
 * Card ms-every-kind-diamond: protects = a milestone of each of the six kinds has its diamond on
 * the axis; fails_when = a kind draws none.
 * Card ms-band-more-close: protects = the band's +N list closes on Escape (focus back on +N) and on
 * a click outside it; fails_when = it stays open.
 * Card tb-health-mark: protects = a track's header mark turns from a tick to a warning when a
 * milestone it serves moves before its work ends; fails_when = the mark does not change.
 * Card ms-touch-reason: protects = on touch, the panel's Status (i) gives Oracle's reason and the
 * kind picker's (i) each kind's meaning; the picker is a listbox the arrow keys move along;
 * fails_when = the reason or meanings are hover-only, or the arrow keys do nothing.
 */

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "roadmap-milestones"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-band")).toBeVisible();
}

const lanes = (page: Page) => page.getByTestId("timeline-lane");
const label = (page: Page, start: string) => page.getByTestId("ms-label").filter({ hasText: start });
const card = (page: Page) => page.getByTestId("ms-card");
/** A milestone's diamond on the axis, by its name (its title: "<code> <name>, <day>"). */
const diamond = (page: Page, name: string) => page.locator(`[data-testid="ms-diamond"][title*=" ${name},"]`).first();

test.describe("Roadmap: track bands and milestone kinds", () => {
  test("the Timeline's bands are the tracks, in order, then No track; a header names the goal and its health tick says why", async ({ page }) => {
    await open(page);
    // A person ties a track to a goal in the Tracks sheet.
    await page.getByTestId("tracks-open").click();
    const sheet = page.getByTestId("tracks-sheet");
    await sheet.getByRole("button", { name: "Change Usage alerts track" }).click();
    const row = sheet.getByTestId("track-row").filter({ has: page.getByText("Usage alerts track", { exact: true }) });
    const goal = row.getByLabel("Goal", { exact: true });
    const goalName = (await goal.locator("option").nth(1).textContent())!.trim();
    await goal.selectOption({ label: goalName });
    await expect(page.getByTestId("toasts")).toContainText(`goal is now ${goalName}`);
    await page.reload();
    await expect(page.getByTestId("ms-band")).toBeVisible();

    const names = (await lanes(page).allInnerTexts()).map((t) => t.trim());
    expect(names[0]).toContain("Usage alerts track");
    expect(names[0]).toContain(goalName);
    const none = names.findIndex((t) => t.startsWith("No track"));
    expect(none).toBeGreaterThan(0);
    // The full order: every track with work, in the Tracks order, then No track.
    const order = names.map((t) => Object.values(TRACKS).find((n) => t.startsWith(n)) ?? (t.startsWith("No track") ? "No track" : t));
    expect(order).toEqual([...Object.values(TRACKS).filter((n) => order.includes(n)), "No track", ...order.slice(none + 1)]);
    expect(order.slice(0, 2)).toEqual(["Usage alerts track", "Guided setup track"]);
    expect(names.slice(0, none).every((t) => /track/.test(t))).toBe(true);
    // No goal bands and no PM-owned band.
    expect(names.some((t) => t.startsWith("PM-owned"))).toBe(false);

    const head = lanes(page).first().getByTestId("track-head");
    const health = head.getByTestId("track-health");
    await expect(health).toHaveAttribute("data-health", /^(on_track|at_risk|stale)$/);
    await health.getByTestId("track-health-tip").hover();
    await expect(health.getByRole("tooltip")).toHaveText(/^(On track: every feature ends before its milestone|At risk: .+ ends [A-Z][a-z]{2} \d{1,2}, after M\d+ .+ on [A-Z][a-z]{2} \d{1,2}|Not checked since [A-Z][a-z]{2} \d{1,2})$/);
    // Pointing at the name shows its owner and PRDs.
    await head.getByTestId("track-name-tip").hover();
    await expect(head.getByTestId("track-name-tip").locator("xpath=..").getByRole("tooltip")).toContainText("Owner:");
  });

  // Card gantt-track-head-text: protects = a Gantt Group by Track header's text is its name and
  // goal only, the hover card's owner, PRD and health reason out of it until pointed at;
  // fails_when = the header's textContent carries "Owner:", "PRD:" or the reason.
  test("a Gantt track header reads its name and goal; its hover card shows only on hover or focus", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "gantt");
    const group = page.getByTestId("chart-group").filter({ has: page.getByTestId("track-head") }).first();
    await expect(group).toBeVisible();
    const text = (await group.textContent()) ?? "";
    expect(text).not.toContain("Owner:");
    expect(text).not.toContain("PRD:");
    expect(text).not.toMatch(/every feature ends|ends [A-Z][a-z]{2} \d{1,2}, after|Not checked since/);
    const nameTip = group.getByTestId("track-name-tip");
    expect(text.startsWith((await nameTip.innerText()).trim())).toBe(true);
    await nameTip.hover();
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toContainText("Owner:");
    await page.mouse.move(0, 0);
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toBeHidden();
    // A keyboard person reads it on focus.
    await nameTip.focus();
    await expect(nameTip.locator("xpath=..").getByRole("tooltip")).toContainText("PRD:");
  });

  test("a label leads with its kind's icon and ends with its status mark; its tooltip gives kind, status and why", async ({ page }) => {
    await open(page);
    const l = label(page, "M1 Alerts live for 50 teams");
    await expect(l.getByTestId("mk-icon")).toHaveAttribute("data-kind", "sub_goal");
    await expect(l.getByTestId("ms-status")).toHaveAttribute("data-status", /^(on_track|at_risk|hit|missed)$/);
    await l.hover();
    await expect(page.getByTestId("ms-tip-kind")).toHaveText(/^Sub-goal · (On track|At risk|Hit|Missed)$/);
    await expect(page.getByTestId("ms-tip-reason")).not.toBeEmpty();
    // The legend behind the band's (i) names every kind and mark.
    await page.getByTestId("ms-legend-tip").hover();
    const legend = page.getByTestId("mk-legend");
    for (const w of ["Goal", "Sub-goal", "Delivery", "Decision", "Outside date", "Hand-off", "On track", "At risk", "Hit", "Missed"]) await expect(legend).toContainText(w);
  });

  test("the panel makes a milestone a hand-off from one track to another, kept after a reload", async ({ page }) => {
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").click();
    await expect(card(page)).toBeVisible();
    await card(page).getByLabel("Kind").selectOption({ label: "Hand-off" });
    await expect(card(page).getByLabel("Measure")).toHaveCount(0);
    await card(page).getByLabel("From track").selectOption({ label: "Usage alerts track" });
    await card(page).getByLabel("To track").selectOption({ label: "Guided setup track" });
    await card(page).getByLabel("Done when").fill("Setup reads alert rules in test");
    await card(page).getByLabel("Status").selectOption({ label: "At risk" });
    await card(page).getByLabel("Why").fill("Rules API is late");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("ms-toast")).toContainText("saved");

    await page.reload();
    const l = label(page, "M1 Alerts live for 50 teams");
    await expect(l.getByTestId("mk-icon")).toHaveAttribute("data-kind", "handoff");
    await expect(l.getByTestId("ms-status")).toHaveAttribute("data-status", "at_risk");
    await l.hover();
    await expect(page.getByTestId("ms-tip-kind")).toHaveText("Hand-off · Usage alerts track → Guided setup track · At risk");
    await expect(page.getByTestId("ms-tip-reason")).toHaveText("Rules API is late");
    await l.click();
    await expect(card(page).getByLabel("Kind")).toHaveValue("handoff");
    await expect(card(page).getByLabel("From track")).toHaveValue(/.+/);
    await expect(card(page).getByLabel("Done when")).toHaveValue("Setup reads alert rules in test");
  });

  test("+ Milestone asks for the kind first; the new milestone has it", async ({ page }) => {
    await open(page);
    await page.getByTestId("zoom-6m").click();
    const axis = page.getByTestId("ms-axis").first();
    const box = (await axis.boundingBox())!;
    const seen = await axis.evaluate((el) => {
      let sc = el.parentElement;
      while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      const r = (sc ?? document.body).getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const from = Math.max(box.x, seen.left);
    const at = { x: from + (Math.min(box.x + box.width, seen.right) - from) * 0.6, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);
    await expect(page.getByTestId("ms-ghost-words")).toBeVisible();
    await page.mouse.click(at.x, at.y);
    const picker = page.getByTestId("ms-kind-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId("ms-card")).toHaveCount(0);
    // A listbox, one tab stop: the arrow keys move along the kinds (two columns), Enter picks.
    const options = picker.getByRole("listbox", { name: "Kind" }).getByRole("option");
    await expect(options).toHaveCount(6);
    await options.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(2)).toBeFocused();
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(picker.getByRole("option", { name: "Decision" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card(page).getByLabel("Kind")).toHaveValue("decision");
    await card(page).getByLabel("Name").fill("Pick the alert sound");
    await card(page).getByLabel("Date").fill("2027-03-10");
    await card(page).getByLabel("Done when").fill("The sound is picked");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("ms-label").filter({ hasText: "Pick the alert sound" }).getByTestId("mk-icon")).toHaveAttribute("data-kind", "decision");
  });

  test("on a phone the quarter list reads each row's dates only, No track bare, and each milestone with its kind's icon and status mark", async ({ page }) => {
    await open(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("timeline-list")).toBeVisible();
    // Each item row in a band: its dates only (its goal is in the band's header).
    const dates = page.getByTestId("timeline-row-dates");
    expect(await dates.count()).toBeGreaterThan(3);
    for (const t of await dates.allInnerTexts()) expect(t.trim()).toMatch(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})? – [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
    // The No track band reads just "No track", as the track bands' headers name no count.
    const bands = (await page.getByTestId("timeline-band").allInnerTexts()).map((t) => t.trim());
    expect(bands).toContain("No track");
    expect(bands.some((t) => /^No track .*item/.test(t))).toBe(false);
    // Each quarter's milestone row: its kind's icon first, its status mark last, the reason in its tap text.
    const row = page.getByTestId("ms-quarter-row").first();
    await expect(row.getByTestId("mk-icon")).toHaveAttribute("data-kind", /^(goal|sub_goal|delivery|decision|outside|handoff)$/);
    await expect(row.getByTestId("ms-status")).toHaveAttribute("data-status", /^(on_track|at_risk|hit|missed)$/);
    await expect(row).toHaveAttribute("title", /^(Goal|Sub-goal|Delivery|Decision|Outside date|Hand-off) · (On track|At risk|Hit|Missed)/);
    await expect(page.getByTestId("ms-quarter").locator("i.rotate-45")).toHaveCount(0);
  });

  test("the No track header reads No track with no count, at 3 and 6 months", async ({ page }) => {
    await open(page);
    for (const z of ["3m", "6m"]) {
      await page.getByTestId(`zoom-${z}`).click();
      const none = lanes(page).filter({ hasText: /^No track/ });
      await expect(none).toHaveCount(1);
      await expect(none).toHaveText("No track");
    }
  });

  test("the axis: an approved milestone's chip clears every diamond; at 6 months no band label is cut to its code", async ({ page }) => {
    await open(page);
    const boxes = async (id: string) => (await page.getByTestId(id).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom }))));
    for (const z of ["3m", "6m"]) {
      await page.getByTestId(`zoom-${z}`).click();
      await expect(page.getByTestId("timeline-milestone").first()).toBeVisible();
      const chips = await boxes("timeline-milestone");
      const gems = [...(await boxes("ms-diamond")), ...(await boxes("ms-prd-diamond"))];
      expect(gems.length).toBeGreaterThan(0);
      for (const c of chips) for (const g of gems) expect(c.r <= g.l || c.l >= g.r || c.b <= g.t || c.t >= g.b, `chip ${JSON.stringify(c)} on diamond ${JSON.stringify(g)}`).toBe(true);
    }
    // 6 months: each label keeps more than its code ("M3 F…", never "M…").
    const widths = await page.getByTestId("ms-label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThan(4);
    for (const w of widths) expect(w).toBeGreaterThan(70);
  });

  test("on a phone the Gantt's long track name ends in an ellipsis, its health mark and goal in view", async ({ page }) => {
    await open(page);
    await page.getByTestId("tracks-open").click();
    const sheet = page.getByTestId("tracks-sheet");
    await sheet.getByRole("button", { name: "Change Usage alerts track" }).click();
    const long = "Usage alerts and partner marketplace listings track";
    await sheet.getByRole("button", { name: "Rename Usage alerts track" }).click();
    await sheet.getByLabel("Track name").fill(long);
    await sheet.getByLabel("Track name").press("Enter");
    const row = sheet.getByTestId("track-row").filter({ has: page.getByText(long, { exact: true }) });
    const goal = row.getByLabel("Goal", { exact: true });
    const goalName = (await goal.locator("option").nth(1).textContent())!.trim();
    await goal.selectOption({ label: goalName });
    await expect(page.getByTestId("toasts")).toContainText(`goal is now ${goalName}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByTestId("format-gantt").click();
    const group = page.getByTestId("chart-group").filter({ hasText: long.slice(0, 8) }).first();
    await expect(group).toBeVisible();
    const box = (await group.boundingBox())!;
    const name = group.getByTestId("track-name-tip").locator("span").first();
    expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    const mark = (await group.getByTestId("track-health").boundingBox())!;
    expect(mark.x + mark.width).toBeLessThanOrEqual(box.x + box.width);
    expect(mark.width).toBeGreaterThan(4);
    const goalLine = group.getByText(goalName, { exact: true });
    await expect(goalLine).toBeVisible();
    const g = (await goalLine.boundingBox())!;
    expect(g.y + g.height).toBeLessThanOrEqual(box.y + box.height + 1);
  });

  test("a label's tooltip reads Builds toward, Served by and its measure line", async ({ page }) => {
    await open(page);
    const l = label(page, "M1 Alerts live for 50 teams");
    await l.hover();
    const tip = page.getByTestId("ms-band-tip");
    await expect(tip).toContainText(/Builds toward \S/);
    await expect(tip).toContainText(/Served by \d+ items?/);
    await expect(tip).not.toContainText("Advances");
    await expect(tip).not.toContainText("Waits on");
    await l.click();
    await card(page).getByLabel("Measure").fill("Teams set up");
    await card(page).getByLabel("Start", { exact: true }).fill("35");
    await card(page).getByLabel("Target").fill("60");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await label(page, "M1 Alerts live for 50 teams").hover();
    await expect(page.getByTestId("ms-tip-done")).toHaveText(/^Teams set up: 35 → 60( \(now .+\))?$/);
  });

  test("the panel sets Date and Track side by side, Builds toward and Sub-goal of under the measure; the Track holds after a reload", async ({ page }) => {
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").click();
    const c = card(page);
    const dateRow = c.getByTestId("ms-date-row");
    const top = async (l: ReturnType<Page["getByTestId"]>) => (await l.boundingBox())!.y;
    // Two fields side by side: the row's two labels (Date | Track; Builds toward | Sub-goal of) share a top.
    const pair = async (row: ReturnType<Page["getByTestId"]>, a: string, b: string) => {
      const fields = row.locator(":scope > label");
      await expect(fields).toHaveCount(2);
      await expect(fields.nth(0)).toContainText(a);
      await expect(fields.nth(1)).toContainText(b);
      expect(Math.abs((await top(fields.nth(0))) - (await top(fields.nth(1))))).toBeLessThan(2);
    };
    await pair(dateRow, "Date", "Track");
    const toward = c.getByTestId("ms-toward-row");
    await pair(toward, "Builds toward", "Sub-goal of");
    expect(await top(toward)).toBeGreaterThan(await top(c.getByTestId("ms-measure")));
    await dateRow.getByLabel("Track").selectOption({ label: "Guided setup track" });
    await c.getByTestId("ms-save").click();
    await expect(c).toBeHidden();
    await page.reload();
    await label(page, "M1 Alerts live for 50 teams").click();
    await expect(card(page).getByTestId("ms-date-row").getByLabel("Track").locator("option:checked")).toHaveText("Guided setup track");
    // A hand-off names its From and To tracks instead.
    await card(page).getByLabel("Kind").selectOption({ label: "Hand-off" });
    await expect(card(page).getByTestId("ms-date-row").getByLabel("Track")).toHaveCount(0);
    await expect(card(page).getByLabel("From track")).toBeVisible();
    await expect(card(page).getByLabel("To track")).toBeVisible();
  });

  test("a measured milestone's panel reads Measure, Start, Target, Builds toward, Sub-goal of, its sub-goals and the work that serves it", async ({ page }) => {
    await open(page);
    // M3 becomes a measured goal M1 builds toward.
    await diamond(page, "Teams set 3 rules in week 1").click();
    await card(page).getByLabel("Kind").selectOption({ label: "Goal" });
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await label(page, "M1 Alerts live for 50 teams").click();
    const c = card(page);
    for (const f of ["Measure", "Start", "Target", "Builds toward", "Sub-goal of"]) await expect(c.getByLabel(f, { exact: true })).toBeVisible();
    await expect(c.getByLabel("Baseline")).toHaveCount(0);
    await expect(c.getByTestId("ms-toward-row").locator("select").first()).toHaveAccessibleName("Builds toward");
    await expect(c).not.toContainText("Baseline");
    await expect(c.getByTestId("ms-waits-on")).toContainText("Work that serves it");
    await expect(c.getByTestId("ms-waits-chip")).toHaveCount(1);
    await expect(c.getByTestId("ms-waits-chip")).toContainText("Alert rules engine");
    await c.getByLabel("Sub-goal of").selectOption({ label: (await c.getByLabel("Sub-goal of").locator("option", { hasText: "Teams set 3 rules in week 1" }).textContent())!.trim() });
    await c.getByTestId("ms-save").click();
    await expect(c).toBeHidden();
    // The goal lists it among its sub-goals.
    await diamond(page, "Teams set 3 rules in week 1").click();
    await expect(c.getByLabel("Measure")).toBeVisible();
    await expect(c.getByLabel("Sub-goal of")).toHaveCount(0);
    await expect(c.getByTestId("ms-subs")).toContainText("Sub-goals");
    await expect(c.getByTestId("ms-subs")).toContainText(/M\d+ Alerts live for 50 teams/);
  });

  test("a save after switching kind drops the old kind's fields; a status back on track drops its reason", async ({ page }) => {
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").click();
    const c = card(page);
    await c.getByLabel("Measure").fill("Teams set up");
    await c.getByLabel("Start", { exact: true }).fill("35");
    await c.getByLabel("Target", { exact: true }).fill("60");
    await c.getByLabel("Status").selectOption({ label: "At risk" });
    await c.getByLabel("Why").fill("Rules API is late");
    await c.getByTestId("ms-save").click();
    await expect(c).toBeHidden();
    await label(page, "M1 Alerts live for 50 teams").click();
    await c.getByLabel("Kind").selectOption({ label: "Delivery" });
    await c.getByLabel("Done when").fill("Alerts ship to every team");
    await c.getByLabel("Status").selectOption({ label: "On track" });
    await c.getByTestId("ms-save").click();
    await expect(c).toBeHidden();
    // Its tip no longer gives the old reason.
    await label(page, "M1 Alerts live for 50 teams").hover();
    await expect(page.getByTestId("ms-tip-kind")).toHaveText("Delivery · On track");
    await expect(page.getByTestId("ms-tip-reason")).not.toHaveText("Rules API is late");
    await page.reload();
    await label(page, "M1 Alerts live for 50 teams").click();
    await expect(c.getByLabel("Done when")).toHaveValue("Alerts ship to every team");
    // Back to a sub-goal: its old measure is gone; At risk again asks for a new reason.
    await c.getByLabel("Kind").selectOption({ label: "Sub-goal" });
    await expect(c.getByLabel("Measure")).toHaveValue("");
    await expect(c.getByLabel("Start", { exact: true })).toHaveValue("");
    await expect(c.getByLabel("Target", { exact: true })).toHaveValue("");
    await c.getByLabel("Status").selectOption({ label: "At risk" });
    await expect(c.getByLabel("Why")).toHaveValue("");
  });

  test("a milestone of each of the six kinds has its diamond on the axis", async ({ page }) => {
    await open(page);
    for (const [name, kind] of [
      ["Alerts live for 50 teams", "Hand-off"],
      ["Teams set 3 rules in week 1", "Goal"],
      ["Digest opened by 70%", "Decision"],
      ["Under 10% of teams mute alerts", "Outside date"],
    ] as const) {
      await diamond(page, name).click();
      await card(page).getByLabel("Kind").selectOption({ label: kind });
      if (kind !== "Goal") await card(page).getByLabel("Done when").fill("It is done");
      await card(page).getByTestId("ms-save").click();
      await expect(card(page)).toBeHidden();
    }
    const gems = page.locator('[data-testid="ms-diamond"], [data-testid="ms-prd-diamond"]');
    for (const kind of ["goal", "sub_goal", "delivery", "decision", "outside", "handoff"]) {
      const of = gems.and(page.locator(`[data-kind="${kind}"]`));
      expect(await of.count(), kind).toBeGreaterThan(0);
      // One diamond on its day, the diamond's own shape.
      const day = (await of.first().getAttribute("data-day"))!;
      await expect(gems.and(page.locator(`[data-day="${day}"]`))).toHaveCount(1);
      await expect(of.first().locator("i.rotate-45")).toHaveCount(1);
    }
  });

  test("the band's +N list closes on Escape and on a click outside it", async ({ page }) => {
    await open(page);
    await page.getByTestId("zoom-all").click();
    const more = page.getByTestId("ms-band-more").first();
    await expect(more).toBeVisible();
    const list = more.locator("xpath=..").getByTestId("ms-band-list");
    await more.click();
    await expect(list).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(list).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    // A click on the chart's empty band, outside the list.
    const band = (await page.getByTestId("ms-band").boundingBox())!;
    await page.mouse.click(band.x + 4, band.y + band.height - 3);
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await page.mouse.move(0, 0);
    await expect(list).toBeHidden();
  });

  test("a track's header mark turns from a tick to a warning when a milestone it serves moves before its work ends", async ({ page }) => {
    await open(page);
    const head = lanes(page).filter({ hasText: "Guided setup track" }).getByTestId("track-head");
    const health = head.getByTestId("track-health");
    await expect(health).toHaveAttribute("data-health", "on_track");
    const before = await health.innerHTML();
    // Its milestone moves to tomorrow, before the work it waits on ends.
    await diamond(page, "Half of new teams invite a teammate").click();
    await card(page).getByLabel("Date").fill("2026-11-04");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(health).toHaveAttribute("data-health", "at_risk");
    expect(await health.innerHTML()).not.toBe(before);
    await health.getByTestId("track-health-tip").hover();
    await expect(health.getByRole("tooltip")).toHaveText(/^At risk: .+ ends [A-Z][a-z]{2} \d{1,2}, after M\d+ Half of new teams invite a teammate on Nov 4$/);
  });
});

test.describe("Roadmap milestones on touch", () => {
  test.use({ hasTouch: true });

  test("on touch the panel's Status (i) gives Oracle's reason and the kind picker's (i) each kind's meaning", async ({ page }) => {
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").tap();
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c.getByLabel("Status")).toHaveValue("");
    await c.getByTestId("ms-status-why").tap();
    await expect(c.getByTestId("ms-status-why").locator("xpath=..").getByRole("tooltip")).toHaveText(/^(Every piece of work ends by its date|.+ ends [A-Z][a-z]{2} \d{1,2}, after its date [A-Z][a-z]{2} \d{1,2})$/);
    // A second tap puts it away.
    await c.getByTestId("ms-status-why").tap();
    await expect(c.getByTestId("ms-status-why").locator("xpath=..").getByRole("tooltip")).toBeHidden();
    await c.getByRole("button", { name: "Cancel" }).tap();
    await expect(c).toBeHidden();
    // + Milestone: the picker's (i) names what each kind means.
    await page.getByTestId("zoom-6m").tap();
    const axis = page.getByTestId("ms-axis").first();
    const box = (await axis.boundingBox())!;
    const seen = await axis.evaluate((el) => {
      let sc = el.parentElement;
      while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      const r = (sc ?? document.body).getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const from = Math.max(box.x, seen.left);
    await page.touchscreen.tap(from + (Math.min(box.x + box.width, seen.right) - from) * 0.6, box.y + box.height / 2);
    const picker = page.getByTestId("ms-kind-picker");
    await expect(picker).toBeVisible();
    await picker.getByTestId("ms-kind-tip").tap();
    const tips = picker.getByTestId("ms-kind-tips");
    await expect(tips).toBeVisible();
    await expect(tips).toContainText("Goal: A measured goal that must be hit, from a start to a target");
    await expect(tips).toContainText("Decision: By its date the team knows something and decides");
    await expect(tips).toContainText("Hand-off: One track delivers what another track waits on");
  });
});

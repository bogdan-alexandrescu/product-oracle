import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * build-milestones-on-roadmap (the owner's picks: 'Click the time axis', 'Card, line per goal',
 * 'Edit asks the PRD'): on Simple Roadmap a person points at the time axis ("+ Milestone on <day>"),
 * clicks to open the card, taps bars for the items it waits on and adds it; it is drawn as a diamond
 * and a line in its goal, an item ending after it is tagged "Ends after <its name>"; a drag moves it,
 * a click opens it to edit or remove, each with Undo. A PRD's milestones are hollow and dashed and a
 * change to one asks the PRD's owner. Mock scenarios "simple-milestones" and "simple-prd-milestones"
 * (invented goals, items and people; the mock's today is Nov 3, 2026).
 */

const COMMENTER = "commenter@example.com";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const SHOTS = process.env.MS_COMPARE_DIR;
// The built states beside the picked frames, light and dark: MS_COMPARE_DIR=<dir> MS_SCHEME=dark.
const SCHEME: "light" | "dark" = process.env.MS_SCHEME === "dark" ? "dark" : "light";

async function open(page: Page, scenario = "simple-milestones", scheme: "light" | "dark" = SCHEME, email?: string) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, scenario, THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}${SCHEME === "dark" ? "-dark" : ""}.png` });
};
// roadmap-milestone-codes: the band's label shows the roadmap code and name; its day is in its hover
// and focus tip and in its accessible name ("M1 Alerts live for 50 teams · Nov 20, 2026. Advances ...").
const label = (page: Page, words: string) => page.locator(`[data-testid="ms-label"][aria-label^="${words}"]`);
const card = (page: Page) => page.getByTestId("ms-card");
const toast = (page: Page) => page.getByTestId("ms-toast");
// tb-mk: + Milestone asks for the kind first (a picker headed like the card), then opens the card.
async function pickKind(page: Page, kind = "Sub-goal", head = "New milestone") {
  const picker = page.getByTestId("ms-kind-picker");
  await expect(picker.getByRole("heading", { name: head })).toBeVisible();
  await picker.getByRole("option", { name: kind }).click();
  await expect(card(page).getByRole("heading", { name: head })).toBeVisible();
}

/** A dashed line runs the chart's full height: from a saved milestone's line top to its foot, through every band. */
async function spansChart(page: Page, line: ReturnType<Page["getByTestId"]>) {
  await expect(line).toHaveCount(1);
  const box = await line.evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
  const saved = await page.getByTestId("ms-line").first().evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
  expect(Math.abs(box.top - saved.top)).toBeLessThan(2);
  expect(Math.abs(box.bottom - saved.bottom)).toBeLessThan(2);
  const lanes = await page.getByTestId("timeline-lane").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(lanes.length).toBeGreaterThan(0);
  for (const l of lanes) expect(box.top <= l.top + 1 && box.bottom >= l.bottom - 1, `line ${box.top}-${box.bottom} through band ${l.top}-${l.bottom}`).toBe(true);
}

async function pointAtAxis(page: Page, at = 0.7) {
  // The axis runs the whole chart; point at the part in sight (its scroller's box, past the names).
  const axis = page.getByTestId("ms-axis").first();
  const box = (await axis.boundingBox())!;
  const seen = await axis.evaluate((el) => {
    let sc = el.parentElement;
    while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
    const r = (sc ?? document.body).getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const from = Math.max(box.x, seen.left);
  const x = from + (Math.min(box.x + box.width, seen.right) - from) * at;
  await page.mouse.move(x, box.y + box.height / 2);
  return { x, y: box.y + box.height / 2 };
}

test.describe("milestones on the Timeline", () => {
  test.use(DESKTOP);

  test("pointing at the axis shows where; a click opens the card; tapped bars are what it waits on; Add draws it with the Ends-after tag", async ({ page }) => {
    // protects: on the Timeline at 6 months, pointing at the time axis shows "+ Milestone on <day>", a click opens the kind picker then the card, two tapped bars become the items it waits on, and Add draws it with an "Ends after" tag on the item that ends after it
    // fails_when: the axis hint is missing, the card does not open, the wait chips are not 2, the full-height dashed line is missing, the toast lacks "1 item it waits on ends after it", or the Ends-after tag or the new label is missing
    // no_claim: that anything is saved by the real API (mock only), the diamond's exact pixel place, or the phone and dark layouts; the Back to today step only checks the card stays open
    await open(page);
    // Six months shows the new milestone's day, Jan 20 (the Timeline opens on 3 months).
    await page.getByTestId("zoom-6m").click();
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toBeVisible();
    await shot(page, "ms1-a-rest");
    const at = await pointAtAxis(page);
    await expect(page.getByTestId("ms-ghost-words")).toContainText(/^\+ Milestone on [A-Z][a-z]{2} \d{1,2}, 20\d\d$/);
    await shot(page, "ms1-a-open");
    await page.mouse.click(at.x, at.y);
    // A measured step ("It counts when" is a measured kind's rule).
    await pickKind(page, "Sub-goal");
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Date").fill("2027-01-20");
    await card(page).getByLabel("Builds toward", { exact: true }).selectOption({ label: "Grow retention" });
    await page.locator('[data-testid="timeline-bar"][aria-label^="Mobile alert push,"]').click();
    await page.locator('[data-testid="timeline-bar"][aria-label^="Alert history export,"]').click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(2);
    await expect(card(page).getByTestId("ms-waits-chip").filter({ hasText: "Alert history export" })).toContainText("after it");
    // QA Nov 14 #4: an item with no dates yet (Alert routing by team) is never late from its estimate.
    await card(page).getByLabel("It counts when").selectOption("Holds 7 days in a row on one live team");
    // The new milestone's dashed line runs through every band, as a saved one's does.
    await spansChart(page, page.getByTestId("ms-new-line"));
    // A tapped bar far off scrolls the chart to it; back to today shows the new milestone's day.
    await page.getByRole("button", { name: "Back to today" }).click();
    await expect(card(page)).toBeVisible();
    await shot(page, "ms1-a-mid");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(toast(page)).toContainText("M5 Teams set 3 rules in week 1 added · 1 item it waits on ends after it");
    await expect(label(page, "M5 Teams set 3 rules in week 1 · Jan 20")).toBeVisible();
    await expect(page.getByTestId("ms-late").filter({ hasText: "Ends after M5 Teams set 3 rules in week 1" })).toBeVisible();
    await shot(page, "ms1-a-done");
  });

  test("Add and place another saves it and keeps adding on the next click", async ({ page }) => {
    // protects: on the Timeline at 6 months, "Add and place another" saves the first milestone (toast "added to Grow retention"), shows a "Next milestone" card, and the next axis click adds a second one; both show as diamonds by name
    // fails_when: the first one is not saved, the card does not turn into "Next milestone", the toast misses its goal, or either diamond is missing or doubled
    // no_claim: the codes the two get (the test finds them by name), their exact dates, or that they persist beyond the mock
    await open(page);
    await page.getByTestId("zoom-6m").click();
    const at = await pointAtAxis(page, 0.6);
    await page.mouse.click(at.x, at.y);
    await pickKind(page, "Sub-goal");
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Builds toward", { exact: true }).selectOption({ label: "Grow retention" });
    await card(page).getByTestId("ms-add-another").click();
    await expect(card(page).getByRole("heading", { name: "Next milestone" })).toBeVisible();
    await expect(toast(page)).toContainText("M5 Teams set 3 rules in week 1 added to Grow retention");
    await shot(page, "ms1-a-second");
    const next = await pointAtAxis(page, 0.8);
    await page.mouse.click(next.x, next.y);
    await card(page).getByLabel("Name").fill("Digest opened by 70%");
    await card(page).getByTestId("ms-save").click();
    // Each by its name: its code is its place by date among the roadmap's milestones.
    // (Each by its diamond: at 6 months the goals' own target dates may fold a label into a +N.)
    await expect(page.locator('[data-testid="ms-diamond"][title*=" Digest opened by 70%,"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="ms-diamond"][title*=" Teams set 3 rules in week 1,"]')).toHaveCount(1);
  });

  test("a click on a milestone opens it to edit; Undo puts it back", async ({ page }) => {
    // protects: a click on a milestone's label opens "Edit M4", a renamed M4 shows with its new name on the same day (Dec 22), and Undo in the toast brings back the old name
    // fails_when: the edit card does not open, the new name is not shown after Save, or Undo leaves the new name
    // no_claim: editing other fields (date, goal, waits), or a PRD's milestone, which asks its owner instead
    await open(page);
    await label(page, "M4 60% of teams active at day 90").click();
    await expect(card(page).getByRole("heading", { name: "Edit M4" })).toBeVisible();
    await shot(page, "ms2-a-open");
    await card(page).getByLabel("Name").fill("65% of teams active at day 90");
    await shot(page, "ms2-a-mid");
    await card(page).getByTestId("ms-save").click();
    await expect(label(page, "M4 65% of teams active at day 90 · Dec 22")).toBeVisible();
    await shot(page, "ms2-a-done");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(label(page, "M4 60% of teams active at day 90 · Dec 22")).toBeVisible();
  });

  test("two on one day share one diamond with their count on the axis", async ({ page }) => {
    // protects: moving M4 to Nov 20 (the day M1 is on) shows "2 on Nov 20" on the axis, one shared diamond, and renumbers them M1 and M2; Undo removes the count
    // fails_when: no "2 on Nov 20" count, more than one diamond on that day, the codes are not renumbered, or Undo leaves the count
    // no_claim: three or more on one day, or how the shared diamond looks
    await open(page);
    const nov20 = page.getByTestId("ms-same-day").filter({ hasText: "on Nov 20" });
    await expect(nov20).toHaveCount(0);
    await label(page, "M4 60% of teams active at day 90").click();
    await card(page).getByLabel("Date").fill("2026-11-20");
    await card(page).getByTestId("ms-save").click();
    // On one day and one goal the codes go by name: it is M1 now, the other M2.
    await expect(label(page, "M1 60% of teams active at day 90 · Nov 20")).toBeVisible();
    await expect(nov20).toHaveText("2 on Nov 20");
    await expect(page.locator('[data-testid="ms-diamond"][title$="Nov 20, 2026"]')).toHaveCount(1);
    await expect(label(page, "M2 Alerts live for 50 teams · Nov 20")).toBeVisible();
    await shot(page, "ms2-a-second");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(label(page, "M4 60% of teams active at day 90 · Dec 22")).toBeVisible();
    await expect(nov20).toHaveCount(0);
  });

  test("an item it waits on opens in the item's own panel", async ({ page }) => {
    // protects: in M4's card, the item it waits on ("Mobile alert push") is a button that closes the card and opens that item's own panel with its name
    // fails_when: the item is not a button, the milestone card stays open, or the item's panel does not open
    // no_claim: what the item's panel contains, or that the other waiting item behaves the same
    await open(page);
    await label(page, "M4 60% of teams active at day 90").click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(2);
    await card(page).getByRole("button", { name: "Mobile alert push", exact: true }).click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Mobile alert push" })).toBeVisible();
  });

  test("a drag on the diamond moves it, a tip says what changes; Undo moves it back", async ({ page }) => {
    // protects: dragging M1's diamond right on the Timeline shows a tip "M1 Alerts live for 50 teams Nov 20 → <day>", then the toast says it moved, its Nov 20 label is gone, and Undo puts it back on Nov 20
    // fails_when: no move tip, no "moved to" toast, the milestone stays on Nov 20 after the drop, or Undo does not bring it back
    // no_claim: the exact day it lands on (the test accepts any), snapping rules, or a touch drag
    await open(page);
    const d = page.locator('[data-testid="ms-diamond"][title^="M1 Alerts live for 50 teams"]');
    const box = (await d.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    await expect(page.getByTestId("ms-move-tip")).toContainText(/^M1 Alerts live for 50 teams Nov 20 → /);
    await shot(page, "ms2-a-move");
    await page.mouse.up();
    await expect(toast(page)).toContainText(/^M1 Alerts live for 50 teams moved to /);
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toHaveCount(0);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toBeVisible();
  });

  test("Remove takes it off the chart; Undo brings it back", async ({ page }) => {
    // protects: Remove in M1's card shows a "removed" toast and takes its label off the chart; Undo brings it back on Nov 20
    // fails_when: no "removed" toast, the label stays on the chart, or Undo does not restore it
    // no_claim: that the removal is stored by the real API, or what happens to items it waited on
    await open(page);
    await label(page, "M1 Alerts live for 50 teams").click();
    await card(page).getByTestId("ms-remove").click();
    await expect(toast(page)).toContainText("M1 Alerts live for 50 teams removed");
    await expect(label(page, "M1 Alerts live for 50 teams")).toHaveCount(0);
    await shot(page, "ms2-a-removed");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toBeVisible();
  });
});

test.describe("milestones on the Gantt and Now / Next / Later", () => {
  test.use(DESKTOP);

  test("the Gantt's time axis adds one in its goal", async ({ page }) => {
    // protects: on the Gantt, a click on the time axis opens the kind picker and the card; with the goal Grow retention and one tapped bar (Mobile alert push) as what it waits on, Save shows the new milestone's label as M2
    // fails_when: the Gantt has no clickable axis, the card does not open, the tapped bar is not a wait chip, or the new label is missing after Save
    // no_claim: the line spanning the chart on the Gantt, or Undo, or the Ends-after tag
    await open(page);
    await page.getByTestId("format-gantt").click();
    const at = await pointAtAxis(page, 0.5);
    await page.mouse.click(at.x, at.y);
    await pickKind(page, "Sub-goal");
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Builds toward", { exact: true }).selectOption({ label: "Grow retention" });
    await page.locator('[data-testid="bar"][data-item="alert-mobile"]').first().click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(1);
    await card(page).getByTestId("ms-save").click();
    await expect(label(page, "M2 Teams set 3 rules in week 1")).toBeVisible();
    await shot(page, "ms1-a-done-gantt");
  });

  test("each horizon lists its milestones and has + Milestone", async ({ page }) => {
    // protects: on Now / Next / Later the Now row lists M1 with its day (Nov 20), its + Milestone button opens the kind picker and card, and a saved milestone shows as a chip in that row
    // fails_when: the Now row lacks the M1 chip, the add button does nothing, or the new milestone's chip is missing from the row
    // no_claim: the Next and Later rows (only the first row is checked), or which row a given date lands in
    await open(page);
    await page.getByTestId("format-board").click();
    const now = page.getByTestId("ms-board-row").first();
    await expect(now.getByTestId("ms-board-chip").filter({ hasText: "M1 Alerts live for 50 teams · Nov 20" })).toBeVisible();
    await now.getByTestId("ms-board-add").click();
    await pickKind(page, "Sub-goal");
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Builds toward", { exact: true }).selectOption({ label: "Grow retention" });
    await card(page).getByTestId("ms-save").click();
    await expect(now.getByTestId("ms-board-chip").filter({ hasText: /^M\d+ Teams set 3 rules in week 1/ })).toBeVisible();
    await shot(page, "ms1-a-board");
  });
});

test.describe("for a commenter, who does not change the roadmap", () => {
  test.use(DESKTOP);

  test("its milestones show, but no + Milestone on the time axis or on Now / Next / Later", async ({ page }) => {
    // protects: for a commenter the M1 milestone shows on the Timeline and on Now / Next / Later, but there is no add hint, no time axis to click, and no + Milestone button
    // fails_when: a commenter sees the add hint, the axis or the + Milestone button, or the milestones are hidden from them
    // no_claim: other roles, the Gantt, or that the API refuses a commenter's write
    await open(page, "simple-milestones", SCHEME, COMMENTER);
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toBeVisible();
    await expect(page.getByTestId("ms-add-hint")).toHaveCount(0);
    await expect(page.getByTestId("ms-axis")).toHaveCount(0);
    await page.getByTestId("format-board").click();
    await expect(page.getByTestId("ms-board-chip").filter({ hasText: "M1 Alerts live for 50 teams · Nov 20" })).toBeVisible();
    await expect(page.getByTestId("ms-board-add")).toHaveCount(0);
  });
});

test.describe("a PRD's own milestones", () => {
  test.use(DESKTOP);

  test("drawn hollow with the key above the chart; a change asks the PRD's owner and the milestone stays put", async ({ page }) => {
    // protects: a PRD's milestones show a key above the chart ("Hollow, dashed ... 1 with no date yet"); M4 is marked as from the PRD; its card names the PRD and its owner Nora Vance; "Ask to change it" shows an asked line, keeps M4's diamond in place and draws the asked day's dashed line through every band
    // fails_when: the key text differs, M4 is not marked as a PRD milestone, the owner is not named, the ask toast or "Asked the PRD" line is wrong, the diamond vanishes, or the asked line does not span the chart
    // no_claim: that the owner answers the ask, the real API, or hollow and dashed colours and shapes
    await open(page, "simple-prd-milestones");
    await expect(page.getByTestId("ms3-key")).toHaveText("Hollow, dashed: from the PRD Usage alerts · a change asks its owner · 1 with no date yet");
    const m2 = page.getByTestId("ms-prd-label").filter({ hasText: "M4 Digest for all teams" });
    // One band for every milestone: a PRD's is marked as one (its diamond is hollow, its tip names the PRD).
    await expect(m2).toHaveAttribute("data-prd", "");
    await shot(page, "ms3-a-rest");
    await m2.click();
    const prd = page.getByTestId("ms-prd-card");
    await expect(prd).toContainText("From the PRD Usage alerts · owned by Nora Vance");
    await shot(page, "ms3-a-open");
    await prd.getByLabel("Date").fill("2027-01-05");
    await shot(page, "ms3-a-mid");
    await prd.getByRole("button", { name: "Ask to change it" }).click();
    await expect(toast(page)).toContainText("Asked Nora Vance to move M4 Digest for all teams to Jan 5 in the PRD");
    await expect(page.getByTestId("ms-asked")).toHaveText("Asked the PRD: move M4 Digest for all teams to Jan 5 · waits for Nora Vance");
    await expect(page.locator('[data-testid="ms-prd-diamond"][title^="M4 Digest for all teams"]')).toBeVisible();
    await expect(page.getByTestId("ms-proposed")).toHaveCount(1);
    // The asked day's dashed line runs through every band, not just the first one.
    await spansChart(page, page.getByTestId("ms-asked-line"));
    await shot(page, "ms3-a-done");
  });

  test("a commenter cannot change the roadmap but still asks the PRD's owner to move its milestone", async ({ page }) => {
    // protects: a commenter opens a PRD milestone (M4), sets Jan 5 and "Ask to change it" shows the toast "Asked Nora Vance to move M4 Digest for all teams to Jan 5 in the PRD", while the add hint stays hidden
    // fails_when: a commenter cannot send the ask, the toast is wrong, or the commenter is shown the add hint
    // no_claim: the ask line on the chart, or what the owner sees
    await open(page, "simple-prd-milestones", SCHEME, COMMENTER);
    const m2 = page.getByTestId("ms-prd-label").filter({ hasText: "M4 Digest for all teams" });
    await m2.click();
    const prd = page.getByTestId("ms-prd-card");
    await prd.getByLabel("Date").fill("2027-01-05");
    await prd.getByRole("button", { name: "Ask to change it" }).click();
    await expect(toast(page)).toContainText("Asked Nora Vance to move M4 Digest for all teams to Jan 5 in the PRD");
    await expect(page.getByTestId("ms-add-hint")).toHaveCount(0);
  });

  test("ms3-a-mid: dragging a PRD milestone fades its old place and draws the dashed amber 'Moving' one", async ({ page }) => {
    // protects: while M4 of a PRD is dragged, a "Moving M4 Digest for all teams to <day>" label shows with a border colour unlike the other PRD labels, one proposed marker shows, the old label is faded (opacity under 1), and the add hint stays off
    // fails_when: no "Moving" label, it has the same border colour as a normal label, no proposed marker, the old label is not faded, or the add hint shows during the drag
    // no_claim: that the exact colour is amber (it only differs from the normal one), what happens on drop (the mouse is released with no check), or the day it moves to
    await open(page, "simple-prd-milestones");
    const d = page.locator('[data-testid="ms-prd-diamond"][title^="M4 Digest for all teams"]');
    const box = (await d.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 4 });
    const moving = page.getByTestId("ms-asked");
    await expect(moving).toContainText(/^Moving M4 Digest for all teams to [A-Z][a-z]{2} \d{1,2}$/);
    expect(await moving.evaluate((e) => getComputedStyle(e).borderTopColor)).not.toBe(await page.getByTestId("ms-prd-label").first().evaluate((e) => getComputedStyle(e).borderTopColor));
    await expect(page.getByTestId("ms-proposed")).toHaveCount(1);
    expect(Number(await page.getByTestId("ms-prd-label").filter({ hasText: "M4 Digest for all teams" }).evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
    await expect(page.getByTestId("ms-ghost-words")).toHaveCount(0);
    await shot(page, "ms3-a-drag");
    await page.mouse.up();
  });
});

test.describe("labels in sight", () => {
  test.use(DESKTOP);

  test("on the Gantt no milestone label covers another, one flipped left of its diamond included", async ({ page }) => {
    // protects: on the Gantt at 1440 wide, in the PRD scenario, no two visible milestone labels overlap each other
    // fails_when: any two visible labels share screen area
    // no_claim: labels on the Timeline or Now / Next / Later, other widths, or that a hidden or folded label is readable
    await open(page, "simple-prd-milestones");
    await page.getByTestId("format-gantt").click();
    await expect(page.getByTestId("ms-prd-label").filter({ hasText: "M5 Push on phones" })).toBeVisible();
    const boxes = await page.locator("[data-ms-label]").evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).visibility !== "hidden").map((e) => ({ text: e.textContent, ...e.getBoundingClientRect().toJSON() })),
    );
    const hits = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map((b) => `${a.text} / ${b.text}`));
    expect(hits).toEqual([]);
  });
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("a tap on the Gantt's axis opens the card as a sheet", async ({ page }) => {
    // protects: on a 390 by 844 phone, a tap on the Gantt's time axis opens the kind picker, then the card, each as a sheet at the left edge whose bottom is at 844; Save shows an "added" toast with the new name
    // fails_when: the picker or card is not at x 0 or does not end at the screen bottom (844), the card does not open, or no "added" toast shows
    // no_claim: other phone sizes, the Timeline or board on a phone, or drag on a phone
    await open(page);
    await page.getByTestId("format-gantt").click();
    const axis = page.getByTestId("ms-axis").first();
    await axis.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 300));
    const box = (await axis.boundingBox())!;
    await page.touchscreen.tap(Math.max(box.x, 0) + 200, box.y + box.height / 2);
    // The kind picker opens as the sheet first; the card after it is the sheet measured below.
    const picker = (await page.getByTestId("ms-kind-picker").boundingBox())!;
    expect(picker.x).toBe(0);
    expect(Math.round(picker.y + picker.height)).toBe(844);
    await pickKind(page, "Sub-goal");
    const sheet = (await card(page).boundingBox())!;
    expect(sheet.x).toBe(0);
    expect(Math.round(sheet.y + sheet.height)).toBe(844);
    await shot(page, "ms1-a-phone");
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByTestId("ms-save").click();
    await expect(toast(page)).toContainText(/M\d Teams set 3 rules in week 1 added/);
    await shot(page, "ms1-a-phone-done");
  });
});

// The built states the picked frames show that no flow above passes through (only with MS_COMPARE_DIR).
test.describe("built states beside the picked frames", () => {
  test.skip(!SHOTS, "only when capturing the side-by-side");

  test.describe("at 1512 wide", () => {
    test.use({ viewport: { width: 1512, height: 982 } });
    for (const [n, scenario] of [["ms1", "simple-milestones"], ["ms2", "simple-milestones"], ["ms3", "simple-prd-milestones"]] as const) {
      test(`${n}: a label near the right edge sits left of its diamond`, async ({ page }) => {
        // protects: at 1512 by 982, the page for each of three scenarios (ms1, ms2, ms3) shows its first milestone label, and a screenshot is taken beside the picked frame
        // fails_when: the first milestone label is not visible at 1512 wide
        // no_claim: that a label really sits left of its diamond (not measured), or the screenshot's look; it runs only when MS_COMPARE_DIR is set
        await open(page, scenario);
        await expect(page.getByTestId(n === "ms3" ? "ms-prd-label" : "ms-label").first()).toBeVisible();
        await shot(page, `${n}-a-hard-1512`);
      });
    }
  });

  test.describe("desktop", () => {
    test.use(DESKTOP);
    test("ms2: at rest and on the Gantt", async ({ page }) => {
      // protects: on desktop the M4 label (Dec 22) shows at rest, and the Gantt shows the milestone time axis; screenshots are taken for both
      // fails_when: the M4 label is not visible, or the Gantt has no time axis
      // no_claim: how either state looks (the shots are only compared by eye); it runs only when MS_COMPARE_DIR is set
      await open(page);
      await expect(label(page, "M4 60% of teams active at day 90 · Dec 22")).toBeVisible();
      await shot(page, "ms2-a-rest");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("ms-axis").first()).toBeVisible();
      await shot(page, "ms2-a-done-gantt");
    });
    test("ms3: the PRD's milestones on the Gantt", async ({ page }) => {
      // protects: in the PRD scenario on desktop, the Gantt shows the milestone time axis; a screenshot is taken
      // fails_when: the Gantt has no time axis
      // no_claim: that the PRD's milestones are drawn right (only the axis is checked), or the screenshot's look; it runs only when MS_COMPARE_DIR is set
      await open(page, "simple-prd-milestones");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("ms-axis").first()).toBeVisible();
      await shot(page, "ms3-a-done-gantt");
    });
  });

  test.describe("phone", () => {
    test.use(PHONE);
    test("ms2: a milestone opens as a sheet", async ({ page }) => {
      // protects: on a phone, a click on M1's label on the Gantt opens its card; a screenshot is taken
      // fails_when: the card does not open
      // no_claim: that the card is a sheet in shape or size (only that it is visible), or the screenshot's look; it runs only when MS_COMPARE_DIR is set
      await open(page);
      await page.getByTestId("format-gantt").click();
      await label(page, "M1 Alerts live for 50 teams").first().click();
      await expect(card(page)).toBeVisible();
      await shot(page, "ms2-a-phone");
    });
    test("ms3: a PRD milestone opens as a sheet", async ({ page }) => {
      // protects: on a phone, a click on the first PRD milestone's label on the Gantt opens the PRD milestone card; a screenshot is taken
      // fails_when: the PRD milestone card does not open
      // no_claim: that the card is a sheet in shape or size (only that it is visible), or the screenshot's look; it runs only when MS_COMPARE_DIR is set
      await open(page, "simple-prd-milestones");
      await page.getByTestId("format-gantt").click();
      await page.getByTestId("ms-prd-label").first().click();
      await expect(page.getByTestId("ms-prd-card")).toBeVisible();
      await shot(page, "ms3-a-phone");
    });
  });
});

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
    await page.locator('[data-testid="timeline-bar"][aria-label^="Alert routing by team,"]').click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(2);
    await expect(card(page).getByTestId("ms-waits-chip").filter({ hasText: "Alert routing by team" })).toContainText("after it");
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
    await open(page);
    await label(page, "M4 60% of teams active at day 90").click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(2);
    await card(page).getByRole("button", { name: "Mobile alert push", exact: true }).click();
    await expect(card(page)).toBeHidden();
    await expect(page.getByTestId("floating-card").getByRole("heading", { name: "Mobile alert push" })).toBeVisible();
  });

  test("a drag on the diamond moves it, a tip says what changes; Undo moves it back", async ({ page }) => {
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
        await open(page, scenario);
        await expect(page.getByTestId(n === "ms3" ? "ms-prd-label" : "ms-label").first()).toBeVisible();
        await shot(page, `${n}-a-hard-1512`);
      });
    }
  });

  test.describe("desktop", () => {
    test.use(DESKTOP);
    test("ms2: at rest and on the Gantt", async ({ page }) => {
      await open(page);
      await expect(label(page, "M4 60% of teams active at day 90 · Dec 22")).toBeVisible();
      await shot(page, "ms2-a-rest");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("ms-axis").first()).toBeVisible();
      await shot(page, "ms2-a-done-gantt");
    });
    test("ms3: the PRD's milestones on the Gantt", async ({ page }) => {
      await open(page, "simple-prd-milestones");
      await page.getByTestId("format-gantt").click();
      await expect(page.getByTestId("ms-axis").first()).toBeVisible();
      await shot(page, "ms3-a-done-gantt");
    });
  });

  test.describe("phone", () => {
    test.use(PHONE);
    test("ms2: a milestone opens as a sheet", async ({ page }) => {
      await open(page);
      await page.getByTestId("format-gantt").click();
      await label(page, "M1 Alerts live for 50 teams").first().click();
      await expect(card(page)).toBeVisible();
      await shot(page, "ms2-a-phone");
    });
    test("ms3: a PRD milestone opens as a sheet", async ({ page }) => {
      await open(page, "simple-prd-milestones");
      await page.getByTestId("format-gantt").click();
      await page.getByTestId("ms-prd-label").first().click();
      await expect(page.getByTestId("ms-prd-card")).toBeVisible();
      await shot(page, "ms3-a-phone");
    });
  });
});

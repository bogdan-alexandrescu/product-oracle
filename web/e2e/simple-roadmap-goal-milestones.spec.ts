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

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const SHOTS = process.env.MS_COMPARE_DIR;

async function open(page: Page, scenario = "simple-milestones", scheme: "light" | "dark" = "light") {
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
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
const label = (page: Page, words: string) => page.getByTestId("ms-label").filter({ hasText: words });
const card = (page: Page) => page.getByTestId("ms-card");
const toast = (page: Page) => page.getByTestId("ms-toast");

async function pointAtAxis(page: Page, at = 0.7) {
  const axis = page.getByTestId("ms-axis").first();
  const box = (await axis.boundingBox())!;
  await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
  return { x: box.x + box.width * at, y: box.y + box.height / 2 };
}

test.describe("milestones on the Timeline", () => {
  test.use(DESKTOP);

  test("pointing at the axis shows where; a click opens the card; tapped bars are what it waits on; Add draws it with the Ends-after tag", async ({ page }) => {
    await open(page);
    await expect(label(page, "M1 Alerts live for 50 teams · Nov 20")).toBeVisible();
    await shot(page, "ms1-a-rest");
    const at = await pointAtAxis(page);
    await expect(page.getByTestId("ms-ghost-words")).toContainText(/^\+ Milestone on [A-Z][a-z]{2} \d{1,2}, 20\d\d$/);
    await shot(page, "ms1-a-open");
    await page.mouse.click(at.x, at.y);
    await expect(card(page).getByRole("heading", { name: "New milestone" })).toBeVisible();
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Date").fill("2027-01-20");
    await card(page).getByLabel("Goal").selectOption({ label: "Grow retention" });
    await page.locator('[data-testid="timeline-bar"][aria-label^="Mobile alert push,"]').click();
    await page.locator('[data-testid="timeline-bar"][aria-label^="Alert routing by team,"]').click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(2);
    await expect(card(page).getByTestId("ms-waits-chip").filter({ hasText: "Alert routing by team" })).toContainText("after it");
    await card(page).getByLabel("It counts when").selectOption("Holds 7 days in a row on one live team");
    await shot(page, "ms1-a-mid");
    await card(page).getByTestId("ms-save").click();
    await expect(card(page)).toBeHidden();
    await expect(toast(page)).toContainText("M3 Teams set 3 rules in week 1 added · 1 item it waits on ends after it");
    await expect(label(page, "M3 Teams set 3 rules in week 1 · Jan 20")).toBeVisible();
    await expect(page.getByTestId("ms-late").filter({ hasText: "Ends after M3 Teams set 3 rules in week 1" })).toBeVisible();
    await shot(page, "ms1-a-done");
  });

  test("Add and place another saves it and keeps adding on the next click", async ({ page }) => {
    await open(page);
    const at = await pointAtAxis(page, 0.6);
    await page.mouse.click(at.x, at.y);
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Goal").selectOption({ label: "Grow retention" });
    await card(page).getByTestId("ms-add-another").click();
    await expect(card(page).getByRole("heading", { name: "Next milestone" })).toBeVisible();
    await expect(toast(page)).toContainText("M3 Teams set 3 rules in week 1 added to Grow retention");
    await shot(page, "ms1-a-second");
    const next = await pointAtAxis(page, 0.8);
    await page.mouse.click(next.x, next.y);
    await card(page).getByLabel("Name").fill("Digest opened by 70%");
    await card(page).getByTestId("ms-save").click();
    await expect(label(page, "M4 Digest opened by 70%")).toBeVisible();
    await expect(label(page, "M3 Teams set 3 rules in week 1")).toBeVisible();
  });

  test("a click on a milestone opens it to edit; Undo puts it back", async ({ page }) => {
    await open(page);
    await label(page, "M2 60% of teams active at day 90").click();
    await expect(card(page).getByRole("heading", { name: "Edit M2" })).toBeVisible();
    await shot(page, "ms2-a-open");
    await card(page).getByLabel("Name").fill("65% of teams active at day 90");
    await card(page).getByTestId("ms-save").click();
    await expect(label(page, "M2 65% of teams active at day 90 · Dec 22")).toBeVisible();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(label(page, "M2 60% of teams active at day 90 · Dec 22")).toBeVisible();
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
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Goal").selectOption({ label: "Grow retention" });
    await page.locator('[data-testid="bar"][data-item="alert-mobile"]').first().click();
    await expect(card(page).getByTestId("ms-waits-chip")).toHaveCount(1);
    await card(page).getByTestId("ms-save").click();
    await expect(label(page, "M3 Teams set 3 rules in week 1")).toBeVisible();
    await shot(page, "ms1-a-done-gantt");
  });

  test("each horizon lists its milestones and has + Milestone", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-board").click();
    const now = page.getByTestId("ms-board-row").first();
    await expect(now.getByTestId("ms-board-chip").filter({ hasText: "M1 Alerts live for 50 teams · Nov 20" })).toBeVisible();
    await now.getByTestId("ms-board-add").click();
    await card(page).getByLabel("Name").fill("Teams set 3 rules in week 1");
    await card(page).getByLabel("Goal").selectOption({ label: "Grow retention" });
    await card(page).getByTestId("ms-save").click();
    await expect(now.getByTestId("ms-board-chip").filter({ hasText: "M3 Teams set 3 rules in week 1" })).toBeVisible();
    await shot(page, "ms1-a-board");
  });
});

test.describe("a PRD's own milestones", () => {
  test.use(DESKTOP);

  test("drawn hollow with the key above the chart; a change asks the PRD's owner and the milestone stays put", async ({ page }) => {
    await open(page, "simple-prd-milestones");
    await expect(page.getByTestId("ms3-key")).toHaveText("Hollow, dashed: from the PRD Usage alerts · a change asks its owner · 1 with no date yet");
    const m2 = page.getByTestId("ms-prd-label").filter({ hasText: "M2 Digest for all teams" });
    await expect(m2).toContainText("PRD · M2 Digest for all teams");
    await shot(page, "ms3-a-rest");
    await m2.click();
    const prd = page.getByTestId("ms-prd-card");
    await expect(prd).toContainText("From the PRD Usage alerts · owned by Nora Vance");
    await shot(page, "ms3-a-open");
    await prd.getByLabel("Date").fill("2027-01-05");
    await prd.getByRole("button", { name: "Ask to change it" }).click();
    await expect(toast(page)).toContainText("Asked Nora Vance to move M2 Digest for all teams to Jan 5 in the PRD");
    await expect(page.getByTestId("ms-asked")).toHaveText("Asked the PRD: move M2 Digest for all teams to Jan 5 · waits for Nora Vance");
    await expect(page.locator('[data-testid="ms-prd-diamond"][title^="M2 Digest for all teams"]')).toBeVisible();
    await expect(page.getByTestId("ms-proposed")).toHaveCount(1);
    await shot(page, "ms3-a-done");
  });
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("a tap on the Gantt's axis opens the card as a sheet", async ({ page }) => {
    await open(page);
    await page.getByTestId("format-gantt").click();
    const axis = page.getByTestId("ms-axis").first();
    await axis.scrollIntoViewIfNeeded();
    const box = (await axis.boundingBox())!;
    await page.touchscreen.tap(box.x + Math.min(box.width - 10, 300), box.y + box.height / 2);
    await expect(card(page).getByRole("heading", { name: "New milestone" })).toBeVisible();
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

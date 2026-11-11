import { GM_TRACKS_HARD_SCENARIO, GM_TRACKS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal map, "Goals by tracks grid" (the owner's pick of Nov 11, proposal B), driven through the
 * UI against the mock ("goal-map-tracks": invented goals, milestones, tracks and features). The
 * goals are columns, the milestone strip sits under each goal, the tracks are rows, and each cell
 * lists the features where that track serves that goal as chips with their milestone.
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

const DESKTOP = { viewport: { width: 1512, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page, scenario: string = GM_TRACKS_SCENARIO) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

const goal = (page: Page, name: string) => page.getByTestId("gm-goal").filter({ hasText: name });
const track = (page: Page, name: string) => page.getByTestId("gm-track").filter({ hasText: new RegExp(`^${name}$`) });
const chip = (page: Page, name: string) => page.getByTestId("gm-chip").filter({ hasText: name });
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

test.describe("Goal map: goals by tracks grid", () => {
  test.use(DESKTOP);

  test("goals are columns, tracks are rows, each cell lists its features with their milestone", async ({ page }) => {
    // protects: the picked grid: 4 goals across, tracks down the left, chips with codes and milestones.
    // fails_when: the old ladder shows (no grid), a chip lacks its code or milestone, or empty cells fill.
    // no_claim: the chips' order within a cell beyond milestone order.
    await open(page);
    await expect(page.getByTestId("gm-goal")).toHaveCount(4);
    await expect(page.getByTestId("gm-goal").first()).toContainText("Booked demos per rep per day");
    await expect(page.getByTestId("gm-goal").nth(3)).toContainText("Revenue per day");
    await expect(page.getByTestId("gm-track")).toHaveText(["Scale", "Safety", "Activation", "Revenue", "Account Management"]);
    // A milestone strip under each goal: roadmap-wide code, name and a month-first date.
    await expect(strip(page, "32 demos per rep")).toContainText(/M\d+\s*32 demos per rep\s*Dec 18/);
    const scaleDemos = page.getByTestId("gm-cell").and(page.locator(`[data-track="${await track(page, "Scale").getAttribute("data-track")}"]`)).first();
    await expect(scaleDemos.getByTestId("gm-chip").filter({ hasText: "Rep calendar sync" })).toContainText(/F-\d+\s*Rep calendar sync/);
    await expect(chip(page, "Rep calendar sync")).toContainText(/M\d+ 32 demos per rep/);
    // A feature on no milestone says so.
    await expect(chip(page, "Rep daily scoreboard")).toContainText("No milestone");
    // An empty cell stays empty; no No track row while every feature has a track.
    const safety = await track(page, "Safety").getAttribute("data-track");
    await expect(page.locator(`[data-testid="gm-cell"][data-track="${safety}"]`).first().getByTestId("gm-chip")).toHaveCount(0);
    await expect(track(page, "No track")).toHaveCount(0);
    // The old views are gone.
    await expect(page.getByText("Work behind it")).toHaveCount(0);
    await expect(page.getByTestId("ld-goal")).toHaveCount(0);
  });

  test("a chip opens the one feature panel", async ({ page }) => {
    // protects: every feature opens the same panel. fails_when: the chip opens nothing or another view.
    await open(page);
    await chip(page, "Rep calendar sync").getByRole("button", { name: /Rep calendar sync/ }).click();
    await expect(page.getByTestId("floating-card").getByTestId("card-name")).toContainText(/F-\d+\s*Rep calendar sync/);
  });

  test("Move to... another milestone lands in milestone order, and Undo puts it back", async ({ page }) => {
    // protects: moving a chip through its menu, in milestone order (not first in its cell), with Undo.
    // fails_when: the chip stays, lands first in its new cell, or Undo leaves it moved.
    await open(page);
    const c = chip(page, "Lead list ranking");
    await expect(c).toContainText("32 demos per rep");
    await c.hover();
    await c.getByRole("button", { name: /More for .*Lead list ranking/ }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const mover = page.getByRole("dialog", { name: /Move .*Lead list ranking/ });
    await mover.getByRole("button", { name: /40 demos per rep/ }).click();
    await expect(chip(page, "Lead list ranking")).toContainText("40 demos per rep");
    // In its cell, it sits after the chips of earlier milestones.
    const scale = await track(page, "Scale").getAttribute("data-track");
    const cell = page.locator(`[data-testid="gm-cell"][data-track="${scale}"]`).first();
    const names = await cell.getByTestId("gm-chip").allTextContents();
    const at = names.findIndex((n) => n.includes("Lead list ranking"));
    expect(names.findIndex((n) => n.includes("Rep calendar sync"))).toBeLessThan(at);
    expect(names.findIndex((n) => n.includes("Demo room in the browser"))).toBeGreaterThan(-1);
    await toast(page, /Moved .*Lead list ranking/).getByRole("button", { name: "Undo" }).click();
    await expect(chip(page, "Lead list ranking")).toContainText("32 demos per rep");
  });

  test("Move to... another track moves the chip to that row, and Undo puts it back", async ({ page }) => {
    // protects: a chip's track changed from the grid. fails_when: it stays in its row.
    await open(page);
    const c = chip(page, "Shared rep notes");
    const accounts = await track(page, "Account Management").getAttribute("data-track");
    const scale = await track(page, "Scale").getAttribute("data-track");
    await expect(c).toHaveAttribute("data-track", accounts!);
    await c.hover();
    await c.getByRole("button", { name: /More for .*Shared rep notes/ }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page.getByRole("dialog", { name: /Move .*Shared rep notes/ }).getByRole("button", { name: "Scale" }).click();
    await expect(chip(page, "Shared rep notes")).toHaveAttribute("data-track", scale!);
    await toast(page, /Moved .*Shared rep notes/).getByRole("button", { name: "Undo" }).click();
    await expect(chip(page, "Shared rep notes")).toHaveAttribute("data-track", accounts!);
  });

  test("renaming a milestone from the strip renames it on its chips too", async ({ page }) => {
    // protects: Rename in a milestone's menu. fails_when: the strip or the chips keep the old name.
    await open(page);
    const m = strip(page, "32 demos per rep");
    await m.hover();
    await m.getByRole("button", { name: /More for .*32 demos per rep/ }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const input = page.getByRole("textbox", { name: "Rename 32 demos per rep" });
    await input.fill("33 demos per rep");
    await input.press("Enter");
    await expect(strip(page, "33 demos per rep")).toBeVisible();
    await expect(chip(page, "Rep calendar sync")).toContainText("33 demos per rep");
  });

  test("the hard case: long names stay in two lines, features with no track get a No track row", async ({ page }) => {
    // protects: the No track row only when such features exist; full goal names on hover.
    await open(page, GM_TRACKS_HARD_SCENARIO);
    await expect(track(page, "No track")).toHaveCount(1);
    await expect(chip(page, "Help center search")).toContainText("No milestone");
    await expect(goal(page, "Booked demos per rep per day").getByTitle("Booked demos per rep per day")).toBeVisible();
  });
});

test.describe("Goal map on a phone", () => {
  test.use(PHONE);

  test("the grid scrolls sideways with the track names sticky and the next goal peeking", async ({ page }) => {
    // protects: the phone layout of the pick. fails_when: the page itself scrolls sideways, track
    // names scroll away, or the second goal is out of sight.
    await open(page);
    const second = page.getByTestId("gm-goal").nth(1);
    const box = (await second.boundingBox())!;
    expect(box.x).toBeLessThan(390);
    expect(box.x + box.width).toBeGreaterThan(390);
    const name = track(page, "Scale");
    const before = (await name.boundingBox())!.x;
    await page.getByTestId("gm-grid").evaluate((el) => (el.scrollLeft = 400));
    await expect.poll(async () => (await second.boundingBox())!.x).toBeLessThan(box.x - 300);
    expect(Math.abs((await name.boundingBox())!.x - before)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // With no hover, a chip's ⋯ is there to tap.
    await page.getByTestId("gm-grid").evaluate((el) => (el.scrollLeft = 0));
    await chip(page, "Lead list ranking").getByRole("button", { name: /More for .*Lead list ranking/ }).tap();
    await expect(page.getByRole("menuitem", { name: "Move to…" })).toBeVisible();
  });
});

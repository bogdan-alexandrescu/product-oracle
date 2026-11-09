import { LADDER_KR_CODES, LADDER_KR_CODES_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * kr-in-goal-map, key results' codes, on the mock's "goal-ladder-key-result-codes" scenario
 * (invented: the key-result ladder, with Goal 2 coded G-B; its key results G-B.1 and G-B.2 each
 * hold one of its milestones; F-21 is on both, G-B.2's listed first; F-01 is on Goal 1's milestone
 * while its item serves G-B.1; under G-B.1 a proposed key result is older than a confirmed one).
 *
 * Card kr-deeper-code: protects = a key result's own key result is numbered among every sibling,
 * proposed ones too, as the goal tree numbers subgoals: G-B.1.2 when a proposed one is older;
 * fails_when = it reads G-B.1.1 (only confirmed siblings counted).
 * Card kr-first-by-code: protects = a feature on milestones of two key results of one goal, whose
 * item serves no goal once off them, dropped on that goal's "Not on a key result", serves the key
 * result first by code; fails_when = it serves the one whose milestone is listed first (G-B.2).
 * Card kr-card-keeps: protects = a feature dropped on a goal's card while its item already serves
 * one of that goal's key results keeps serving the key result; fails_when = its item is moved onto
 * the goal itself.
 */

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, LADDER_KR_CODES_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
}

const C = LADDER_KR_CODES;
const card = (page: Page, code: string) => page.getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: new RegExp(`^${code}$`) }) });
const goalCard = (page: Page) => page.getByTestId("ld-goal").filter({ hasText: C.goal });
const column = (page: Page) => page.getByTestId("ld-column").filter({ has: goalCard(page) });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

/** Drags with the mouse in steps, as a person does. */
async function dragBy(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
}
/** The part of the canvas on screen, above where toasts show. */
async function area(page: Page) {
  await page.getByTestId("ld-canvas").evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const c = (await page.getByTestId("ld-canvas").boundingBox())!;
  const top = Math.max(c.y, 0);
  return { x: c.x, y: top, width: c.width, height: Math.min(c.y + c.height, page.viewportSize()!.height - 100) - top };
}
/** The canvas's pan and zoom, as drawn. */
const view = (page: Page) => page.locator("[data-ld-canvas]").evaluate((el) => (el as HTMLElement).style.transform);
/** Zooms out until both fit in the canvas, then pans them into view (the wheel over the canvas). */
async function showBoth(page: Page, a: Locator, b: Locator) {
  const canvas = await area(page);
  for (let i = 0; i < 14; i++) {
    const [A, B] = [(await a.boundingBox())!, (await b.boundingBox())!];
    const top = Math.min(A.y, B.y);
    const bottom = Math.max(A.y + A.height, B.y + B.height);
    if (top >= canvas.y && bottom <= canvas.y + canvas.height) return;
    const before = await view(page);
    if (bottom - top > canvas.height - 40) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      // At the smallest zoom the click changes nothing; otherwise wait for the canvas to redraw.
      if (!before.includes("scale(0.3)")) await expect.poll(() => view(page)).not.toBe(before);
      continue;
    }
    await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -(canvas.y + canvas.height / 2 - (top + bottom) / 2));
    // Each wheel step pans the canvas: wait for it to be drawn there before measuring again.
    await expect.poll(() => view(page)).not.toBe(before);
  }
}
async function mid(loc: Locator) {
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function drag(page: Page, from: Locator, to: Locator) {
  await showBoth(page, from, to);
  await dragBy(page, await mid(from), await mid(to));
}
/** The goal a feature serves, read in its panel (Edit ladder off). */
async function served(page: Page, code: string) {
  const f = card(page, code).first();
  await f.click();
  await f.getByTestId("ld-open").click();
  const panel = page.getByTestId("gm-feature-panel");
  await expect(panel).toBeVisible();
  return panel.getByTestId("card-goal");
}

test.describe("Goal map: key results' codes and drops", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a key result's own key result is numbered among every sibling, a proposed one too", async ({ page }) => {
    await open(page);
    const krs = goalCard(page).getByTestId("ld-goal-kr");
    await expect(krs.filter({ hasText: C.first }).locator(".simple-code")).toHaveText("G-B.1");
    await expect(krs.filter({ hasText: C.second }).locator(".simple-code")).toHaveText("G-B.2");
    // The older proposed key result under G-B.1 is not listed, but keeps its number.
    await expect(krs.filter({ hasText: C.proposed })).toHaveCount(0);
    await expect(krs.filter({ hasText: C.deeper }).locator(".simple-code")).toHaveText("G-B.1.2");
  });

  test("a feature on two key results' milestones, dropped on Not on a key result, serves the key result first by code", async ({ page }) => {
    await open(page);
    // F-21 is drawn once, under its first milestone (G-B.2's), in Goal 2.
    await expect(column(page).getByTestId("ld-feature").filter({ has: page.locator(".simple-code", { hasText: /^F-21$/ }) })).toHaveCount(1);
    await page.getByTestId("ld-edit").click();
    await drag(page, card(page, C.both).first(), column(page).getByTestId("ld-free"));
    await expect(toast(page, "Moved")).toContainText("Not on a key result");
    await expect(column(page).getByTestId("ld-free").getByTestId("ld-feature").filter({ hasText: C.both })).toHaveCount(1);

    await page.getByTestId("ld-edit").click();
    const goal = await served(page, C.both);
    await expect(goal).toContainText(C.first);
    await expect(goal).not.toContainText(C.second);
  });

  test("a feature dropped on a goal's card keeps the goal's key result its item already serves", async ({ page }) => {
    await open(page);
    // F-01 is on Goal 1's milestone; its item serves G-B.1, a key result of Goal 2.
    await expect(await served(page, C.serving)).toContainText(C.first);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("gm-feature-panel")).toHaveCount(0);

    await page.getByTestId("ld-edit").click();
    await drag(page, card(page, C.serving), goalCard(page));
    await expect(toast(page, "Moved")).toContainText(C.goal);
    await expect(column(page).getByTestId("ld-free").getByTestId("ld-feature").filter({ hasText: C.serving })).toHaveCount(1);

    await page.getByTestId("ld-edit").click();
    const goal = await served(page, C.serving);
    await expect(goal).toContainText(C.first);
    await expect(goal).not.toHaveText(C.goal);
  });
});

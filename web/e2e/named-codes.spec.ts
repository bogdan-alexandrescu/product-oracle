import { expect, test, type Locator, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

/*
 * Named codes (#304), through the UI on the mock layer. The "named-codes" scenario's company
 * writes its code before each goal's name ("G-B Growth"); the default company does not.
 * protects = every goal and feature code the app draws shows its name, with one card behind
 * it (hover, Tab, tap; Escape closes), and no page draws a place code (G1-G4) or a slug;
 * fails_when = a bare G1 or g.activation reappears, or the card does not open or close;
 * no_claim = codes inside text agents write (the next issue).
 */

const withCodes = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "named-codes"), MOCK_SCENARIO_KEY);

/** Goal and feature slugs of the mock company, and place codes. */
const BARE = /\bG[1-4]\b|\b[gf]\.[a-z][a-z-]*/;

async function mainText(page: Page): Promise<string> {
  return page.locator("main").innerText();
}

const planGoal = (page: Page, item: string) =>
  page.getByTestId("plan-row").filter({ hasText: item }).filter({ visible: true }).getByTestId("plan-goal");

test("Plan, Baseline and Priorities draw names, never a place code or a slug", async ({ page }) => {
  await withCodes(page);
  await login(page);

  await page.goto("/plan");
  await expect(page.getByTestId("plan-row").first()).toBeVisible();
  const chip = planGoal(page, "Daily alert digest email").getByTestId("code-chip");
  await expect(chip.getByTestId("code-tag")).toHaveText("G-B");
  await expect(chip.getByTestId("code-name")).toHaveText("Growth");
  await expect(page.getByTestId("plan-goals")).toContainText("Growth");
  const group = page.getByRole("group", { name: "Group by" });
  await group.getByRole("button", { name: "Goal" }).click();
  await expect(page.getByTestId("plan-group").first()).toContainText("G-A Activation");
  expect(await mainText(page)).not.toMatch(BARE);

  await page.goto("/baseline");
  await expect(page.getByTestId("feature-f.guided-setup")).toBeVisible();
  await expect(page.locator("main").getByTestId("code-tag").filter({ hasText: "G-B" }).first()).toBeVisible();
  expect(await mainText(page)).not.toMatch(BARE);

  await page.goto("/priorities");
  const row = page.getByTestId("priority-row-F-1");
  await expect(row.getByTestId("code-chip")).toHaveAccessibleName("G-A Activation");
  // Depends on: the feature's name, not its key.
  await expect(page.getByTestId("priority-row-F-2")).toContainText("Address lookup service");
  await row.getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  await expect(ex.getByRole("list", { name: "Steps" })).toContainText("goal value = 3×2 (G-A Activation) = 6");
  expect(await mainText(page)).not.toMatch(BARE);
});

test("a goal chip's card opens on hover and Tab, shows name, target and Open, and Escape closes it", async ({ page }) => {
  await withCodes(page);
  await login(page);
  await page.goto("/plan");
  const chip = planGoal(page, "Daily alert digest email").getByTestId("code-chip");
  const card = page.getByTestId("code-card");

  await chip.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Goal · confirmed");
  await expect(card.getByTestId("card-name")).toHaveText("Growth");
  await expect(card.getByTestId("card-line")).toHaveText("Target 12%");
  await expect(card.getByRole("link", { name: "Open" })).toHaveAttribute("href", /^\/baseline\?entity=/);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Tab to the chip from the row's title cell before it.
  await page.mouse.move(0, 0);
  await page.getByTestId("plan-row").filter({ hasText: "Daily alert digest email" }).filter({ visible: true }).click();
  for (let i = 0; i < 40 && !(await chip.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("card-name")).toHaveText("Growth");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Open goes to the goal on the Baseline.
  await chip.click();
  await card.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/baseline\?entity=/);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("tapping a goal chip opens its card as a bottom sheet; Escape and a tap outside close it", async ({ page }) => {
    await withCodes(page);
    await login(page);
    await page.goto("/plan");
    const chip = page.getByTestId("plan-goals").getByTestId("code-chip").filter({ hasText: "Growth" });
    await chip.tap();
    const card = page.getByTestId("code-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-sheet", "true");
    const box = (await card.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843);
    // Edge to edge across the screen.
    expect(Math.round(box.x)).toBe(0);
    expect(box.width).toBeGreaterThanOrEqual(390);
    await expect(card.getByTestId("card-name")).toHaveText("Growth");
    await expect(card.getByTestId("card-line")).toHaveText("Target 12%");
    await expect(card.getByRole("link", { name: "Open" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await chip.tap();
    await expect(card).toBeVisible();
    await page.touchscreen.tap(200, 20);
    await expect(card).toHaveCount(0);
  });
});

test("the Confidence panel shows source titles, the id inside the card; a citation chip opens its card", async ({ page }) => {
  await login(page);
  await page.goto("/priorities");
  await page.getByTestId("priority-row-F-1").getByRole("button", { name: /Saved addresses at checkout/ }).click();
  const ex = page.getByTestId("explanation-F-1");
  const ev = ex.getByTestId("evidence-chip").filter({ hasText: "Interview 07" });
  await expect(ev).toBeVisible();
  await expect(ev).toContainText("Sep 12");
  await expect(ex).not.toContainText("ev-1");
  await ev.click();
  const card = page.getByTestId("code-card");
  await expect(card).toContainText("Interview 07");
  await expect(card).toContainText("ev-1");
  await expect(card.getByRole("link", { name: /Open source/ })).toHaveAttribute("href", "https://example.com/research/interview-07");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await page.goto("/documents/checkout-redesign/v/2");
  const cite = (await openSection(page, "problem")).getByTestId("cite-c4");
  await cite.click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("cite-source")).toContainText("GitHub");
  await expect(card.getByRole("link", { name: /Open source/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

async function overflows(loc: Locator): Promise<boolean> {
  return loc.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
}

for (const width of [1280, 390]) {
  test(`a long goal name is cut with "…" without overflowing the table at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await withCodes(page);
    await login(page);
    await page.goto("/plan");
    const table = page.getByTestId("plan-table");
    await expect(page.getByTestId("plan-row").first()).toBeVisible();
    const name = planGoal(page, "Budgets per team").getByTestId("code-name");
    await expect(name).toBeVisible();
    if (width === 1280) {
      expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
      expect(await overflows(name)).toBe(true);
    }
    expect(await overflows(table)).toBe(false);
    const t = (await table.boundingBox())!;
    const n = (await name.boundingBox())!;
    expect(n.x + n.width).toBeLessThanOrEqual(t.x + t.width + 0.5);
    expect(t.x + t.width).toBeLessThanOrEqual(width + 0.5);
  });
}

test("the card reads in the dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await withCodes(page);
  await login(page);
  await page.goto("/plan");
  await planGoal(page, "Daily alert digest email").getByTestId("code-chip").click();
  const card = page.getByTestId("code-card");
  await expect(card).toBeVisible();
  const [fg, bg] = await card.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
  expect(fg).not.toBe(bg);
  // A light text on a dark card.
  const lum = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
  expect(lum(fg)).toBeGreaterThan(lum(bg));
});

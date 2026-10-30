import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * fix4 shell, Simple's Roadmap (desktop and phone, mock-backed, through the UI only), on the
 * mock's "simple-plan-lanes" scenario (invented data: Guided setup's plan, M1 Prove it ends
 * Nov 27; the company's time zone is the mock's default, America/Los_Angeles):
 * - qa-shell-6: Today is the company's day: on a Pacific evening (02:00 UTC on Oct 30 is
 *   19:00 on Oct 29 in Los Angeles) the legend says "Today Oct 29", not the UTC day.
 * - qa-shell-21: Simple writes a day as Detailed does, month first ("Nov 27", "Oct 17, 2026").
 * - qa-shell-24: the quick add's placeholder fits its box; a phone's pickers sit behind one
 *   Filters button.
 * - qa-shell-25: a phone's goal lanes are named ("Faster activation, 4 items").
 * - review minor: a phone's Filters panel closes on Escape (focus back on Filters) and on a
 *   tap outside it, as the sheets beside it do; a pick inside it keeps it open.
 * no_claim: the API's company day (api/oracle/company_time.py, its own pytest).
 */

const URL = "/simple/roadmap?roadmap=onboarding-roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-plan-lanes"] as const);
  await login(page);
  await page.goto(URL);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", "timeline");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1366, height: 820 } });

  test("qa-shell-6: on a Pacific evening the legend's Today is the company's day", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-30T02:00:00Z"));
    await open(page);
    const today = page.getByTestId("legend").getByTestId("legend-item").filter({ hasText: /^Today / });
    await expect(today).toHaveText("Today Oct 29");
  });

  test("qa-shell-21: the roadmap writes its days month first, as Detailed does", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("legend").getByTestId("legend-item").filter({ hasText: /^Today / })).toHaveText("Today Oct 22");
    await expect(page.getByTestId("milestone-end-label").first()).toHaveText("M1 ends Nov 27");
    await expect(page.getByTestId("legend")).toContainText("Holidays Dec 28 – Jan 1");
    await expect(page.getByTestId("legend")).not.toContainText(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });

  test("qa-shell-21: the PRDs list says when each changed month first", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    const updated = page.getByTestId("one-pager-row").first().getByText(/^Updated /);
    await expect(updated).toHaveText(/^Updated (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/);
  });
});

test.describe("narrow desktop", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("qa-shell-24: the quick add's placeholder fits its box", async ({ page }) => {
    await open(page);
    const input = page.getByLabel("Add an item");
    await expect(input).toBeVisible();
    const room = await input.evaluate((el) => {
      const box = el as HTMLInputElement;
      const cs = getComputedStyle(box);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return { text: ctx.measureText(box.placeholder).width, width: box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
    });
    expect(room.text).toBeLessThanOrEqual(room.width);
    // Its full words stay on the box.
    await expect(input).toHaveAttribute("title", "Type a title, then drag it onto a quarter, a column or a goal");
  });
});

test.describe("phone", () => {
  test.use(PHONE);

  test("qa-shell-24: the pickers sit behind one Filters button", async ({ page }) => {
    await open(page);
    const toggle = page.getByTestId("filters-toggle");
    await expect(toggle).toHaveText("Filters · 1");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("combobox", { name: "To", exact: true })).toHaveCount(0);
    // Group by stays at hand beside the button.
    await expect(page.getByTestId("filters").getByRole("group", { name: "Group by" })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const pickers = page.getByTestId("filter-pickers");
    for (const name of ["Roadmap", "PRD", "Goal", "Track", "From", "To"]) await expect(pickers.getByRole("combobox", { name, exact: true })).toBeVisible();
    // One picker per line: none sits alone at the end of a wrapped row.
    const xs = await pickers.locator("label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    expect(new Set(xs.map((x) => Math.round(x))).size).toBe(1);
    await toggle.click();
    await expect(pickers).toHaveCount(0);
  });

  test("qa-shell-25: each goal lane is named by its goal and its count", async ({ page }) => {
    await open(page);
    const lanes = page.locator('g[data-testid="phone-lane"]');
    await expect(lanes.first()).toBeVisible();
    const n = await lanes.count();
    expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      const lane = lanes.nth(i);
      const name = (await lane.getByTestId("phone-lane-name").textContent())!.trim();
      const count = (await lane.getByTestId("lane-count").textContent())!.trim();
      expect(count).toMatch(/^\d+ items?$/);
      await expect(lane).toHaveAccessibleName(`${name}, ${count}`);
    }
    await lanes.first().focus();
    await expect(page.getByRole("button", { name: /, \d+ items?$/ }).first()).toBeFocused();
  });

  test("qa-shell-21: a lane's list writes its days month first", async ({ page }) => {
    await open(page);
    await page.locator('g[data-testid="phone-lane"]').first().click();
    await expect(page.getByTestId("lane-row").first()).toContainText(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} – (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/);
  });

  test("review: the Filters panel closes on Escape and on a tap outside it", async ({ page }) => {
    await open(page);
    const toggle = page.getByTestId("filters-toggle");
    const pickers = page.getByTestId("filter-pickers");
    await toggle.click();
    await expect(pickers).toBeVisible();
    // A pick inside the panel keeps it open.
    await pickers.getByRole("combobox", { name: "Track", exact: true }).selectOption({ index: 1 });
    await expect(pickers).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pickers).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(pickers).toBeVisible();
    await page.getByTestId("simple-chart").tap({ position: { x: 5, y: 5 } });
    await expect(pickers).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

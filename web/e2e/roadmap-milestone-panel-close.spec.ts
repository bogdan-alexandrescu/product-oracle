import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * roadmap-milestone-panel-close: the milestone's panel on the Roadmap ("Edit M5", opened from its
 * label in the milestone band) closes as the Roadmap's other panels do: on Escape, and when the
 * person switches the view (Timeline, Gantt, Now / Next / Later, Waterfall) instead of staying open
 * over the new one. Mock scenario "simple-milestones" (invented goals and milestones; M5 is the
 * goal Faster activation's own milestone), as the roadmap's owner.
 *
 * Card escape: protects = Escape closes the milestone's panel; fails_when = the panel has no
 * Escape handler and stays open.
 * Card view-switch: protects = picking another view closes the milestone's panel;
 * fails_when = the view switch leaves the panel's draft set, so "Edit M5" stays over the new view.
 */

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-milestones"] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const label = (page: Page, code: string) => page.getByTestId("ms-label").filter({ hasText: new RegExp(`^${code} `) });
const card = (page: Page) => page.getByTestId("ms-card");

async function openPanel(page: Page) {
  await expect(label(page, "M5")).toBeVisible();
  await label(page, "M5").click();
  await expect(card(page).getByRole("heading", { name: "Edit M5" })).toBeVisible();
}

test("Escape closes the milestone's panel on the Roadmap", async ({ page }) => {
  await open(page);
  await openPanel(page);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  // It opens again after Escape, and Escape closes it again.
  await openPanel(page);
  await card(page).getByLabel("Name", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
});

test("switching the Roadmap's view closes the milestone's panel", async ({ page }) => {
  await open(page);
  for (const view of ["format-gantt", "format-board", "format-waterfall"]) {
    await openPanel(page);
    await page.getByTestId(view).click();
    await expect(card(page)).toHaveCount(0);
    await page.getByTestId("format-timeline").click();
    await expect(card(page)).toHaveCount(0);
  }
});

import { MOCK_SCENARIO_KEY, STALE_SIMPLE_FILTERS_SCENARIO } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * roadmap-stale-filters: a saved PRD or goal filter that is no longer on the Simple roadmap
 * (the PRD moved to Trash, the goal archived) never hides every item. Saved: it is dropped
 * and the cleaned filters are saved back once, quietly. From a link (?prd=): a one-line note
 * with Clear instead of an empty page, and the PRD select names it "Not on this roadmap",
 * never "All". Driven through the UI against the mock (invented PRD "retired-example-prd"
 * and goal "retired-example-goal" that the mock roadmap does not hold); desktop (1366x820)
 * and phone (390x844).
 */

const ROADMAP = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const filter = (page: Page, name: string): Locator => page.getByRole("combobox", { name, exact: true });
const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function openBoard(page: Page) {
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
}

/** A phone's pickers sit behind the Filters button (qa-shell-24). */
async function showPickers(page: Page) {
  const toggle = page.getByTestId("filters-toggle");
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test("saved filters that are no longer on the roadmap are dropped and saved back", async ({ page }) => {
      await page.addInitScript(([key, scenario]) => localStorage.setItem(key, scenario), [MOCK_SCENARIO_KEY, STALE_SIMPLE_FILTERS_SCENARIO] as const);
      const saves: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "PATCH" && new URL(r.url()).pathname === "/v1/me/preferences") saves.push(r.postDataJSON());
      });
      await login(page);
      await openBoard(page);
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
      await expect(boardCard(page, "setup-checklist")).toHaveCount(1);
      await expect(page.getByText("Nothing matches these filters")).toHaveCount(0);
      await showPickers(page);
      for (const name of ["PRD", "Goal", "Track"]) {
        await expect(filter(page, name)).toHaveValue("");
        await expect(filter(page, name).locator("option:checked")).toHaveText("All");
      }
      // Saved back once, quietly: no toast.
      await expect.poll(() => saves).toEqual([{ simple_filters: { prd: "", goal: "", track: "" } }]);
      await expect(page.getByRole("status").filter({ hasText: "filters" })).toHaveCount(0);
      // Coming back, the items are still there and nothing more is saved.
      await openBoard(page);
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
      await expect(page.getByText("Nothing matches these filters")).toHaveCount(0);
      expect(saves).toHaveLength(1);
    });

    test("a link to a PRD no longer on the roadmap says so, with Clear", async ({ page }) => {
      await login(page);
      await page.goto(`${ROADMAP}?prd=retired-example-prd`);
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      const note = page.getByTestId("filters-gone");
      await expect(note).toBeVisible();
      await expect(note).toContainText("That PRD is no longer on this roadmap");
      await expect(page.getByText("Nothing matches these filters")).toHaveCount(0);
      await showPickers(page);
      await expect(filter(page, "PRD").locator("option:checked")).toHaveText("Not on this roadmap");
      await note.getByRole("button", { name: "Clear" }).click();
      await expect(note).toHaveCount(0);
      await page.getByTestId("format-board").click();
      await expect(page.getByTestId("board")).toBeVisible();
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
      await showPickers(page);
      await expect(filter(page, "PRD").locator("option:checked")).toHaveText("All");
    });
  });
}

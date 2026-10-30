import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The Simple roadmap's Roadmap filter, after review (#723): with All roadmaps the Key dates
 * editor lists every roadmap the person may read (not only those of the items shown), a
 * pick that could not be saved says so, and the PRD, Goal and Track filters are remembered
 * per person like the Roadmap filter. Driven through the UI against the mock (invented
 * roadmaps "Alerts roadmap" with PRD "Usage alerts" and "Onboarding roadmap" with PRD
 * "Guided setup", goal "Faster activation", track "Guided setup track"); desktop
 * (1366x820) and phone (390x844). Each test's card is in its comment.
 */

const ROADMAP = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const editor = (page: Page): Locator => page.getByTestId("key-dates-editor");
const kdRow = (scope: Locator, name: string): Locator => scope.locator(`[data-testid="key-date-row"][data-name="${name}"]`);
const group = (page: Page, roadmap: string): Locator => editor(page).locator(`[data-testid="key-dates-group"][data-roadmap="${roadmap}"]`);
const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });
const filter = (page: Page, name: string): Locator => page.getByRole("combobox", { name, exact: true });

async function openBoard(page: Page) {
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
  // qa-shell-24: a phone's pickers sit behind the Filters button.
  const toggle = page.getByTestId("filters-toggle");
  if (await toggle.isVisible()) await toggle.click();
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use(use);

    /**
     * Card roadmap-filter-keydates-all: protects = with All roadmaps and a PRD filter that
     * hides one roadmap's items, the Key dates editor still lists that roadmap and a key
     * date added to it is listed there afterwards; fails_when = the editor lists only the
     * roadmaps of the items shown (review minor 1); no_claim = the one-roadmap editor
     * (simple-roadmap-filter.spec.ts).
     */
    test("all roadmaps: a key date added to a roadmap the filters hide is listed", async ({ page }) => {
      await login(page);
      await openBoard(page);
      await filter(page, "PRD").selectOption({ label: "Usage alerts" });
      await expect(boardCard(page, "setup-checklist")).toHaveCount(0);
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
      await page.getByTestId("key-dates-open").click();
      await expect(kdRow(group(page, "Onboarding roadmap"), "Board meeting")).toBeVisible();
      await editor(page).getByLabel("New key date's name").fill("Partner summit");
      await editor(page).getByLabel("New key date's day").fill("2026-12-02");
      await editor(page).getByTestId("key-date-add-roadmap").selectOption({ label: "Onboarding roadmap" });
      await editor(page).getByRole("button", { name: "Add", exact: true }).click();
      await expect(toastWith(page, "Added the key date 'Partner summit' in your working draft")).toBeVisible();
      await expect(kdRow(group(page, "Onboarding roadmap"), "Partner summit")).toBeVisible();
      await expect(kdRow(group(page, "Alerts roadmap"), "Partner summit")).toHaveCount(0);
    });

    /**
     * Card roadmap-filter-save-failed: protects = a roadmap pick the server could not save
     * says so (and the board still shows the pick); the next pick that saves is the one
     * remembered; fails_when = a failed save is silent (review minor 2); no_claim = the
     * API's preferences (api/tests/test_simple_roadmap_filter_api.py).
     */
    test("a roadmap pick that could not be saved says so", async ({ page }) => {
      await login(page);
      await openBoard(page);
      await page.evaluate(() => localStorage.setItem("po-mock-fail-once", "PATCH /v1/me/preferences"));
      await page.getByTestId("filter-roadmap").selectOption({ label: "Onboarding roadmap" });
      await expect(page.getByTestId("roadmap-scope")).toHaveText("Onboarding roadmap");
      await expect(toastWith(page, "Could not remember this roadmap for next time")).toBeVisible();
      await openBoard(page);
      await expect(page.getByTestId("roadmap-scope")).toHaveText("All roadmaps");
      await page.getByTestId("filter-roadmap").selectOption({ label: "Alerts roadmap" });
      await expect(page.getByTestId("roadmap-scope")).toHaveText("Alerts roadmap");
      await expect(toastWith(page, "Could not remember")).toHaveCount(0);
      await openBoard(page);
      await expect(page.getByTestId("roadmap-scope")).toHaveText("Alerts roadmap");
    });

    /**
     * Card roadmap-filter-remembered: protects = the PRD, Goal and Track picks are kept per
     * person like the Roadmap filter: opening the roadmap again brings them back and the
     * board is narrowed by them; clearing one is remembered too; fails_when = only the
     * Roadmap filter is remembered (review minor 4); no_claim = the API's validation
     * (api/tests/test_simple_roadmap_filter_api.py).
     */
    test("PRD, Goal and Track picks are remembered", async ({ page }) => {
      await login(page);
      await openBoard(page);
      await filter(page, "PRD").selectOption({ label: "Guided setup" });
      await filter(page, "Goal").selectOption({ label: "Faster activation" });
      await filter(page, "Track").selectOption({ label: "Guided setup track" });
      await expect(boardCard(page, "alert-rules")).toHaveCount(0);
      await expect(boardCard(page, "setup-checklist")).toHaveCount(1);
      await openBoard(page);
      await expect(filter(page, "PRD")).toHaveValue("guided-setup");
      await expect(filter(page, "Goal")).toHaveValue("faster-activation");
      await expect(filter(page, "Track").locator("option:checked")).toHaveText("Guided setup track");
      await expect(boardCard(page, "alert-rules")).toHaveCount(0);
      await expect(boardCard(page, "setup-checklist")).toHaveCount(1);
      await filter(page, "Track").selectOption({ label: "All" });
      await filter(page, "Goal").selectOption({ label: "All" });
      await filter(page, "PRD").selectOption({ label: "All" });
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
      await openBoard(page);
      await expect(filter(page, "PRD")).toHaveValue("");
      await expect(filter(page, "Goal")).toHaveValue("");
      await expect(boardCard(page, "alert-rules")).toHaveCount(1);
    });
  });
}

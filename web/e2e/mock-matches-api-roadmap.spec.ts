import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The mock reads as the API does on the Simple roadmap (invented people and products, the mock's seed):
 * - a feature's parts are listed in roadmap order, open and cut mixed (additions._parts);
 * - the goal counters follow the lanes' goal order: every confirmed goal, the Goal map's too, in
 *   the one goal order (additions._goals);
 * - the panel's Status set to Cut is stored as the API stores it ({cut, shipped}) and the Removed
 *   list still says who cut it and when.
 */

const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");
const boardCard = (page: Page, key: string) => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function roadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function partOf(page: Page, parent: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Part of…" }));
  const form = panel(page).getByTestId("card-parent-edit");
  await form.getByLabel("Part of").selectOption({ label: parent });
  await tap(form.getByRole("button", { name: "Save", exact: true }));
  await expect(toasts(page)).toContainText(`part of ${parent} in your working draft`);
}

test("a feature's parts are listed in roadmap order, a cut one where it stands", async ({ page }) => {
  await login(page);
  await roadmap(page);
  await tap(page.getByTestId("format-board"));
  await expect(page.getByTestId("board")).toBeVisible();
  // Welcome video (open) first, then In-app tour (cut, before it on the roadmap).
  await tap(boardCard(page, "setup-video"));
  await partOf(page, "Setup checklist");
  await page.keyboard.press("Escape");
  await tap(boardCard(page, "setup-tour"));
  await expect(panel(page).getByTestId("item-cut")).toBeVisible();
  await partOf(page, "Setup checklist");
  await tap(panel(page).getByTestId("card-part-of").getByRole("button", { name: "Setup checklist" }));
  const parts = panel(page).getByTestId("card-parts").getByTestId("card-part");
  await expect(parts).toHaveText([/^In-app tour\s*\(cut\)$/, /^Welcome video$/]);
});

test("the goal counters follow the lanes' goal order, the Goal map's goals too", async ({ page }) => {
  await login(page);
  await roadmap(page);
  const cards = page.getByTestId("goal-counters").getByTestId("goal-counter");
  await expect(cards.first()).toBeVisible();
  // tb-mk: the Timeline's bands are tracks; the Waterfall keeps the goal lanes.
  await page.getByTestId("format-waterfall").click();
  // Track everywhere (owner Nov 10): the Waterfall starts in track bands.
  await expect(page.getByTestId("group-track")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chart-group").first()).toContainText(/track/i);
  // Its goal lanes are a Group by Goal away.
  await page.getByTestId("group-goal").click();
  await expect(page.getByTestId("group-goal")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chart-group").first()).toBeVisible();
  const onCards = (await cards.locator("p:first-child").allInnerTexts()).map((t) => t.replace(/^\s*\d+\s*/, "").trim());
  const onLanes = await page.getByTestId("chart-group").evaluateAll((els) => els.map((e) => e.getAttribute("data-add-label") ?? ""));
  expect(onCards).toContain("Sign-ups per rep per day");
  expect(onCards).toEqual(onLanes.filter((n) => onCards.includes(n)));
});

test("Cut from the panel's menu lists the feature as cut today, by who cut it", async ({ page }) => {
  await login(page);
  await roadmap(page);
  await openRoadmapItem(page, "alert-export");
  await expect(panel(page)).toBeVisible();
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Cut from the roadmap" }));
  await tap(page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }));
  await expect(panel(page).getByTestId("item-cut")).toHaveText(/^Cut on [A-Z][a-z]{2} \d+ by Avery Stone/);
  await page.keyboard.press("Escape");
  await tap(page.getByTestId("removed-open"));
  const list = page.getByRole("dialog", { name: "Removed from your plans" });
  await expect(list.getByTestId("removed-row").filter({ hasText: "Alert history export" })).toContainText(/Cut on [A-Z][a-z]{2} \d+ by Avery Stone/);
});

async function setStatus(page: Page, status: string, word: string) {
  await tap(panel(page).getByRole("button", { name: "Change the status" }));
  await panel(page).getByTestId("card-status-edit").getByLabel("Status").selectOption(status);
  await tap(panel(page).getByTestId("card-status-edit").getByRole("button", { name: "Save" }));
  await expect(panel(page).getByTestId("card-status")).toContainText(word);
}

// changes.py set_status: Planned clears only the panel's own mark and goes back to the tracker's status.
test("an in-progress feature set to Done then to Planned reads In progress again", async ({ page }) => {
  await login(page);
  await roadmap(page);
  await openRoadmapItem(page, "alert-rules");
  await expect(panel(page).getByTestId("card-status")).toContainText("In progress");
  await setStatus(page, "done", "Done");
  await setStatus(page, "planned", "In progress");
  await expect(panel(page).getByTestId("card-status")).not.toContainText("Planned");
});

// pm1 '⋯ menu by the close': Cut and Restore are the panel menu's; Restore is set_status planned.
test("an in-progress feature cut then restored from the panel's menu reads In progress again", async ({ page }) => {
  await login(page);
  await roadmap(page);
  await openRoadmapItem(page, "alert-rules");
  await expect(panel(page).getByTestId("card-status")).toContainText("In progress");
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Cut from the roadmap" }));
  await tap(page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }));
  await expect(panel(page).getByTestId("card-status")).toContainText("Cut");
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Restore to the roadmap" }));
  await expect(panel(page).getByTestId("card-status")).toContainText("In progress");
  await expect(panel(page).getByTestId("card-status")).not.toContainText("Planned");
});

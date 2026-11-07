import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * A merged feature whose kept feature is deleted (words follow-ups). Test card: protects = once
 * the kept feature is in Trash, the merged one's card on the board reads "Merged into a deleted
 * feature"; fails_when = it reads "Merged into" with nothing after it, the kept feature's key or
 * its old name; no_claim = the API's read (tests/test_merged_into_deleted.py). Mock API, made-up data.
 */

const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");
const boardCard = (page: Page, key: string) => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page, key: string) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function menu(page: Page, item: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: item }));
}

test("a feature merged into one that is then deleted reads 'Merged into a deleted feature'", async ({ page }) => {
  await login(page);
  await open(page, "alert-sso");
  await menu(page, "Merge into…");
  const form = panel(page).getByTestId("card-merge-edit");
  await form.getByLabel("Merge into").selectOption({ label: "Mobile alert push" });
  await tap(form.getByRole("button", { name: "Merge", exact: true }));
  await expect(toasts(page)).toContainText("Merged 'Alert routing by team' into Mobile alert push in your working draft");

  await open(page, "alert-mobile");
  await menu(page, "Delete feature");
  await expect(toasts(page)).toContainText("Moved Mobile alert push to Trash.");

  await page.goto("/simple/roadmap");
  await tap(page.getByTestId("format-board"));
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(boardCard(page, "alert-sso").getByTestId("item-merged")).toHaveText("Merged into a deleted feature");
});

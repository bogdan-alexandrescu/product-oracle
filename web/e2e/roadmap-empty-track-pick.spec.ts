import { ADMIN, login, openRoadmapItem } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * empty-track (owner, Nov 9: "Track without a PRD"; "PM owned on the roadmap becomes Account
 * Management track"): a track added in the Tracks sheet with no PRD holds nothing yet, and the
 * feature panel's Track field must still offer it, so its first item can be moved onto it.
 * protects = a new, empty track is a choice in an item's Track field and the item lands on it;
 * fails_when = the field lists only the tracks some item already sits on;
 * no_claim = the API's set_track rule (any existing track; api/tests).
 * Invented people and products (the mock's seed).
 */

const panel = (page: Page) => page.getByTestId("floating-card");
const sheet = (page: Page) => page.getByTestId("tracks-sheet");

test.use({ viewport: { width: 1440, height: 900 } });

test("an item moves onto a new track that has no PRD and no items yet", async ({ page }) => {
  await login(page, ADMIN.email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();

  await page.getByTestId("tracks-open").click();
  await sheet(page).getByTestId("track-add").click();
  await sheet(page).getByLabel("New track name").fill("Partner care track");
  await sheet(page).getByLabel("New track PRD").selectOption({ label: "No PRD" });
  await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("toasts")).toContainText("Added Partner care track");
  await expect(sheet(page).getByTestId("track-row").filter({ hasText: "Partner care track" })).toContainText("0 features");
  await page.getByRole("button", { name: "Close Tracks" }).click();

  await openRoadmapItem(page, "setup-import");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "Change the track" }).click();
  const pick = panel(page).getByTestId("card-track-edit").getByLabel("Track");
  await expect(pick.locator("option").filter({ hasText: "Partner care track" })).toHaveCount(1);
  await pick.selectOption({ label: "Partner care track" });
  await panel(page).getByTestId("card-track-edit").getByRole("button", { name: "Save" }).click();
  await expect(panel(page).getByTestId("card-track")).toHaveText("Partner care track");
});

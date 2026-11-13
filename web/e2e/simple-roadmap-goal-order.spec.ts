import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * effort-reader: an item's goal is the first of the goals it is linked to directly, in its own
 * goal order (service.load's goal_ids), as the API reads it. In the default scenario (invented
 * data), Alert history export serves no goal and Alert routing by team serves Grow retention;
 * merging the second into the first links the kept item to Grow retention.
 * protects = after the merge, Alert history export's panel reads Grow retention as its goal;
 * fails_when = the mock reads only an item's first stored goal and drops the goals a merge adds
 * (the panel reads no goal); no_claim = the API's merge (api/tests).
 */
const panel = (page: Page) => page.getByTestId("floating-card");

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

test("a merge links the kept item to the merged goal, and its panel reads it", async ({ page }) => {
  await login(page);
  await open(page, "alert-export");
  await expect(panel(page).getByTestId("card-goal")).not.toContainText("Grow retention");
  await open(page, "alert-sso");
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: "Merge into…" }));
  const form = panel(page).getByTestId("card-merge-edit");
  await form.getByLabel("Merge into").selectOption({ label: "F-88 Alert history export" });
  await tap(form.getByRole("button", { name: "Merge", exact: true }));
  await expect(page.getByTestId("toasts")).toContainText("Merged 'Alert routing by team' into F-88 Alert history export");
  await open(page, "alert-export");
  await expect(panel(page).getByTestId("card-goal")).toContainText("Grow retention");
});

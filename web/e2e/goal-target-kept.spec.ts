// goal-target-kept: the feature panel's goal fields never drop a measured goal's number and
// unit (targets.py set_goal_measure, goal_buckets.typed_target). Production (Nov 10): a goal's
// target and unit were lost from a quick edit, and the goal left the Goal map. Mock-backed.
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

const panel = (page: Page) => page.getByTestId("floating-card");

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function setTarget(page: Page, to: string) {
  await tap(panel(page).getByRole("button", { name: "Change the target", exact: true }));
  await panel(page).getByTestId("card-goal-target-edit").getByLabel("Target").fill(to);
  await tap(panel(page).getByTestId("card-goal-target-edit").getByRole("button", { name: "Save" }));
}

test("a measured goal's target stays a number in its unit; clearing it is refused", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, "setup-checklist");
  const target = panel(page).getByTestId("card-goal-target");
  await expect(target).toHaveText("2 days");

  // A new number typed alone keeps the goal's unit.
  await setTarget(page, "3");
  await expect(target).toHaveText("3 days");

  // Clearing it is refused, in plain words; the target stays.
  await setTarget(page, "");
  await expect(page.getByText("A measured goal keeps its target: type its new number").first()).toBeVisible();
  await expect(target).toHaveText("3 days");
});

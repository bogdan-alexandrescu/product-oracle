// goal-target-kept: the feature panel's goal fields never drop a measured goal's number and
// unit (targets.py set_goal_measure, goal_buckets.typed_target). Production (Nov 10): a goal's
// target and unit were lost from a quick edit, and the goal left the Goal map. Mock-backed.
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
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

test("a goal bucket's edit takes a bare number in the goal's unit", async ({ page }) => {
  // The buckets with no dated plan show the roadmap's goals, Faster activation ("2 days") among them.
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  const card = page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: "Faster activation", exact: true }) });
  const edit = card.getByRole("button", { name: "Edit Faster activation" });
  await edit.click();
  // Editing, the card's heading is the form's: the form is found on its own.
  const form = page.getByTestId("goal-form").filter({ has: page.getByRole("heading", { name: "Edit goal" }) });
  await expect(form.getByLabel("Target")).toHaveValue("2 days");
  await form.getByLabel("Target").fill("3");
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByTestId("bucket-note")).toContainText("Saved Faster activation: 3 days");
  // Opened again, the form reads the number in the goal's unit.
  await edit.click();
  await expect(form.getByLabel("Target")).toHaveValue("3 days");
});

test("a goal bucket's refusal names a money goal's unit as read, and takes commas only between thousands", async ({ page }) => {
  // In this scenario Revenue's target is stored as a number in usd; Faster activation's in days.
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "goal-buckets-undated"] as const);
  await login(page);
  await page.goto("/simple/priorities?tab=buckets");
  const form = page.getByTestId("goal-form").filter({ has: page.getByRole("heading", { name: "Edit goal" }) });

  const revenue = page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: "Revenue", exact: true }) });
  await revenue.getByRole("button", { name: "Edit Revenue" }).click();
  // goal-figure-words: the stored 20000 usd reads as people write it.
  await expect(form.getByLabel("Target")).toHaveValue("$20,000");
  await form.getByLabel("Target").fill("70 teams");
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByText("This goal is measured in $: type its new number").first()).toBeVisible();
  await expect(page.getByText("measured in usd")).toHaveCount(0);
  await page.goto("/simple/priorities?tab=buckets");

  const card = page.getByTestId("goal-bucket").filter({ has: page.getByRole("heading", { name: "Faster activation", exact: true }) });
  await card.getByRole("button", { name: "Edit Faster activation" }).click();
  await form.getByLabel("Target").fill("1,2");
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByText("Type the target as a number, like 60").first()).toBeVisible();
  await form.getByLabel("Target").fill("1,200");
  await form.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByTestId("bucket-note")).toContainText("Saved Faster activation: 1,200 days");
});

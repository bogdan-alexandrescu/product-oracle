import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITIES_PLAN_MILESTONES_SCENARIO } from "../lib/api/mock/simple-milestones";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * milestone-rename on Priorities (the owner, Nov 10: "make all milestones editable in place"): Goal buckets'
 * milestones (M1, M2, M3 of Guided setup's plan) open the Roadmap's own milestone card, with its rights: the PRD's
 * owner renames one in place (the code stays) with Undo; someone who may not change it asks the PRD's owner, and
 * the toast says so; a viewer reads it. Mock scenario "priorities-plan-milestones" (invented data). Desktop 1440x900.
 */

async function open(page: Page, email: string = ADMIN.email) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(
    ([key, value, themeKey]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, "light");
    },
    [MOCK_SCENARIO_KEY, PRIORITIES_PLAN_MILESTONES_SCENARIO, THEME_KEY] as const,
  );
  await login(page, email);
  await page.goto("/simple/priorities?tab=buckets");
  await expect(page.getByTestId("buckets-head")).toBeVisible();
}

const chip = (page: Page, code: string) => page.getByTestId("buckets-head").getByTestId("milestone-chip").filter({ hasText: new RegExp(`^${code} `) });
// A PRD's milestone opens the Roadmap's PRD milestone card.
const card = (page: Page) => page.getByTestId("ms-prd-card");

test("the PRD's owner renames M2 from Goal buckets; it goes straight in; Undo puts it back", async ({ page }) => {
  await open(page);
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Scale volume");
  await chip(page, "M2").getByRole("button", { name: "M2 Scale volume" }).click();
  await expect(card(page).getByRole("heading")).toContainText("Scale volume");
  await card(page).getByLabel("Name", { exact: true }).fill("Grow volume");
  await card(page).getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText("Grow volume saved");
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Grow volume");
  await page.getByTestId("ms-toast").getByRole("button", { name: "Undo" }).click();
  await expect(chip(page, "M2")).toHaveAttribute("title", "M2 Scale volume");
});

test("an approver who does not own the PRD asks its owner for a new name; the toast says so and the name waits", async ({ page }) => {
  await open(page, "approver@example.com");
  await chip(page, "M1").getByRole("button", { name: "M1 Prove it" }).click();
  await expect(card(page).getByRole("heading")).toContainText("Prove it");
  await card(page).getByLabel("Name", { exact: true }).fill("Prove it twice");
  await card(page).getByRole("button", { name: "Ask to change it" }).click();
  await expect(page.getByTestId("ms-toast")).toContainText(/^Asked .+ to rename M\d Prove it/);
  await expect(chip(page, "M1")).toHaveAttribute("title", "M1 Prove it");
});

test("a viewer reads a milestone's card from Goal buckets, its name not a field to change", async ({ page }) => {
  await open(page, "viewer@example.com");
  await chip(page, "M3").getByRole("button", { name: "M3 Open to all" }).click();
  await expect(card(page).getByRole("heading")).toContainText("Open to all");
  await expect(card(page).getByLabel("Name", { exact: true })).not.toBeEditable();
});

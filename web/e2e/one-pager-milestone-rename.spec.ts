import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ONE_PAGER_MILESTONE_RENAME_SCENARIO } from "../lib/api/mock/simple-milestones";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * one-pager-milestone-rename (the owner, Nov 10: "make all milestones editable in place ... a name
 * change in a milestone one doesn't own should still be allowed as a proposal for the owner to
 * approve"): a milestone row of a PRD one-pager's Timeline strip renames its roadmap milestone in
 * place with the Roadmap's own card, as Home's rows do (home-milestone-rename.spec.ts): its rights,
 * Undo, the proposal to the roadmap's decider. Mock scenario "one-pager-milestone-rename": Usage
 * alerts' Weekly alert digest has the Alerts roadmap's M1 "Alerts live for 50 teams" picked; invented data.
 *
 * Card one-pager-rename-owner: protects = the owner renames M1 from the strip, the row reads the new
 * name, Undo puts it back, the Roadmap reads the kept one; fails_when = the strip row has no rename.
 * Card one-pager-rename-propose: protects = a commenter proposes the name from the strip, the row
 * keeps its name; fails_when = no rename for them, or the name changes without the owner.
 */

const URL = "/simple/one-pagers/usage-alerts";
const OLD = "M1 · Alerts live for 50 teams";

test.use({ viewport: { width: 1440, height: 900 } });

async function onePager(page: Page, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, ONE_PAGER_MILESTONE_RENAME_SCENARIO] as const);
  await login(page, email);
  await page.goto(URL);
  await expect(label(page, OLD)).toBeVisible();
}

const strip = (page: Page) => page.getByLabel("Timeline strip");
const label = (page: Page, name: string) => strip(page).getByTestId("plan-strip-label").filter({ hasText: name });
const card = (page: Page) => page.getByTestId("ms-card");
const toast = (page: Page) => page.getByTestId("ms-toast");

test("the owner renames M1 in place on the one-pager's Timeline strip; Undo puts it back; the Roadmap reads the kept name", async ({ page }) => {
  await onePager(page);
  await strip(page).getByRole("button", { name: `Rename ${OLD}` }).click();
  await expect(card(page).getByRole("heading", { name: "Edit M1" })).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-rights", "change");
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-save").click();
  await expect(toast(page)).toContainText("M1 Alerts live for 80 teams saved");
  await expect(label(page, "M1 · Alerts live for 80 teams")).toBeVisible();
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(label(page, OLD)).toBeVisible();

  // Again, kept this time: the Roadmap reads it.
  await strip(page).getByRole("button", { name: `Rename ${OLD}` }).click();
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-save").click();
  await expect(label(page, "M1 · Alerts live for 80 teams")).toBeVisible();
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-label").filter({ hasText: "M1 Alerts live for 80 teams" }).first()).toBeVisible();
});

test("a commenter proposes a new name from the one-pager's Timeline strip; the row keeps its name", async ({ page }) => {
  await onePager(page, "commenter@example.com");
  await strip(page).getByRole("button", { name: `Rename ${OLD}` }).click();
  await expect(card(page)).toHaveAttribute("data-rights", "propose");
  await expect(card(page).getByTestId("ms-save")).toHaveCount(0);
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-propose").click();
  await expect(toast(page)).toContainText("Proposed a change to M1 Alerts live for 50 teams");
  await expect(card(page)).toHaveCount(0);
  await expect(label(page, OLD)).toBeVisible();
});

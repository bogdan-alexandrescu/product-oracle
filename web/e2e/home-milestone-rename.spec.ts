import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * home-milestone-rename (the owner, Nov 10: "make all milestones editable in place"): a milestone
 * row of Home's plan ("M1 · Alerts live for 50 teams · 1 item") renames its milestone in place,
 * with the Roadmap's own card: its code fixed before the name. Who changes the roadmap saves it,
 * with Undo, and the new name reads on Home and on the Roadmap; a commenter proposes it to the
 * roadmap's decider ("Proposed a change to ..."), and it waits in Needs a decision. Mock
 * scenario "simple-milestones"; invented goals, milestones and people.
 *
 * Card home-rename-owner: protects = the owner renames M1 from Home and reads the new name on
 * Home and on the Roadmap; Undo puts it back; fails_when = Home's row has no way to rename it.
 * Card home-rename-propose: protects = a commenter proposes the name from Home, the toast says
 * so, the row keeps its name and the roadmap's owner finds it in Needs a decision; fails_when =
 * no rename for them on Home, or the proposal does not reach Needs a decision.
 */

const COMMENTER = "commenter@example.com";
const OLD = "M1 · Alerts live for 50 teams";

test.use({ viewport: { width: 1440, height: 900 } });

async function home(page: Page, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-milestones"] as const);
  await login(page, email);
  await page.goto("/simple");
  await expect(page.getByRole("heading", { name: "The plan this quarter" })).toBeVisible();
  await expect(row(page, OLD)).toBeVisible();
}

const row = (page: Page, name: string) => page.getByTestId("home-strip-line").filter({ has: page.getByTestId("home-strip-label").filter({ hasText: name }) });
const card = (page: Page) => page.getByTestId("ms-card");
const toast = (page: Page) => page.getByTestId("ms-toast");

test("the roadmap's owner renames M1 in place on Home; the new name reads on Home and the Roadmap; Undo puts it back", async ({ page }) => {
  await home(page);
  await row(page, OLD).getByRole("button", { name: `Rename ${OLD}` }).click();
  await expect(card(page).getByRole("heading", { name: "Edit M1" })).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-rights", "change");
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-save").click();
  await expect(toast(page)).toContainText("M1 Alerts live for 80 teams saved");
  await expect(page.getByTestId("home-strip-label").filter({ hasText: "M1 · Alerts live for 80 teams" })).toBeVisible();
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("home-strip-label").filter({ hasText: OLD })).toBeVisible();

  // Again, kept this time: the Roadmap reads it.
  await row(page, OLD).getByRole("button", { name: `Rename ${OLD}` }).click();
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-save").click();
  await expect(page.getByTestId("home-strip-label").filter({ hasText: "M1 · Alerts live for 80 teams" })).toBeVisible();
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-label").filter({ hasText: "M1 Alerts live for 80 teams" })).toBeVisible();
});

test("a commenter proposes a new name from Home; it waits for the roadmap's owner in Needs a decision", async ({ page }) => {
  await home(page, COMMENTER);
  await row(page, OLD).getByRole("button", { name: `Rename ${OLD}` }).click();
  await expect(card(page)).toHaveAttribute("data-rights", "propose");
  await expect(card(page).getByTestId("ms-save")).toHaveCount(0);
  await card(page).getByLabel("Name", { exact: true }).fill("Alerts live for 80 teams");
  await card(page).getByTestId("ms-propose").click();
  await expect(toast(page)).toContainText("Proposed a change to M1 Alerts live for 50 teams");
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("home-strip-label").filter({ hasText: OLD })).toBeVisible();

  // The roadmap's owner signs in and finds it where the roadmap's proposals wait.
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("needs-decision").click();
  const proposal = page.getByTestId("decision-tray").getByTestId("tray-proposal").filter({ hasText: "Milestone 'M1 Alerts live for 50 teams': change it" });
  await expect(proposal).toBeVisible();
});

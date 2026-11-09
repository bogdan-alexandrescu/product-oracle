import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * tracks-goal (owner, Nov 9): tracks become the Roadmap's bands in place of goals, so a track
 * may have no PRD and may be tied to one company goal. Through Simple > Roadmap > Tracks, as a
 * person would: add a track with No PRD and no goal, set another track's Goal, and read both
 * after a reload; an Add or Propose that is off says why. Invented tracks and goals (the mock's
 * seed).
 */

const sheet = (page: Page) => page.getByTestId("tracks-sheet");
const row = (page: Page, title: string) => sheet(page).getByTestId("track-row").filter({ has: page.getByText(title, { exact: true }) });
const toasts = (page: Page) => page.getByTestId("toasts");

async function openSheet(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("tracks-open").click();
  await expect(sheet(page).getByTestId("track-row").first()).toBeVisible();
}

test.describe("Tracks: a track's PRD and goal", () => {
  test("an owner adds a track with No PRD and no goal, sets another track's Goal, and both stay after a reload", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await openSheet(page);

    await sheet(page).getByTestId("track-add").click();
    await sheet(page).getByLabel("New track name").fill("Account Management");
    await sheet(page).getByLabel("New track PRD").selectOption({ label: "No PRD" });
    await expect(sheet(page).getByLabel("New track goal")).toHaveValue("");
    await sheet(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(toasts(page)).toContainText("Added Account Management");
    await expect(row(page, "Account Management")).toBeVisible();

    await sheet(page).getByRole("button", { name: "Change Guided setup track" }).click();
    const guided = row(page, "Guided setup track");
    await guided.getByLabel("Goal", { exact: true }).selectOption({ label: "Growth" });
    await expect(toasts(page)).toContainText("Guided setup track's goal is now Growth");

    await page.reload();
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("tracks-open").click();
    await sheet(page).getByRole("button", { name: "Change Account Management" }).click();
    const added = row(page, "Account Management");
    await expect(added.getByLabel("PRD", { exact: true })).toHaveValue("");
    await expect(added.getByLabel("PRD", { exact: true }).locator("option:checked")).toHaveText("No PRD");
    await expect(added.getByLabel("Goal", { exact: true }).locator("option:checked")).toHaveText("No goal");
    await sheet(page).getByRole("button", { name: "Change Guided setup track" }).click();
    await expect(row(page, "Guided setup track").getByLabel("Goal", { exact: true }).locator("option:checked")).toHaveText("Growth");
  });

  test("an Add with no name is off and says why in its tooltip", async ({ page }) => {
    await login(page);
    await openSheet(page);
    await sheet(page).getByTestId("track-add").click();
    const add = sheet(page).getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute("title", "Name the track");
    await sheet(page).getByLabel("New track name").fill("   ");
    await expect(add).toHaveAttribute("title", "Name the track");
    await sheet(page).getByLabel("New track name").fill("Account Management");
    await expect(add).toBeEnabled();
  });
});

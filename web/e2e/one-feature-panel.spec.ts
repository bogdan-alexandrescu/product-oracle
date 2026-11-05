import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * One feature panel (BGD, Nov 4): a feature opens the same panel from the Roadmap, Priorities
 * and a one-pager's plan rows, its code before its name; every field is changed there, saved
 * through the change engine with Undo. A viewer reads it with no edit controls. Driven against
 * the mock's default scenario (Weekly alert digest, F-06, depends on Alert rules engine).
 */

const SIZES = [
  { name: "1440", use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

const panel = (page: Page) => page.getByTestId("floating-card");

async function rename(page: Page, to: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(page.getByRole("menuitem", { name: "Rename" }));
  await panel(page).getByLabel("Name").fill(to);
  await tap(panel(page).getByRole("button", { name: "Save" }));
  await expect(panel(page).getByTestId("card-name")).toContainText(to);
}

/** Moves the end a week later; returns the new end as typed (YYYY-MM-DD). */
async function laterEnd(page: Page): Promise<string> {
  await tap(panel(page).getByRole("button", { name: "Change the dates" }));
  const end = panel(page).getByTestId("card-dates-edit").getByLabel("End", { exact: true });
  const was = await end.inputValue();
  const next = new Date(Date.parse(`${was}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  await end.fill(next);
  await tap(panel(page).getByTestId("card-dates-edit").getByRole("button", { name: "Save" }));
  return next;
}

/** "Dec 18": the month-first words the panel shows for a day. */
const monthDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use(size.use);

    test("the Roadmap's panel changes the name, the end, a dependency and the goal, with Undo", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "alert-digest");
      await expect(panel(page)).toBeVisible();
      // The code chip comes before the name.
      await expect(panel(page).getByTestId("card-name")).toHaveText(/^F-06\s*Weekly alert digest/);

      await rename(page, "Weekly alert summary");

      const end = await laterEnd(page);
      await expect(panel(page).getByTestId("card-dates")).toContainText(monthDay(end));

      // Add a dependency from the picker (code and name), then remove it.
      const deps = panel(page).getByTestId("card-depends");
      await expect(deps).toContainText("Alert rules engine");
      await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
      await panel(page).getByLabel("Feature it depends on").selectOption({ label: "Alert history export" });
      await tap(panel(page).getByRole("button", { name: "Save" }));
      await expect(deps.getByTestId("card-depends-row").filter({ hasText: "Alert history export" })).toBeVisible();
      await tap(panel(page).getByRole("button", { name: "Remove Alert history export from what it depends on" }));
      await expect(deps.getByTestId("card-depends-row").filter({ hasText: "Alert history export" })).toHaveCount(0);
      await expect(deps).toContainText("Alert rules engine");

      // Change the goal, then Undo it from the toast.
      const goal = panel(page).getByTestId("card-goal");
      await expect(goal).toContainText("Grow retention");
      await tap(panel(page).getByRole("button", { name: "Change the goal" }));
      const pick = panel(page).getByTestId("card-goal-edit").getByLabel("Goal");
      const faster = (await pick.locator("option").allTextContents()).find((t) => t.startsWith("Faster activation"));
      expect(faster).toBeTruthy();
      await pick.selectOption({ label: faster! });
      await tap(panel(page).getByTestId("card-goal-edit").getByRole("button", { name: "Save" }));
      await expect(goal).toContainText("Faster activation");
      await tap(page.getByRole("button", { name: "Undo" }).last());
      await expect(goal).toContainText("Grow retention");
      await expect(panel(page).getByTestId("card-name")).toContainText("Weekly alert summary");
    });

    test("a Priorities row opens the same panel, and its name changes there", async ({ page }) => {
      await login(page);
      await page.goto("/simple/priorities");
      const title = page.getByTestId("prio-title").first();
      await expect(title).toBeVisible();
      const name = (await title.innerText()).trim();
      await tap(title);
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByTestId("card-name")).toContainText(name);
      await expect(panel(page).getByTestId("card-depends")).toBeVisible();
      await expect(panel(page).getByTestId("card-goal")).toBeVisible();
      await rename(page, `${name} renamed`);
    });

    test("a one-pager's plan row opens the same panel, code first, and its end changes there", async ({ page }) => {
      await login(page);
      await page.goto("/simple/prds/guided-setup");
      const open = page.getByLabel("Timeline strip").getByTestId("plan-strip-item-open").filter({ hasText: "Setup checklist" });
      await expect(open).toBeVisible();
      await tap(open);
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByTestId("card-name")).toContainText("Setup checklist");
      const end = await laterEnd(page);
      await expect(panel(page).getByTestId("card-dates")).toContainText(monthDay(end));
    });

    test("a viewer reads the panel with no edit controls", async ({ page }) => {
      await login(page, "viewer@example.com");
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "alert-digest");
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).getByTestId("card-depends")).toContainText("Alert rules engine");
      await expect(panel(page).getByTestId("card-goal")).toContainText("Grow retention");
      await expect(panel(page).getByRole("button", { name: /^Change the / })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "More actions" })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "Add a dependency" })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: /^Remove / })).toHaveCount(0);
    });
  });
}

test("a feature a decision blocks opens its panel from Decisions, its code first", async ({ page }) => {
  await login(page);
  await page.goto("/simple/decisions");
  const feature = page.getByTestId("question-blocks-feature").filter({ hasText: "Health log" }).first();
  await expect(feature).toHaveText("F-03 Health log");
  await tap(feature);
  await expect(page.getByTestId("item-panel")).toBeVisible();
});

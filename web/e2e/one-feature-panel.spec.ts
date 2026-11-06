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

    test("the panel changes how the feature's goal is measured, its target and date, with Undo", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "alert-digest");
      const measure = panel(page).getByTestId("card-goal-measure");
      await expect(measure).toHaveText("Teams active after 90 days");
      await tap(panel(page).getByRole("button", { name: "Change the measure" }));
      await panel(page).getByTestId("card-goal-measure-edit").getByLabel("Measure").fill("Teams active after 60 days");
      await tap(panel(page).getByTestId("card-goal-measure-edit").getByRole("button", { name: "Save" }));
      await expect(measure).toHaveText("Teams active after 60 days");
      await tap(page.getByRole("button", { name: "Undo" }).last());
      await expect(measure).toHaveText("Teams active after 90 days");

      // Its target and its date, each changed in place (the date month first).
      const target = panel(page).getByTestId("card-goal-target");
      await expect(target).toHaveText("70% of teams");
      await tap(panel(page).getByRole("button", { name: "Change the target", exact: true }));
      await panel(page).getByTestId("card-goal-target-edit").getByLabel("Target").fill("75% of teams");
      await tap(panel(page).getByTestId("card-goal-target-edit").getByRole("button", { name: "Save" }));
      await expect(target).toHaveText("75% of teams");
      const date = panel(page).getByTestId("card-goal-date");
      await expect(date).toHaveText("Mar 31, 2027");
      await tap(panel(page).getByRole("button", { name: "Change the date", exact: true }));
      await panel(page).getByTestId("card-goal-date-edit").getByLabel("Date").fill("2027-06-30");
      await tap(panel(page).getByTestId("card-goal-date-edit").getByRole("button", { name: "Save" }));
      await expect(date).toHaveText("Jun 30, 2027");
      await expect(target).toHaveText("75% of teams");
      await expect(measure).toHaveText("Teams active after 90 days");
    });

    test("a commenter's change to the goal's measure is a suggestion; nothing changes yet", async ({ page }) => {
      await login(page, "commenter@example.com");
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "alert-digest");
      const measure = panel(page).getByTestId("card-goal-measure");
      await expect(measure).toHaveText("Teams active after 90 days");
      await tap(panel(page).getByRole("button", { name: "Change the measure" }));
      await panel(page).getByTestId("card-goal-measure-edit").getByLabel("Measure").fill("Teams active after 60 days");
      await tap(panel(page).getByTestId("card-goal-measure-edit").getByRole("button", { name: "Save" }));
      await expect(page.getByText(/Measure changed proposed/).first()).toBeVisible();
      await expect(measure).toHaveText("Teams active after 90 days");
    });

    test("the owner picked in the panel is the name the Owner field shows", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "alert-digest");
      await tap(panel(page).getByRole("button", { name: "Change the owner" }));
      const pick = panel(page).getByTestId("card-owner-edit").getByLabel("Owner");
      await expect(pick.locator("option").nth(1)).toBeAttached();
      const names = (await pick.locator("option").allTextContents()).slice(1);
      const name = names[names.length - 1];
      await pick.selectOption({ label: name });
      await tap(panel(page).getByTestId("card-owner-edit").getByRole("button", { name: "Save" }));
      await expect(panel(page).getByTestId("card-owner")).toHaveText(name);
    });

    test("another PRD's feature added as a dependency reads code and name and opens its panel; an unknown key is refused", async ({ page }) => {
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(page, "setup-checklist");
      await expect(panel(page).getByTestId("card-name")).toContainText("Setup checklist");
      await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
      await panel(page).getByLabel("Feature it depends on").selectOption({ label: "F-06 Weekly alert digest" });
      await tap(panel(page).getByRole("button", { name: "Save" }));
      const dep = panel(page).getByTestId("card-depends-row").getByRole("button", { name: /^F-06\s*Weekly alert digest$/ });
      await expect(dep).toBeVisible();
      await expect(panel(page).getByTestId("card-depends")).not.toContainText("Feature F-06");

      await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
      await panel(page).getByLabel("Or another PRD's feature key").fill("F-404");
      await tap(panel(page).getByRole("button", { name: "Save" }));
      await expect(page.getByText(/no item or feature has the key F-404/).first()).toBeVisible();
      await expect(panel(page).getByTestId("card-depends")).not.toContainText("F-404");

      await tap(dep);
      await expect(panel(page).getByTestId("card-name")).toHaveText(/^F-06\s*Weekly alert digest/);
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

for (const size of SIZES) {
  test.describe(`${size.name} Decisions`, () => {
    test.use(size.use);

    test("a feature a decision blocks opens its own panel from Decisions, its code first, editable", async ({ page }) => {
      await login(page);
      await page.goto("/simple/decisions");
      const feature = page.getByRole("button", { name: "F-03 Health log" }).first();
      await expect(feature).toBeVisible();
      await tap(feature);
      await expect(panel(page).getByTestId("card-name")).toHaveText(/^F-03\s*Health log/);
      await expect(panel(page).getByRole("button", { name: "Change the outcome" })).toBeVisible();
      await expect(page.getByText("This feature is not on a roadmap you can see yet")).toHaveCount(0);
    });
  });
}

test.describe("Goal map", () => {
  test.use(SIZES[0].use);

  test("every Goal map feature opens its own panel, its code before its name", async ({ page }) => {
    // protects=every feature card on the ladder opens the roadmap's item panel for it, the code
    // chip before the name; fails_when=a card opens nothing or the wrong item; no_claim=the panel's
    // own edits (the roadmap specs).
    await login(page);
    await page.goto("/simple/goals");
    await expect(page.getByTestId("gm-page")).toBeVisible();
    const cards = page.getByTestId("ld-feature");
    // Each card's code chip, from its roadmap item.
    await expect(cards.first().locator(".simple-code")).toHaveText(/^F-\d+$/);
    const n = await cards.count();
    expect(n).toBeGreaterThan(5);
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      const words = (await card.locator("span.font-semibold").first().innerText()).trim();
      const code = words.match(/^F-\d+/)?.[0];
      expect(code, words).toBeTruthy();
      const name = words.replace(/^F-\d+\s*/, "");
      // On the ladder, a click only selects the card: Open (or Enter) opens its panel.
      await tap(card);
      await card.getByTestId("ld-open").click();
      await expect(panel(page).getByTestId("card-name")).toHaveText(new RegExp(`^${code}\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      await page.getByRole("button", { name: "Close the feature" }).click({ position: { x: 5, y: 5 } });
      await expect(panel(page)).toHaveCount(0);
    }
  });
});

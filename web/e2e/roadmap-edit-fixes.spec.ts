import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * roadmap-edit-fixes (Nov 5): what applying many roadmap changes through Simple's feature panel
 * met, walked as an owner (and as an approver, whose change is a proposal), on a desktop
 * (1440x900) and a phone (390x844).
 *
 * - protects = removing a dependency on another PRD's feature (stored by that feature's key)
 *   sticks: after a reload the panel no longer lists it; fails_when = it is listed again (or
 *   twice); no_claim = the real API (its pytest).
 * - protects = a coded item's Rename shows and changes the name alone, and the code stays;
 *   fails_when = the field shows the code, or the code is gone after the rename.
 * - protects = an item set to depend on one that already depends on it is refused with the
 *   loop named, for the owner and the approver alike; fails_when = the loop is stored.
 * - protects = a new item's dependency ideas from Oracle are suggestions a person adds, and a
 *   person's outcome typed while Oracle drafts stays; fails_when = Oracle's draft adds a
 *   dependency on its own, or overwrites the person's outcome.
 */

const ROADMAP = "/simple/roadmap";
const panel = (page: Page) => page.getByTestId("floating-card");

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page, key: string) {
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.context().addInitScript(
        ([key, value]) => {
          if (!sessionStorage.getItem("roadmap-edit-fixes")) {
            localStorage.removeItem("po-mock-db-v2");
            sessionStorage.setItem("roadmap-edit-fixes", "1");
          }
          localStorage.setItem(key, value);
        },
        [MOCK_SCENARIO_KEY, "roadmap-edit-fixes"] as const,
      );
    });

    test(`removing a dependency on another PRD's feature sticks (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "setup-checklist");
      const deps = panel(page).getByTestId("card-depends");
      await expect(deps.getByTestId("card-depends-row")).toHaveCount(1);
      await expect(deps).toContainText("Alert rules engine");
      await tap(panel(page).getByRole("button", { name: "Remove Alert rules engine from what it depends on" }));
      await expect(page.getByRole("status").filter({ hasText: "Dependency removed" })).toBeVisible();
      await expect(deps).toContainText("Nothing");
      await page.reload();
      await open(page, "setup-checklist");
      await expect(panel(page).getByTestId("card-depends")).toContainText("Nothing");
      await expect(panel(page).getByTestId("card-depends-row")).toHaveCount(0);
    });

    test(`a rename keeps the item's code (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "setup-video");
      const name = panel(page).getByTestId("card-name");
      await expect(name.locator(".simple-code")).toHaveText("F-07");
      await expect(name.locator("h2")).toHaveText(/^Welcome video/);
      await tap(panel(page).getByRole("button", { name: "More actions" }));
      await tap(page.getByRole("menuitem", { name: "Rename" }));
      await expect(panel(page).getByLabel("Name")).toHaveValue("Welcome video");
      await panel(page).getByLabel("Name").fill("Welcome film");
      await tap(panel(page).getByRole("button", { name: "Save" }));
      await expect(name.locator("h2")).toHaveText(/^Welcome film/);
      await expect(name.locator(".simple-code")).toHaveText("F-07");
      await page.reload();
      await open(page, "setup-video");
      await expect(panel(page).getByTestId("card-name").locator(".simple-code")).toHaveText("F-07");
      await expect(panel(page).getByTestId("card-name").locator("h2")).toHaveText(/^Welcome film/);
    });

    for (const who of ["owner", "approver"] as const) {
      test(`a dependency that would close a loop is refused, as the ${who} (${where})`, async ({ page }) => {
        await login(page, who === "owner" ? undefined : "approver@example.com");
        // Weekly alert digest already depends on Alert rules engine.
        await open(page, "alert-rules");
        await tap(panel(page).getByRole("button", { name: "Add a dependency" }));
        const pick = panel(page).getByLabel("Feature it depends on");
        const digest = (await pick.locator("option").allTextContents()).find((t) => t.includes("Weekly alert digest"));
        expect(digest).toBeTruthy();
        await pick.selectOption({ label: digest! });
        await tap(panel(page).getByRole("button", { name: "Save" }));
        await expect(page.getByText("F-06 Weekly alert digest already depends on Alert rules engine")).toBeVisible();
        await expect(panel(page).getByTestId("card-depends")).toContainText("Nothing");
        await page.reload();
        await open(page, "alert-rules");
        await expect(panel(page).getByTestId("card-depends")).toContainText("Nothing");
      });
    }

    test(`Oracle's dependency ideas for a new item are suggestions, and a person's outcome stays (${where})`, async ({ page }) => {
      await login(page);
      await page.goto(ROADMAP);
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await page.getByTestId("quick-add-open").click();
      const sheet = page.getByRole("dialog", { name: "Add an item" });
      await sheet.getByLabel("Title").fill("Snooze an alert");
      await sheet.getByLabel("Roadmap").selectOption({ label: "Alerts roadmap" });
      const goal = (await sheet.getByLabel("Where").locator("option").allTextContents()).find((t) => t.includes("Grow retention"));
      expect(goal).toBeTruthy();
      await sheet.getByLabel("Where").selectOption({ label: goal! });
      await sheet.getByRole("button", { name: "Add", exact: true }).click();
      await expect(sheet).toBeHidden();
      await openRoadmapItem(page, "snooze-an-alert");
      const card = panel(page);
      await expect(card.getByTestId("item-drafting")).toHaveText("Oracle is drafting…");
      // The person types the outcome while Oracle drafts.
      await tap(card.getByRole("button", { name: "Change the outcome" }));
      await card.getByLabel("Outcome").fill("Admins pause one noisy alert for a day");
      await tap(card.getByRole("button", { name: "Save" }));
      await expect(card.getByTestId("card-outcome")).toContainText("Admins pause one noisy alert for a day");
      await expect(card.getByTestId("item-drafting")).toHaveCount(0, { timeout: 10_000 });
      await expect(card.getByTestId("card-outcome")).toContainText("Admins pause one noisy alert for a day");
      // Oracle's idea is a suggestion: nothing is added until the person adds it.
      await expect(card.getByTestId("card-depends")).toContainText("Nothing");
      const idea = card.getByTestId("card-depends-idea");
      await expect(idea).toHaveCount(1);
      await expect(idea).toContainText("Oracle suggests");
      await tap(idea.getByRole("button", { name: /^Add / }));
      await expect(card.getByTestId("card-depends-row")).toHaveCount(1);
      await expect(card.getByTestId("card-depends-idea")).toHaveCount(0);
    });
  });
}

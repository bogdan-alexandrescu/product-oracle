import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * roadmap-edit-fixes round 1 (Nov 5, after the first seven fixes): what applying the owner's
 * roadmap answers through Simple's feature panel met, walked as an owner on a desktop
 * (1440x900) and a phone (390x844). The "roadmap-edit-fixes-2" scenario: Alert history export
 * waits on the Weekly alert digest by its code in lower case (f-06); Sample data import waits on
 * the Setup checklist by its key and by its feature's key; the Alert rules engine is done; the
 * cut In-app tour waits on the Setup checklist past its own start.
 *
 * - protects = a dependency stored by a code is listed as that item, the item lists it under
 *   Needed by, and its x removes it at once and for good; fails_when = Needed by reads None, or
 *   it is back after a reload; no_claim = the real API (its pytest).
 * - protects = a dependency stored under two keys goes with one x; fails_when = the other key
 *   keeps it after the click or a reload.
 * - protects = a done dependency is no broken link: no callout on the roadmap, no warning in the
 *   panel; fails_when = the digest is flagged for starting before the done engine ends.
 * - protects = a cut item's own link counts nowhere: Needs a decision lists no broken link from
 *   it to what it depends on; fails_when = In-app tour is listed for the Setup checklist.
 * - protects = a change made in a panel opened from Priorities shows on Priorities at once (Cut
 *   takes the row away while the panel is still open); fails_when = the row stays until the
 *   panel is closed or the page reloaded.
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
          if (!sessionStorage.getItem("roadmap-edit-fixes-2")) {
            localStorage.removeItem("po-mock-db-v2");
            sessionStorage.setItem("roadmap-edit-fixes-2", "1");
          }
          localStorage.setItem(key, value);
        },
        [MOCK_SCENARIO_KEY, "roadmap-edit-fixes-2"] as const,
      );
    });

    test(`a dependency stored by its code is listed both ways and removable (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "alert-digest");
      await expect(panel(page).getByTestId("card-needed")).toContainText("Alert history export");
      await open(page, "alert-export");
      const deps = panel(page).getByTestId("card-depends");
      await expect(deps.getByTestId("card-depends-row")).toHaveCount(1);
      await expect(deps).toContainText("Weekly alert digest");
      await tap(panel(page).getByRole("button", { name: "Remove Weekly alert digest from what it depends on" }));
      await expect(page.getByRole("status").filter({ hasText: "Dependency removed" })).toBeVisible();
      await expect(deps).toContainText("Nothing");
      await page.reload();
      await open(page, "alert-export");
      await expect(panel(page).getByTestId("card-depends")).toContainText("Nothing");
      await open(page, "alert-digest");
      await expect(panel(page).getByTestId("card-needed")).toHaveText("None");
    });

    test(`a dependency stored under two keys goes with one x (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "setup-import");
      const deps = panel(page).getByTestId("card-depends");
      await expect(deps.getByTestId("card-depends-row")).toHaveCount(1);
      await expect(deps).toContainText("Setup checklist");
      await tap(panel(page).getByRole("button", { name: "Remove Setup checklist from what it depends on" }));
      await expect(page.getByRole("status").filter({ hasText: "Dependency removed" })).toBeVisible();
      await expect(deps).toContainText("Nothing");
      await expect(deps.getByTestId("card-depends-row")).toHaveCount(0);
      await page.reload();
      await open(page, "setup-import");
      await expect(panel(page).getByTestId("card-depends")).toContainText("Nothing");
    });

    test(`a done dependency is no broken link (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "alert-digest");
      await expect(panel(page).getByTestId("card-depends")).toContainText("Alert rules engine");
      await expect(panel(page).getByTestId("card-flags")).not.toContainText("Alert rules engine");
      await expect(page.locator('[data-testid="broken-callout"][data-item="alert-digest"]')).toHaveCount(0);
    });

    test(`a cut item's link counts nowhere (${where})`, async ({ page }) => {
      await login(page);
      await open(page, "setup-tour");
      await expect(panel(page).getByTestId("card-status")).toContainText("Cut");
      await expect(panel(page).getByTestId("card-depends")).toContainText("Setup checklist");
      await expect(panel(page).getByTestId("card-flags")).not.toContainText("Setup checklist");
      await page.goto(ROADMAP);
      await tap(page.getByRole("button", { name: /^Needs a decision/ }).first());
      const tray = page.getByTestId("decision-tray");
      await expect(tray).toBeVisible();
      // Its own link to the Setup checklist counts nowhere; that the Welcome video still waits on it does (a live link).
      await expect(tray.getByTestId("tray-broken").filter({ hasText: "In-app tour" })).not.toContainText("Setup checklist");
    });

    test(`a cut made in a panel opened from Priorities shows there at once (${where})`, async ({ page }) => {
      await login(page);
      await page.goto("/simple/priorities");
      const row = page.locator('[data-testid="prio-row"][data-code="price-tiers"]');
      await expect(row).toBeVisible();
      await tap(row.getByTestId("prio-title"));
      await expect(panel(page)).toBeVisible();
      await tap(panel(page).getByRole("button", { name: "More actions" }));
      await tap(panel(page).getByRole("menuitem", { name: "Cut from the roadmap" }));
      await tap(page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }));
      await expect(page.getByRole("status").filter({ hasText: /^Cut / })).toBeVisible();
      await expect(panel(page)).toBeVisible();
      await expect(row).toHaveCount(0);
    });
  });
}

import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, pickZone } from "./helpers";

/*
 * qa-onboarding-33 and qa-onboarding-16 (desktop, mock 'empty' scenario, through the UI only):
 * a new company's owner opens Set up's Horizons and Time zone steps from Simple's setup card
 * and from Detailed Home's checklist; each save says "Saved · Back to Home", and Back to Home
 * (the save's and the Settings bar's) returns to the Home the step was opened from.
 * no_claim: the API's /v1/setup (the mock stands in) and the other steps (fix2-simple-home-onboarding,
 * qa2-onboarding-checklist).
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** The empty scenario, with the mock's company store reset once at the start (later loads keep what the test did). */
async function emptyCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-setup-onboarding")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-setup-onboarding", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

// Detailed Home stays mounted behind Simple (ModeRoot), with its own "home-setup": read Simple's page only.
const simpleCard = (page: Page) => page.getByTestId("simple-page").getByTestId("home-setup");

/** The Detailed rail's Mode switch: Simple, landing on Simple's Home. */
async function toSimple(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(simpleCard(page)).toBeVisible();
}

// protects: qa-onboarding-33, -16: from Simple's setup card, the Time zone and Horizons steps
// save with "Saved · Back to Home", and both ways back open Simple's Home.
// fails_when: Back to Home opens Detailed's /home, or the time zone's save says only "Saved".
test("qa-onboarding-33: a Simple owner's setup steps go back to Simple's Home", async ({ page }) => {
  await emptyCompany(page);
  await login(page, ADMIN.email);
  await toSimple(page);

  // Time zone: pick Tokyo, Save, Back to Home from the save.
  await simpleCard(page).getByRole("link", { name: "Time zone", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=simple-setup#timezone$/);
  const zonePanel = page.getByTestId("timezone-panel");
  await pickZone(zonePanel, "Asia/Tokyo");
  await zonePanel.getByRole("button", { name: "Save" }).click();
  await expect(zonePanel.getByRole("status")).toHaveText("Saved · Back to Home");
  await zonePanel.getByRole("status").getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(simpleCard(page).getByTestId("home-setup-step").filter({ hasText: "Time zone" })).toContainText("Done");

  // Horizons: Save the defaults; the Settings bar's Back to Home also opens Simple's Home.
  await simpleCard(page).getByRole("link", { name: "Horizons", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=simple-setup#horizons$/);
  const horizons = page.locator("#horizons");
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("status")).toHaveText("Saved · Back to Home");
  await expect(horizons.getByRole("status").getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/simple");
  const bar = page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" });
  await expect(bar).toHaveAttribute("href", "/simple");
  await bar.click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(simpleCard(page).getByTestId("home-setup-step").filter({ hasText: "Horizons" })).toContainText("Done");

  // Another Simple step keeps the way back to Simple too.
  await simpleCard(page).getByRole("link", { name: "Engineering lead", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/simple");
});

// protects: qa-onboarding-16: from Detailed Home's checklist, the time zone's save says
// "Saved · Back to Home" as the horizons' does, and goes back to Detailed's Home.
// fails_when: the time zone's save says only "Saved", or the link leaves Detailed.
test("qa-onboarding-16: the time zone's save from Set up says Saved · Back to Home", async ({ page }) => {
  await emptyCompany(page);
  await login(page, ADMIN.email);
  await page.getByTestId("setup-row-timezone").getByTestId("setup-action").click();
  await expect(page).toHaveURL(/\/settings\/company\?from=setup#timezone$/);
  const zonePanel = page.getByTestId("timezone-panel");
  await pickZone(zonePanel, "Asia/Tokyo");
  await zonePanel.getByRole("button", { name: "Save" }).click();
  await expect(zonePanel.getByRole("status")).toHaveText("Saved · Back to Home");
  await zonePanel.getByRole("status").getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("setup-row-timezone")).toHaveAttribute("data-done", "true");
});

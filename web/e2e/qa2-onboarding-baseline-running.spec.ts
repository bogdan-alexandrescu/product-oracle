import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * qa-onboarding-10, -37, -39, -51: a new company's owner starts the first baseline build from
 * Home's Set up, then comes back to Home while it runs. The Set up row says Building… and opens
 * the run; the Goals card opens the same build (never a second start); on a phone In flight is
 * one compact row, the run's inspector only on a tap.
 *
 * no_claim for every test here: the in-browser mock's /v1/setup and runs stand in for the API
 * (api/tests/test_setup.py covers run_id); the mock's agents move only on "Refresh progress".
 */

const setupRow = (page: Page) => page.getByTestId("setup-row-build_baseline");
const goals = (page: Page) => page.getByTestId("home-goals");

/** Set up > Build baseline > Open > Start, then back to Home with the app's own Home link. */
async function startFromSetup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  const row = setupRow(page);
  await expect(row.getByTestId("setup-status")).toHaveText("Not built");
  // One baseline action before the build: the row's Open; the Goals card points at it.
  await expect(goals(page).getByTestId("goals-build-in-setup")).toHaveText("Build it from Set up, above");
  await expect(goals(page).getByRole("link", { name: "Build the baseline" })).toHaveCount(0);
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1$/);
  const sheet = page.getByRole("dialog", { name: "Build the baseline" });
  await sheet.getByRole("button", { name: "Start" }).click();
  await expect(sheet).toHaveCount(0);
  // The build banner says it, with the Inbox item to come (qa-onboarding-25: one line, not a toast too).
  await expect(page.getByTestId("baseline-build-banner")).toContainText("You'll get an Inbox item when it's ready to review.");
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Home", exact: true }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);
}

/** The row says Building… and links to the run; the Goals card says Open the build, to the same run. */
async function seeBuilding(page: Page): Promise<string> {
  const row = setupRow(page);
  await expect(row.getByTestId("setup-status")).toHaveText("Building…");
  await expect(row).toHaveAttribute("data-done", "false");
  const link = row.getByRole("link", { name: "Open the build" });
  await expect(link).toHaveAttribute("href", /^\/runs\/[0-9a-f-]+$/);
  const href = (await link.getAttribute("href"))!;
  // No "Not built" and no second start anywhere on Home.
  await expect(row).not.toContainText("Not built");
  await expect(page.getByRole("link", { name: "Build the baseline" })).toHaveCount(0);
  const open = goals(page).getByRole("link", { name: "Open the build" });
  await expect(open).toHaveAttribute("href", href);
  await expect(goals(page).getByTestId("goals-build-in-setup")).toHaveCount(0);
  return href;
}

test("while the first build runs, Set up says Building… and the Goals card opens the build", async ({ page }) => {
  // protects=qa-onboarding-10/-51 on a desktop; fails_when=the row still says Not built, its
  // button starts another build, or the Goals card offers Build the baseline (the sheet's
  // already-under-way error); no_claim=the run's own page.
  await startFromSetup(page);
  const href = await seeBuilding(page);
  // In flight lists the build once; Open the build on the Goals card lands on that run.
  await expect(page.getByTestId("home-in-flight-table").getByTestId("flight-row")).toHaveCount(1);
  await goals(page).getByRole("link", { name: "Open the build" }).click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { name: "Build the baseline" }).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Build the baseline" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the running build is one compact In flight row; the inspector waits for a tap", async ({ page }) => {
    // protects=qa-onboarding-39/-51 at 390 px; fails_when=the run's inspector card is stacked
    // under its own In flight row, the row and card do not say Building/Open the build, or the
    // page scrolls sideways; no_claim=other phone widths.
    await startFromSetup(page);
    await seeBuilding(page);
    const rows = page.getByTestId("home-in-flight-table").getByTestId("flight-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeVisible();
    // One row, no repeat of the same run below it.
    await expect(page.getByTestId("home-inspector")).toBeHidden();
    const box = (await rows.first().boundingBox())!;
    expect(box.height).toBeLessThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // A tap opens the run's details right under In flight.
    await rows.first().click();
    const inspector = page.getByTestId("home-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Run · selected");
    const [flightBottom, cardTop] = await page.evaluate(() => [
      document.querySelector("[data-testid=home-in-flight]")!.getBoundingClientRect().bottom,
      document.querySelector("[data-testid=home-inspector]")!.getBoundingClientRect().top,
    ]);
    expect(cardTop).toBeGreaterThanOrEqual(flightBottom);
  });
});

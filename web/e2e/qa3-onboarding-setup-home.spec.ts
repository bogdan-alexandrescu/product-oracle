import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * qa-onboarding-13, -14, -15, -30: a new company's owner on Home. Set up's buttons are named
 * for their step; the Goals card says "Build the baseline from Set up, above" while the step is
 * on screen and starts a build itself once Set up is hidden; while the first build runs there
 * is one way to open it; the run's details say its segment under way once.
 *
 * no_claim: the in-browser mock's /v1/setup and runs stand in for the API; its agents move
 * only on "Refresh progress", so the build stays on its first segment here.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const panel = (page: Page) => page.getByTestId("home-setup");
const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const goals = (page: Page) => page.getByTestId("home-goals");

async function newCompanyOwner(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText("2 of 8");
}

test("Set up's buttons are named for their step", async ({ page }) => {
  // protects=qa-onboarding-13; fails_when=a row's button is named only "Open" or "Change";
  // no_claim=the steps' own pages.
  await newCompanyOwner(page);
  for (const [key, name] of [
    ["connect", "Open Connect tools"],
    ["sources", "Open Pick sources"],
    ["invite", "Change Invite team"],
    ["domains", "Change Company domains"],
    ["eng_lead", "Open Engineering lead"],
    ["horizons", "Open Horizons"],
    ["timezone", "Open Time zone"],
    ["build_baseline", "Open Build baseline"],
  ] as const) {
    await expect(row(page, key).getByRole("link", { name, exact: true })).toBeVisible();
  }
  // The words on screen stay short.
  await expect(row(page, "connect").getByTestId("setup-action")).toHaveText("Open");
  await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Change", exact: true })).toHaveCount(0);
});

test("the Goals card says Build the baseline from Set up, and starts it itself once Set up is hidden", async ({ page }) => {
  // protects=qa-onboarding-15; fails_when=the card says "Build it from Set up, above", or the
  // hidden checklist leaves the card with no way to build; no_claim=the build sheet.
  await newCompanyOwner(page);
  const hint = goals(page).getByTestId("goals-build-in-setup");
  await expect(hint).toHaveText("Build the baseline from Set up, above");
  await expect(goals(page).getByRole("link", { name: "Build the baseline" })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Hide" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(hint).toHaveCount(0);
  const build = goals(page).getByRole("link", { name: "Build the baseline" });
  await expect(build).toHaveAttribute("href", "/baseline?build=1");
  // Shown again, one baseline action again.
  await page.getByRole("button", { name: "Set up 2 of 8" }).click();
  await expect(hint).toHaveText("Build the baseline from Set up, above");
  await expect(build).toHaveCount(0);
});

test("while the first build runs: one Open the build, and its segment under way said once", async ({ page }) => {
  // protects=qa-onboarding-14/-30; fails_when=Home shows two Open the build buttons, or the
  // run's details say "Next: <segment>" above the same segment marked Running, or In flight's
  // Next repeats the segment under way; no_claim=a run waiting on a person (Next stays).
  await newCompanyOwner(page);
  await row(page, "build_baseline").getByRole("link", { name: "Open Build baseline" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1$/);
  const sheet = page.getByRole("dialog", { name: "Build the baseline" });
  await sheet.getByRole("button", { name: "Start" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByTestId("nav-home").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);

  // One way to open the build: the Set up row's; the Goals card points at it.
  await expect(row(page, "build_baseline").getByTestId("setup-status")).toHaveText("Building…");
  await expect(page.getByRole("link", { name: "Open the build" })).toHaveCount(1);
  await expect(row(page, "build_baseline").getByRole("link", { name: "Open the build" })).toHaveAttribute("href", /^\/runs\//);
  await expect(goals(page).getByTestId("goals-build-in-setup")).toHaveText("The baseline is building: open it from Set up, above");

  // The run's details: its segments, the one under way marked Running, no "Next" repeating it.
  const flight = page.getByTestId("home-in-flight-table").getByTestId("flight-row");
  await expect(flight).toHaveCount(1);
  const inspector = page.getByTestId("home-inspector");
  const segments = inspector.getByTestId("inspector-segments");
  await expect(segments).toBeVisible();
  await expect(segments.getByText("Running", { exact: true })).toHaveCount(1);
  await expect(inspector.getByTestId("inspector-next")).toHaveCount(0);

  // In flight's row: Progress says the segment, Next the one after it (never the one under way).
  await expect(flight.getByTestId("row-segments")).toHaveText(/^Segment 1 of \d+$/);
  const nextCol = await page
    .getByTestId("home-in-flight-table")
    .evaluate((el) => [...el.querySelectorAll("th")].findIndex((th) => th.textContent?.trim() === "Next"));
  await expect(flight.locator("td").nth(nextCol)).toHaveText(/^(Segment 2 of \d+|Finish)$/);
});

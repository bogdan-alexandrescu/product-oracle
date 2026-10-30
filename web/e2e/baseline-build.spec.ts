import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * B1 Build the baseline: a person builds or refreshes the baseline from the Baseline page,
 * without starting a PRD, through the UI only.
 *
 * no_claim for every test here: the in-browser mock stands in for the API and SwarmCloud
 * (api/tests/test_baseline_flow.py covers the flow, the 409 rule and the estimate); the
 * mock's agents finish a segment on "Refresh progress".
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Build the baseline" });
const banner = (page: Page) => page.getByTestId("baseline-build-banner");

async function openBaseline(page: Page) {
  await page.getByTestId("nav-baseline").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/baseline/);
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Build baseline" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");
}

async function startBuild(page: Page) {
  await openSheet(page);
  await sheet(page).getByRole("button", { name: "Start" }).click();
  await expect(sheet(page)).toHaveCount(0);
}

test("approver starts a build: depth, review toggle and estimate, then the banner", async ({ page }) => {
  // protects=the start sheet's depth, review toggle and estimate, and what Start leaves on
  // the page; fails_when=Start is offered without an estimate, the depth does not change the
  // figure, or no notice and banner follow; no_claim=mock layer, no SwarmCloud.
  await login(page, "approver@example.com");
  await page.goto("/baseline");
  await openSheet(page);
  const s = sheet(page);
  await expect(s).toContainText(
    "Oracle reads your connected sources and proposes goals, products, features, constraints and evidence. Nothing is confirmed until you review it.",
  );
  const depth = s.getByRole("group", { name: "Depth" });
  await expect(depth.getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
  await expect(depth.getByRole("button", { name: "Quick" })).toHaveAttribute("title", "Strongest few sources per claim");
  await expect(depth.getByRole("button", { name: "Deep" })).toHaveAttribute("title", "Looks for contradicting evidence on every claim");
  await expect(s.getByRole("checkbox", { name: "Stop for my review" })).toBeChecked();
  await depth.getByRole("button", { name: "Deep" }).click();
  await expect(s.getByTestId("build-estimate")).toHaveText("$14.00 estimated · below the $50 approval line · starts at once");
  await depth.getByRole("button", { name: "Standard" }).click();
  await expect(s.getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");

  await s.getByRole("button", { name: "Start" }).click();
  await expect(s).toHaveCount(0);
  // One line says it (qa-onboarding-25): the banner, not a second notice above it.
  await expect(banner(page)).toContainText("Baseline being built");
  await expect(banner(page)).toContainText("You'll get an Inbox item when it's ready to review.");
  await expect(page.getByText("Building the baseline. You'll get an Inbox item when it's ready to review.")).toHaveCount(0);
  await expect(banner(page)).toContainText("started");
  // While a build is under way the header shows its state, not the button.
  await expect(page.getByRole("button", { name: "Build baseline" })).toHaveCount(0);
  await expect(page.getByTestId("baseline-build-chip")).toHaveText("Building");
});

test("the banner turns into Ready to review once the run waits at Confirm the baseline", async ({ page }) => {
  // protects=the banner follows the run; fails_when=it still says being built at the
  // checkpoint, or Review does not lead to the run's decision; no_claim=B2's review screen.
  await login(page);
  await openBaseline(page);
  await startBuild(page);
  await expect(banner(page)).toContainText("Baseline being built");
  await banner(page).getByRole("link", { name: "Open run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Build the baseline" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toBeVisible();
  await openBaseline(page);
  await expect(banner(page)).toContainText("Ready to review");
  await banner(page).getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toBeVisible();
});

test("commenters and viewers see no Build baseline button", async ({ page }) => {
  // protects=only approvers and owners start a build; fails_when=a commenter or a viewer is
  // offered the button or the sheet; no_claim=the API's 403 (test_baseline_flow covers it).
  for (const who of ["commenter@example.com", "viewer@example.com"]) {
    await login(page, who);
    await page.goto("/baseline?build=1");
    await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
    await expect(page.getByTestId("kpi-goals")).toBeVisible();
    await expect(page.getByRole("button", { name: "Build baseline" })).toHaveCount(0);
    await expect(sheet(page)).toHaveCount(0);
    await signOut(page);
  }
});

test("a second Start while the first build is under way shows the 409 and links to the first", async ({ page, context }) => {
  // protects=one build at a time, in the UI; fails_when=the second Start is accepted, or the
  // message gives no way to the build under way; no_claim=two requests at the same instant.
  await login(page);
  await page.goto("/baseline");
  await openSheet(page);
  // The same person in a second tab opens the sheet too, then the first tab starts.
  const other = await context.newPage();
  await other.goto("/baseline?build=1");
  await expect(sheet(other).getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");
  await sheet(page).getByRole("button", { name: "Start" }).click();
  await expect(banner(page)).toContainText("Baseline being built");
  const firstRun = await banner(page).getByRole("link", { name: "Open run" }).getAttribute("href");

  await sheet(other).getByRole("button", { name: "Start" }).click();
  const refused = sheet(other).getByRole("alert");
  await expect(refused).toContainText("A baseline build is already under way");
  await expect(refused.getByRole("link", { name: "Open the build under way" })).toHaveAttribute("href", firstRun!);
});

test("Home with no goals offers Build the baseline and opens the sheet", async ({ page }) => {
  // protects=the empty Home's way to a first baseline; fails_when=the old Import your
  // baseline link or tip is back, or the button does not open the sheet; no_claim=viewers
  // (home-fixes.spec covers that they see no action).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  // qa-onboarding-37: with Set up on screen its row is the one start; hidden, the card offers it.
  await expect(page.getByTestId("home-goals-empty").getByTestId("goals-build-in-setup")).toBeVisible();
  await page.getByTestId("home-setup").getByRole("button", { name: "Hide" }).click();
  const empty = page.getByTestId("home-goals-empty");
  await expect(empty).toContainText("No goals yet");
  await expect(empty.getByRole("link", { name: "Import your baseline" })).toHaveCount(0);
  await empty.getByRole("button", { name: "About building the baseline" }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Oracle reads your sources and proposes your goals; they show here once confirmed. You can also push a baseline YAML with oracle push.",
  );
  await empty.getByRole("link", { name: "Build the baseline" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1$/);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");
});

test("the New run dialog does not offer Build the baseline and points at the Baseline page", async ({ page }) => {
  // protects=D12's one rule for this flow; fails_when=the dialog offers the flow, or the
  // pointer line is missing or goes elsewhere; no_claim=the other flows' pointers.
  await login(page);
  await page.goto("/runs");
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a run" });
  await expect(dialog.getByTestId("flow-pointers")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Build the baseline" })).toHaveCount(0);
  const pointer = dialog.getByRole("link", { name: "Build the baseline · Baseline" });
  await expect(pointer).toHaveAttribute("href", "/baseline?build=1");
  await pointer.click();
  await expect(sheet(page)).toBeVisible();
});

test("the owner's Set up lists Build baseline last, and Open lands on the sheet", async ({ page }) => {
  // protects=A1's build_baseline step; fails_when=the step is missing, not last, or Open does
  // not open the sheet; no_claim=the API's step rule (test_setup covers it).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  const setup = page.getByTestId("home-setup");
  const rows = setup.locator("[data-testid^='setup-row-']");
  await expect(rows.last()).toHaveAttribute("data-testid", "setup-row-build_baseline");
  const row = page.getByTestId("setup-row-build_baseline");
  await expect(row).toContainText("Build baseline");
  await expect(row.getByTestId("setup-status")).toHaveText("Not built");
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/baseline\?build=1&from=setup$/);
  await expect(sheet(page)).toBeVisible();
});

test("on a phone the sheet fits with no sideways scroll and Start is visible", async ({ page }) => {
  // protects=the start sheet at 390 px; fails_when=the page scrolls sideways or Start is off
  // screen; no_claim=other phone widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/baseline?build=1");
  await expect(sheet(page).getByTestId("build-estimate")).toHaveText("$7.00 estimated · below the $50 approval line · starts at once");
  await expect(sheet(page).getByRole("button", { name: "Start" })).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

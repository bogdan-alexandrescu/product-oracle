import { expect, test, type Page } from "./test";

import { login } from "./helpers";

async function openHome(page: Page) {
  await login(page);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
}

test("Home: goals show current over target, distance to go, confidence and trend", async ({ page }) => {
  await openHome(page);
  const goals = page.getByTestId("home-goals");
  await expect(goals.getByText("2 confirmed")).toBeVisible();
  await expect(goals.getByTestId("goals-proposed")).toHaveText("Cut early churn proposed");

  const g1 = page.getByTestId("home-goal-G1");
  await expect(g1).toContainText("Raise activation");
  await expect(g1.getByTestId("goal-figure")).toHaveText("38%/ 45%");
  // I3: distance to go in the goal's own unit, never a percentage of target.
  await expect(g1.getByTestId("goal-to-go")).toHaveText("7 pts to go");
  await expect(g1.getByRole("img", { name: "Confidence 78" })).toBeVisible();
  // The trend comes from the goal's recorded revisions, with the target dashed.
  await expect(g1.getByTestId("goal-trend").locator("line[data-target='45']")).toHaveCount(1);
  await expect(g1.getByTestId("goal-change")).toHaveText("+7 6m");

  await expect(page.getByTestId("home-goal-G2").getByTestId("goal-to-go")).toHaveText("2.6 pts to go");
  const g3 = page.getByTestId("home-goal-G3");
  await expect(g3).toHaveAttribute("data-proposed", "true");
  // B5: early churn holds its target as text and has no current value yet.
  await expect(g3.getByTestId("goal-to-go")).toHaveText("No current value");
});

test("Home: needs you lists the inbox and the questions asked of me, one action each", async ({ page }) => {
  await openHome(page);
  const needs = page.getByTestId("home-needs");
  const rows = needs.getByTestId("home-needs-table").locator("tr[data-row]");
  // 11 items (the pending access request among them, A5): six lines (one a question) and
  // '+5 more in Inbox'.
  await expect(rows).toHaveCount(7);
  await expect(needs.getByTestId("home-needs-more")).toHaveText("+5 more in Inbox");
  // B2: a baseline checkpoint is reviewed in the Baseline, filtered to its run.
  await expect(rows.filter({ hasText: "Confirm the baseline" }).getByRole("link", { name: "Review" })).toHaveAttribute("href", /^\/baseline\?run=/);
  await expect(rows.filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" })).toBeVisible();
  await expect(rows.filter({ hasText: "$14.20 / $9.00" }).getByRole("link", { name: "Decide" })).toBeVisible();
  await expect(rows.filter({ hasText: "Oracle asks" })).toHaveCount(1);
  await expect(needs.getByText("Decisions 3")).toBeVisible();
  // Each feedback item counts, not one per document.
  await expect(needs.getByText("Reviews 5")).toBeVisible();
  await expect(needs.getByText("Questions 2")).toBeVisible();
  await expect(needs.getByText("Access 1")).toBeVisible();
  await expect(page.getByText("11 waiting")).toBeVisible();

  // Approving from Home starts the run: the line leaves the list (the next item moves up).
  await rows.filter({ hasText: "$53.00 est." }).getByRole("button", { name: "Approve $53.00" }).click();
  await expect(rows.filter({ hasText: "$53.00 est." })).toHaveCount(0);
  await expect(needs.getByTestId("home-needs-more")).toHaveText("+4 more in Inbox");
  await expect(rows).toHaveCount(7);
  await expect(page.getByText("10 waiting")).toBeVisible();

  await needs.getByTestId("home-inbox-link").click();
  await expect(page).toHaveURL(/\/inbox$/);
  // Both questions asked of me wait in the Inbox.
  const questions = page.getByTestId("inbox-questions");
  await expect(questions.locator("tr[data-row]").filter({ hasText: "Which metric shows repeat checkout got faster?" })).toContainText("Oracle asks");
  // The deposits PRD's blocker question is asked of the signed-in owner too.
  await expect(questions.locator("tr[data-row]").filter({ hasText: "Same-day cancellation refund?" })).toContainText("Oracle asks");
});

test("Home: in flight rows select into the inspector", async ({ page }) => {
  await openHome(page);
  const flights = page.getByTestId("home-in-flight-table").getByTestId("flight-row");
  await expect(flights).toHaveCount(6);
  const checkout = flights.filter({ hasText: "Checkout redesign PRD" });
  await expect(checkout).toHaveAttribute("aria-selected", "true");
  await expect(checkout.getByTestId("row-journey").getByRole("img")).toHaveAttribute("aria-label", "Journey 8 of 9: Review");

  const inspector = page.getByTestId("home-inspector");
  // Goal tags load for the selected row only, in the inspector (no trace call per row).
  await expect(inspector.getByTestId("row-goals")).toHaveText("Raise activationGrow paid conversion");
  await expect(inspector).toContainText("PRD · selected");
  await expect(inspector.getByRole("heading", { name: "Checkout redesign PRD" })).toBeVisible();
  await expect(inspector.getByTestId("stat-sections")).toContainText("Sections done");
  await expect(inspector.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/documents/checkout-redesign");

  // A run: its segments and what comes next.
  const onboarding = flights.filter({ hasText: "team-onboarding" });
  await onboarding.click();
  await expect(onboarding).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toContainText("selected");
  await expect(inspector.getByRole("heading", { name: "team-onboarding" })).toBeVisible();
  await expect(inspector.getByTestId("inspector-next")).toContainText("Confirm the baseline");
  await expect(inspector.getByTestId("stat-segments")).toContainText("1/4");

  // Keyboard: ArrowUp moves the selection back up the table.
  await page.keyboard.press("ArrowUp");
  await expect(flights.filter({ hasText: "usage-alerts-v2" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("heading", { name: "usage-alerts-v2" })).toBeVisible();
});

test("Home on a phone: stacked blocks under the phone header, inspector below, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);
  await expect(page.getByTestId("home-goal-G1")).toBeVisible();
  // Page offsets, so scrolling does not move them.
  const top = (id: string) =>
    page.getByTestId(id).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { y: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
    });
  const goals = await top("home-goals");
  const needs = await top("home-needs");
  const flight = await top("home-in-flight");
  const inspector = await top("home-inspector");
  expect(goals.bottom).toBeLessThanOrEqual(needs.y);
  expect(needs.y).toBeLessThan(flight.y);
  expect(flight.bottom).toBeLessThanOrEqual(inspector.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The In flight title shows on a phone, where the table header is hidden.
  await expect(page.getByTestId("home-in-flight-phone-title")).toBeVisible();
  await expect(page.getByTestId("home-in-flight-phone-title")).toHaveText("In flight6");
});

test("Home for a new company: one line per block with what to do next", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await openHome(page);
  // A1: the Set up checklist comes first, the owner's steps with what is already done.
  const setup = page.getByTestId("home-setup");
  await expect(setup.getByRole("heading", { name: "Set up" })).toBeVisible();
  // H2 added the Company time zone step: eight steps.
  await expect(setup.getByTestId("panel-count")).toHaveText("2 of 8");
  const goals = page.getByTestId("home-goals-empty");
  await expect(goals).toContainText("No goals yet");
  await expect(goals.getByRole("link", { name: "Build the baseline" })).toHaveAttribute("href", "/baseline?build=1");
  await expect(page.getByTestId("home-needs-empty")).toHaveText("Nothing waiting");
  const flight = page.getByTestId("home-in-flight-empty");
  await expect(flight).toContainText("Nothing in flight");
  await expect(flight.getByRole("link", { name: "New PRD" })).toBeVisible();
  // New PRD is drawn once: the empty line carries it, the header does not.
  await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(1);
  await expect(page.getByTestId("home-inspector")).toHaveCount(0);
});

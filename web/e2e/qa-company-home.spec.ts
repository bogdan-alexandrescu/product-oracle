import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA findings on Home (Detailed): goal chips' keyboard behaviour, the confidence ring, the
 * trend's change in words, the loading Goals band, In flight's progress and names, the
 * selected PRD's blockers, and the Set up time zone.
 */

async function openHome(page: Page) {
  await login(page);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
  await expect(page.getByTestId("home-goal-G1")).toBeVisible();
}

const flight = (page: Page, slug: string, kind: "prd" | "run" = "run") =>
  page.locator(`[data-testid="flight-row"][data-kind="${kind}"][data-document="${slug}"]`);

// qa-company-4, qa-shell-31: Tab passes a goal chip without opening its card; one stop per control.
test("goal chips: Tab moves on past the chip, Enter opens its card, Tab leaves the card", async ({ page }) => {
  await openHome(page);
  const chip = page.getByTestId("home-goal-G1").getByTestId("code-chip");
  const card = page.getByTestId("code-card");
  await chip.focus();
  await expect(chip).toBeFocused();
  await expect(card).toHaveCount(0);

  // Ten Tabs from the chip: never a card, never the same element twice.
  const stops: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    await expect(card).toHaveCount(0);
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return "none";
        el.dataset.qaStop ??= String(Math.random());
        return el.dataset.qaStop;
      }),
    );
  }
  expect(new Set(stops).size).toBe(stops.length);

  // Enter opens the card with focus on its Open link; Tab past it closes it and goes on.
  await chip.focus();
  await page.keyboard.press("Enter");
  const open = card.getByRole("link", { name: "Open" });
  await expect(open).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(card).toHaveCount(0);
  await expect(chip).not.toBeFocused();
  await expect(open).toHaveCount(0);
});

// prod-2, qa-company-44: the ring says it is confidence, and shows only once there is a value.
test("goals: the confidence ring is named and hidden without a current value; the change is in words", async ({ page }) => {
  await openHome(page);
  const g1 = page.getByTestId("home-goal-G1");
  await expect(g1.getByTestId("goal-confidence")).toBeVisible();
  await expect(g1.getByTestId("goal-confidence")).toContainText("confidence");
  await expect(g1.getByRole("img", { name: "Confidence 78" })).toBeVisible();
  await expect(g1.getByTestId("goal-change")).toHaveText("+7 pts in 6 months");

  // Cut early churn has no current value: no ring, no number beside the "–".
  const g3 = page.getByTestId("home-goal-G3");
  await expect(g3.getByTestId("goal-to-go")).toHaveText("No current value");
  await expect(g3.getByTestId("goal-confidence")).toHaveCount(0);
  await expect(g3.getByRole("img", { name: /^Confidence/ })).toHaveCount(0);

  // Plan's Goals band is the same panel.
  await page.goto("/plan");
  const plan = page.getByTestId("plan-goals").filter({ visible: true });
  await expect(plan.getByTestId("home-goal-G1").getByTestId("goal-confidence")).toContainText("confidence");
  await expect(plan.getByTestId("home-goal-G3").getByTestId("goal-confidence")).toHaveCount(0);
});

// prod-1: while the goals load, the band holds skeleton cards rather than an empty box.
test("goals: skeleton cards while the goals load, then the goals", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-slow", "/v1/baseline/entities");
    localStorage.setItem("po-mock-slow-ms", "3000");
  });
  await login(page);
  const goals = page.getByTestId("home-goals");
  await expect(goals.getByTestId("goals-loading")).toBeVisible();
  await expect(goals.getByTestId("goals-loading").locator("li")).toHaveCount(4);
  await expect(page.getByTestId("home-goal-G1")).toBeVisible({ timeout: 15_000 });
  await expect(goals.getByTestId("goals-loading")).toHaveCount(0);
});

// qa-company-5: the row's journey step and the card's sections each say what they count.
test("in flight: the PRD's step and its sections approved are labelled apart", async ({ page }) => {
  await openHome(page);
  const table = page.getByTestId("home-in-flight-table");
  await expect(table.getByRole("columnheader", { name: "Progress" })).toBeAttached();
  const checkout = flight(page, "checkout-redesign", "prd");
  await expect(checkout).toHaveAttribute("aria-selected", "true");
  await expect(checkout.getByTestId("row-journey")).toContainText("Step 8/9");
  const inspector = page.getByTestId("home-inspector");
  await expect(inspector.getByTestId("inspector-journey")).toContainText("step 8 of 9");
  await expect(inspector.getByTestId("stat-sections")).toContainText("Sections approved");
  await expect(inspector.getByTestId("stat-sections")).not.toContainText("Sections done");
});

// qa-company-45: each blocker line names the blocker, not the check's heading.
test("in flight: the selected PRD's blockers are named", async ({ page }) => {
  await openHome(page);
  const blockers = page.getByTestId("home-inspector").getByTestId("inspector-blockers");
  await expect(blockers).toContainText("The address lookup service allows 100 requests a minute per company");
  await expect(blockers.getByTestId("inspector-blocker").filter({ hasText: /^Critical blockers$/ })).toHaveCount(0);
});

// qa-company-43, qa-shell-32: a paused run does not read as finished; runs are named, not slugged.
test("in flight: a run paused over budget says Paused; runs are named by title, no slug or short id", async ({ page }) => {
  await openHome(page);
  const paused = flight(page, "team-workspaces");
  await expect(paused).toContainText("Paused: over budget");
  await expect(paused.getByTestId("row-paused")).toHaveText(/^Paused/);
  await expect(paused.getByRole("meter")).toHaveCount(0);

  const table = page.getByTestId("home-in-flight-table");
  await expect(flight(page, "usage-alerts-v2")).toContainText("Usage alerts v2 PRD");
  await expect(table).not.toContainText("usage-alerts-v2");
  await expect(table).not.toContainText("team-onboarding");
  await flight(page, "team-onboarding").click();
  const inspector = page.getByTestId("home-inspector");
  await expect(inspector).toContainText("Run · selected");
  await expect(inspector).not.toContainText(/Run [0-9a-f]{4}\b/);
  await expect(inspector.getByRole("heading", { name: /^Team onboarding PRD/ })).toBeVisible();
});

// qa-company-24: Set up says the default zone is used until one is set, then the zone in words.
test("set up: time zone says the default is used, then names the zone that was set", async ({ page }) => {
  await login(page);
  const step = page.getByTestId("setup-row-timezone");
  await expect(step.getByTestId("setup-status")).toHaveText("Not set · Pacific is used");
  await step.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/company/);
  await page.getByLabel("Company time zone").selectOption("Asia/Tokyo");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await page.goto("/home");
  const status = page.getByTestId("setup-row-timezone").getByTestId("setup-status");
  await expect(status).toContainText("(Tokyo)");
  await expect(status).not.toContainText("Asia/");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("goals and in flight read the same on a phone, with no sideways scroll", async ({ page }) => {
    await openHome(page);
    await expect(page.getByTestId("home-goal-G1").getByTestId("goal-confidence")).toBeVisible();
    await expect(page.getByTestId("home-goal-G3").getByTestId("goal-confidence")).toHaveCount(0);
    await expect(page.getByTestId("home-goal-G1").getByTestId("goal-change")).toHaveText("+7 pts in 6 months");
    await expect(flight(page, "team-workspaces").getByTestId("row-paused")).toBeVisible();
    await expect(flight(page, "checkout-redesign", "prd").getByTestId("row-journey")).toContainText("Step 8/9");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

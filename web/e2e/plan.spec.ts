import { expect, test, type Locator, type Page } from "./test";

import { MOCK_PLAN_TABS_KEY } from "../app/plan/_tabs";
import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";

/*
 * F1 Plan screen, driven through the UI on the mock layer (NEXT_PUBLIC_API_MOCKS=1).
 *
 * The mock's GET /v1/plan (lib/api/mock/roadmap.ts, routePlan) stands in for the API's
 * (api/oracle/plan, its rules proven by api/tests/test_plan.py): a tracked PRD (Usage alerts,
 * whose roadmap draft 2 changes, moves and drops items), a PRD waiting at the feature set
 * checkpoint (Saved carts), one at the engineering check with a lead named (Clinic outreach)
 * and a never-approved PRD with a roadmap draft (Checkout redesign). No test here proves the
 * API's rules; each proves what a person sees and does on the screen.
 */

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });
const rows = (page: Page) => page.getByTestId("plan-row").filter({ visible: true });
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });
const card = (page: Page, title: string) => page.getByTestId("plan-prd-card").filter({ hasText: title });
const groups = (page: Page) => page.getByTestId("plan-group").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

async function goalFigures(panel: Locator) {
  const cards = panel.locator('[data-testid^="home-goal-"]');
  await expect(cards.first()).toBeVisible();
  const out: string[] = [];
  for (const c of await cards.all()) {
    out.push(`${await c.getAttribute("data-testid")}|${(await c.getByTestId("goal-to-go").innerText()).trim()}`);
  }
  return out;
}

// protects = the rail item is Plan (no Roadmap), it opens /plan titled Plan, and old /roadmap
// links end on /plan; fails_when = the rail still says Roadmap or /roadmap 404s;
// no_claim = the 308 status itself (Next's redirects() in the mock build serves it).
test("the rail says Plan, not Roadmap; Plan opens /plan; /roadmap ends on /plan", async ({ page }) => {
  await openPlan(page);
  await expect(rail(page).getByTestId("nav-plan")).toHaveText(/Plan/);
  await expect(rail(page).getByRole("link", { name: "Roadmap" })).toHaveCount(0);
  await expect(rail(page).getByTestId("nav-plan")).toHaveAttribute("aria-current", "page");
  await page.goto("/roadmap");
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
});

// protects = the goals band is Home's GoalsPanel: same tags and "to go" figures for the same
// seed; fails_when = the Plan computes or tags goals its own way; no_claim = the figures'
// maths (goal-maths.spec.ts).
test("the goals band shows the same goal tags and distances to go as Home", async ({ page }) => {
  await login(page);
  const home = await goalFigures(page.getByTestId("home-goals").filter({ visible: true }));
  await rail(page).getByRole("link", { name: "Plan", exact: true }).click();
  const plan = await goalFigures(page.getByTestId("plan-goals").filter({ visible: true }));
  expect(plan).toEqual(home);
  expect(plan.length).toBeGreaterThan(0);
});

// protects = the PRD cards' stage lines, by who looks; the waiting card first for whoever may
// decide it; more than six PRDs end in "+N more"; fails_when = an approver is told the run
// waits for someone else, or a viewer that it waits for them; no_claim = the stage rules
// (api/tests/test_plan.py test_prd_stage).
test("PRD cards: stage lines say who the run waits for", async ({ page }) => {
  await openPlan(page);
  await expect(page.getByTestId("plan-prd-card").first()).toContainText("Saved carts PRD");
  await expect(card(page, "Saved carts PRD").getByTestId("plan-prd-stage")).toHaveText("Feature set · waiting for you");
  await expect(card(page, "Saved carts PRD").getByTestId("plan-prd-figure")).toHaveText("9 features");
  await expect(card(page, "Usage alerts PRD").getByTestId("plan-prd-stage")).toHaveText("Approved v1");
  await expect(card(page, "Usage alerts PRD").getByTestId("plan-prd-figure")).toHaveText("At risk");
  await expect(card(page, "Checkout redesign PRD").getByTestId("plan-prd-stage")).toHaveText("Draft 2 in review · roadmap draft 2");
  await expect(card(page, "Checkout redesign PRD").getByTestId("plan-prd-figure")).toHaveText("3 items");
  await expect(card(page, "Usage alerts PRD").getByRole("link", { name: "Usage alerts PRD" })).toHaveAttribute("href", "/documents/usage-alerts");
  await expect(card(page, "Usage alerts PRD").getByRole("img", { name: /^Journey 9 of 9/ })).toBeVisible();
  // Seven PRDs in play: five cards, then "+2 more" to the PRDs list.
  await expect(page.getByTestId("plan-prd-card")).toHaveCount(5);
  await expect(page.getByTestId("plan-prd-more")).toHaveText(/\+2 more/);
  await expect(page.getByTestId("plan-prd-more")).toHaveAttribute("href", "/documents");
});

test("PRD cards: a viewer sees the feature set wait for an approver", async ({ page }) => {
  await asRole(page, "viewer");
  await openPlan(page);
  await expect(card(page, "Saved carts PRD").getByTestId("plan-prd-stage")).toHaveText("Feature set · waiting for approver");
  await expect(page.getByTestId("plan-prd-card").first()).not.toContainText("Saved carts PRD");
});

// protects = 16c, the engineering check's line names the engineering lead to an approver
// while a lead is named; fails_when = it says "waiting for you"; no_claim = naming a lead
// (A3 is not built: the mock names one).
test("PRD cards: the engineering check waits for the engineering lead", async ({ page }) => {
  await asRole(page, "approver");
  await openPlan(page);
  await expect(card(page, "Clinic outreach PRD").getByTestId("plan-prd-stage")).toHaveText(
    "Engineering check · waiting for the engineering lead",
  );
});

// protects = rows grouped under Now / Next / Later with counts, regrouped by Goal and PRD;
// draft items carry the dashed Proposed chip with how they differ (16b: a confidence change
// alone shows no suffix, an outcome change "· changed"); fails_when = a count or group is
// wrong, or a note counts as a change; no_claim = the diff (api/tests/test_plan.py).
test("roadmap table: grouped by horizon, goal or PRD; draft items are dashed Proposed", async ({ page }) => {
  await openPlan(page);
  await expect(groups(page)).toHaveText(["Now 7", "Next 1", "Later 2"]);
  await expect(rows(page)).toHaveCount(10);
  const state = (title: string) => row(page, title).getByTestId("plan-state");
  await expect(state("Alert rules API")).toHaveText("Proposed");
  await expect(state("Alert rules API")).toHaveAttribute("data-dashed", "true");
  await expect(state("Usage dashboard")).toHaveText("Proposed · changed");
  await expect(state("Spend forecast for the month")).toHaveText("Proposed · Next → Now");
  await expect(state("One-page checkout")).toHaveText("Proposed · new");
  await expect(state("Daily alert digest email")).toHaveText("At risk");
  await expect(state("Threshold alerts on spend")).toHaveText("On track");
  await expect(row(page, "Budgets per team")).toContainText("Dropped in draft 2");
  await expect(page.getByTestId("plan-legend")).toHaveText("Dashed: proposed by a draft, not approved");
  // Engineering and Next, as the rules word them.
  await expect(row(page, "Threshold alerts on spend").getByTestId("plan-engineering")).toHaveText("ENG-402 · Nov 20 ✓");
  await expect(row(page, "Daily alert digest email").getByTestId("plan-engineering")).toHaveText("ENG-405 · slipped 9 d");
  await expect(row(page, "Alerts in the team chat").getByTestId("plan-engineering")).toHaveText("ENG-431 · unverified");
  await expect(row(page, "Budgets per team").getByTestId("plan-engineering")).toHaveText("—");
  await expect(row(page, "Daily alert digest email").getByTestId("plan-next")).toHaveText("Decide on slip · owners");
  await expect(row(page, "One-page checkout").getByTestId("plan-next").getByRole("link", { name: "PRD review" })).toHaveAttribute(
    "href",
    "/documents/checkout-redesign/v/2",
  );
  await expect(row(page, "Spend forecast for the month").getByTestId("plan-goal")).toHaveText("No goal");
  await expect(row(page, "Threshold alerts on spend").getByTestId("plan-goal")).toHaveText("Raise activation");
  await expect(row(page, "Threshold alerts on spend").getByTestId("plan-prd")).toHaveText("Usage alerts");
  await expect(row(page, "One-page checkout").getByTestId("plan-prd")).toHaveText("Checkout redesign");

  const group = page.getByRole("group", { name: "Group by" });
  await group.getByRole("button", { name: "Goal" }).click();
  await expect(groups(page)).toHaveText(["Raise activation 4", "Grow paid conversion 3", "Cut early churn 1", "No goal 2"]);
  await group.getByRole("button", { name: "PRD" }).click();
  await expect(groups(page)).toHaveText(["Usage alerts PRD 7", "Checkout redesign PRD 3"]);
  await group.getByRole("button", { name: "Horizon" }).click();
  await expect(groups(page)).toHaveText(["Now 7", "Next 1", "Later 2"]);
});

// protects = "Approved only" hides every Proposed row and is kept after a reload (per viewer,
// in the browser); fails_when = a draft row stays, or the choice is lost; no_claim = the
// API's scope filter (api/tests/test_plan.py).
test("Approved only hides every Proposed row, and the choice is kept", async ({ page }) => {
  await openPlan(page);
  await expect(page.getByTestId("plan-count-proposed")).toHaveText("6 proposed");
  const scope = page.getByRole("group", { name: "Plan scope" });
  await expect(scope.getByRole("button", { name: "Approved + drafts" })).toHaveAttribute("aria-pressed", "true");
  await scope.getByRole("button", { name: "Approved only" }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(page.locator('[data-testid="plan-state"][data-state="proposed"]').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("plan-count-proposed")).toHaveCount(0);
  await expect(groups(page)).toHaveText(["Now 5", "Next 1", "Later 1"]);
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByRole("group", { name: "Plan scope" }).getByRole("button", { name: "Approved only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rows(page)).toHaveCount(7);
});

// protects = selecting a row opens its inspector (first row on load), with Open in PRD at the
// item's section, Open in roadmap at the item's anchor, Tracker in a new tab, the history and
// the goal's distance to go; fails_when = a link points elsewhere; no_claim = the targets'
// pages (the mock's roadmap draft for Checkout redesign has no document).
test("selecting a row opens the inspector with its links", async ({ page }) => {
  await openPlan(page);
  const inspector = page.getByTestId("plan-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Item · selected");
  await expect(inspector).toContainText(await rows(page).first().getByTestId("plan-title").innerText());
  await row(page, "Daily alert digest email").click();
  await expect(inspector.getByRole("heading", { name: "Daily alert digest email" })).toBeVisible();
  await expect(inspector.getByRole("link", { name: "Open in PRD" })).toHaveAttribute("href", "/documents/usage-alerts/v/1#behaviour");
  await expect(inspector.getByRole("link", { name: "Open in roadmap" })).toHaveAttribute(
    "href",
    "/documents/usage-alerts-roadmap/v/1#now-alert-digest",
  );
  const tracker = inspector.getByRole("link", { name: "Tracker ↗" });
  await expect(tracker).toHaveAttribute("href", "https://tracker.example.com/ENG-405");
  await expect(tracker).toHaveAttribute("target", "_blank");
  await expect(tracker).toHaveAttribute("rel", "noopener noreferrer");
  await expect(inspector.getByTestId("plan-why")).toContainText("ENG-405 targets Dec 9");
  await expect(inspector.getByTestId("plan-history")).toContainText("PRD v1 Now · approved Oct 18");
  await expect(inspector.getByTestId("plan-item-goal")).toContainText("Grow paid conversion");
  await expect(inspector.getByTestId("plan-item-goal")).toContainText("to go");
});

// protects = the tab strip is PLAN_TABS in order with the open tab aria-current, and an entry
// registered in the mock build follows; the Roadmap documents tab keeps the roadmap list and
// Build roadmap; fails_when = a tab is missing, out of order or not marked; no_claim = the
// later tabs' pages (F3, H3, H6 build them; H6's /roadmap/* pages have not landed).
test("the tab strip lists Plan's tabs in order; Roadmap documents keeps the list", async ({ page }) => {
  await page.addInitScript(
    ([key, tabs]) => localStorage.setItem(key, tabs),
    [MOCK_PLAN_TABS_KEY, JSON.stringify([{ key: "launches", label: "Launches", href: "/plan/launches", testId: "plan-tab-launches" }])] as const,
  );
  await openPlan(page);
  const strip = page.getByTestId("plan-tabs").filter({ visible: true });
  // F3 (Dates) and H3 (Outcomes) landed in PLAN_TABS, in that order; the registered entry is
  // now H6's Launches, whose page has not landed.
  await expect(strip.getByRole("link")).toHaveText(["Plan", "Documents", "Dates", "Outcomes", "Reports", "Launches"]);
  await expect(strip.getByTestId("plan-tab-plan")).toHaveAttribute("aria-current", "page");
  await strip.getByRole("link", { name: "Roadmap documents" }).click();
  await expect(page).toHaveURL(/\/plan\/documents$/);
  await expect(page.getByTestId("plan-tabs").filter({ visible: true }).getByTestId("plan-tab-documents")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("roadmap-row")).toHaveCount(1);
  await expect(page.getByTestId("approved-prd").getByRole("button", { name: "Build roadmap" })).toBeVisible();
  await expect(rail(page).getByTestId("nav-plan")).toHaveAttribute("aria-current", "page");
});

// protects = a roadmap document belongs to Plan: its breadcrumb says Plan and the rail
// highlights Plan; fails_when = it says Roadmap or highlights PRDs; no_claim = none.
test("a roadmap document's breadcrumb reads Plan and the rail highlights Plan", async ({ page }) => {
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first();
  await expect(crumb.getByRole("link", { name: "Plan", exact: true })).toHaveAttribute("href", "/plan");
  await expect(rail(page).getByTestId("nav-plan")).toHaveAttribute("aria-current", "page");
  await expect(rail(page).getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
});

// protects = on a 390 px phone rows render as cards under Now / Next / Later, a tap opens the
// item in a bottom sheet, and the page never scrolls sideways; fails_when = the table keeps
// its columns or widens the page; no_claim = a real phone's browser.
test("phone: rows are cards, a tap opens the sheet, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/plan");
  await expect(rows(page).first()).toBeVisible();
  await expect(groups(page)).toHaveText(["Now 7", "Next 1", "Later 2"]);
  const first = row(page, "Daily alert digest email");
  // A card: the state chip beside the title, PRD, goal, engineering and Next below it.
  const [title, chip] = await Promise.all([first.getByTestId("plan-title").boundingBox(), first.getByTestId("plan-state").boundingBox()]);
  expect(chip!.y).toBeLessThan(title!.y + title!.height);
  await expect(first.getByTestId("plan-engineering")).toBeVisible();
  // A tap on the title (a tap on the goal chip opens the goal's card instead).
  await first.getByTestId("plan-title").click();
  const sheet = page.getByTestId("sheet-plan-item");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Open in PRD" })).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
});

// protects = the page renders in light and dark with no console error; fails_when = a render
// or hydration error is logged; no_claim = colour contrast (design-system.spec.ts).
for (const theme of ["light", "dark"] as const) {
  test(`the Plan renders in the ${theme} theme with no console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(([key, t]) => localStorage.setItem(key, t), [THEME_KEY, theme] as const);
    await openPlan(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("plan-inspector").filter({ visible: true })).toBeVisible();
    await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
    await expect(page.getByTestId("roadmap-row")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

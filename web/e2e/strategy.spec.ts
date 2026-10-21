import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

/**
 * H4 Strategy and vision through the UI on the mock layer: the Inbox's strategy drift row
 * (owners only); a product strategy's version page, which reviews like a PRD and only an
 * owner approves; and Company › Strategy (lane 3): the vision and strategy cards, the
 * stack table, the drift list with its waivers, and the sheet that drafts a vision or
 * strategy with Oracle.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>.
 */

/** A company with an approved vision and product strategy, and four open drift findings (two high). */
const withStrategy = (page: Page) => page.addInitScript((key) => localStorage.setItem(key, "strategy"), MOCK_SCENARIO_KEY);
const as = (page: Page, role: string) =>
  page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);

const STRATEGY_V2 = "/documents/product-strategy/v/2";

// protects=owners see "Strategy drift · 4 new" with the high count and a way to the findings;
// fails_when=the row is missing, miscounts, or counts once per finding in Needs you;
// no_claim=the Company › Strategy page it opens (below).
test("strategy: an owner's Inbox shows the strategy drift row, counted once", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.getByTestId("nav-inbox").first().click();
  await expect(page).toHaveURL(/\/inbox$/);
  const group = page.getByTestId("inbox-strategy");
  const row = group.getByRole("row").filter({ hasText: "Strategy drift" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Strategy drift · 4 new");
  await expect(row).toContainText("2 high");
  await expect(row.getByRole("link", { name: "Open strategy drift" })).toHaveAttribute("href", "/company/strategy");
});

// protects=the strategy row is an owner's; fails_when=an approver sees it; no_claim=other roles' rows.
test("strategy: an approver's Inbox has no strategy drift row", async ({ page }) => {
  await withStrategy(page);
  await as(page, "approver");
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-needs")).toBeVisible();
  await expect(page.getByTestId("inbox-strategy")).toHaveCount(0);
  await expect(page.getByText("Strategy drift")).toHaveCount(0);
});

// protects=a product strategy's version page reviews like a PRD (section verdicts, comments)
// and its Approve button is absent for an approver; fails_when=an approver can approve, or
// gets Publish instead; no_claim=the API refusal (pytest covers it).
test("strategy: an approver reviews a strategy's sections but cannot approve it", async ({ page }) => {
  await withStrategy(page);
  await as(page, "approver");
  await login(page);
  await page.goto(STRATEGY_V2);
  const header = page.getByTestId("doc-header");
  await expect(header).toContainText("Product strategy");

  const focus = await openSection(page, "focus");
  const bar = focus.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Request changes" }).click();
  await bar.getByLabel(/What should change/).fill("Tie self-serve to the activation goal.");
  await bar.getByRole("button", { name: /^Save/ }).click();
  await expect(bar.getByTestId("verdict-state")).toContainText("Changes requested");

  await expect(header.getByRole("button", { name: "Approve version" })).toHaveCount(0);
  await expect(header.getByRole("link", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("owner-approves-note")).toContainText("Only an owner approves a product strategy");
});

// protects=an owner approves a product strategy from its version page; fails_when=the owner
// gets Publish or no Approve button; no_claim=the graph sync on approval (pytest).
test("strategy: an owner approves the strategy's latest version", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto(STRATEGY_V2);
  const header = page.getByTestId("doc-header");
  await expect(header.getByRole("link", { name: "Publish", exact: true })).toHaveCount(0);
  await header.getByRole("button", { name: "Approve version" }).click();
  await page.getByRole("group", { name: "Confirm approval" }).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/✓ Approved/)).toBeVisible();
  await expect(page.getByTestId("doc-status")).toHaveText("Approved");
});

// protects=the PRDs list stays PRDs only, and Documents › New still offers only a PRD;
// fails_when=the strategy or vision shows there; no_claim=where they are reached (below).
test("strategy: the PRDs list does not list the vision or the strategy", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.getByTestId("nav-prds").first().click();
  await expect(page).toHaveURL(/\/documents$/);
  const rows = page.getByTestId("documents-table").filter({ visible: true }).getByTestId("document-row");
  await expect(rows.filter({ hasText: "Checkout redesign" })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Product strategy|^Vision/ })).toHaveCount(0);
});

// ---------------------------------------------------------------- Company › Strategy (lane 3)

/** The mock company with a product strategy and no vision. */
const withoutVision = (page: Page) =>
  page.addInitScript((key) => localStorage.setItem(key, "strategy-no-vision"), MOCK_SCENARIO_KEY);

const strategyPage = (page: Page) => page.getByTestId("strategy-page").filter({ visible: true });

// protects=Company in the rail opens /company/strategy, its first tab, with the Vision card
// (3 beliefs with their status chips), the Strategy card (2 focus rows, 1 stop row whose
// "2 items still planned" is red) and the stack table's "Not under the strategy" group;
// fails_when=Company lands elsewhere, Strategy is not the first tab, or a card, row or the
// group is missing; no_claim=the stack's numbers (pytest covers the API's).
test("strategy: an owner opens Company and lands on Strategy with the vision, the strategy and the stack", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  const tabs = page.getByRole("navigation", { name: "Company" });
  await expect(tabs.getByRole("link")).toHaveText(["Strategy", "Decisions"]);
  await expect(tabs.getByTestId("company-tab-strategy")).toHaveAttribute("aria-current", "page");

  const root = strategyPage(page);
  const vision = root.getByTestId("vision-card");
  await expect(vision).toContainText("Every small team plans its product like a large one.");
  await expect(vision).toContainText("5 years");
  const beliefs = vision.getByTestId("vision-belief");
  await expect(beliefs).toHaveCount(3);
  await expect(beliefs.nth(0)).toContainText("Supported");
  await expect(beliefs.nth(0)).toContainText("3 evidence");
  await expect(beliefs.nth(1)).toContainText("Untested");
  await expect(beliefs.nth(2)).toContainText("Strained");

  const strategy = root.getByTestId("strategy-card");
  await expect(strategy).toContainText("Win self-serve teams first; stop custom reporting.");
  await expect(strategy.getByTestId("focus-row")).toHaveCount(2);
  const self = strategy.getByTestId("focus-row").filter({ hasText: "Self-serve onboarding" });
  await expect(self.getByTestId("goal-chip")).toHaveText([/Raise activation/, /Grow paid conversion/]);
  await expect(self.getByTestId("goal-chip").first()).toContainText("7 pts to go");
  await expect(self).toContainText("4 items");
  const stop = strategy.getByTestId("stop-row");
  await expect(stop).toHaveCount(1);
  await expect(stop).toContainText("Custom report builder");
  const planned = stop.getByTestId("stop-planned");
  await expect(planned).toHaveText("2 items still planned");
  await expect(planned).toHaveAttribute("data-tone", "fail");
  await expect(strategy).toContainText("Next review 1 Oct 2027");

  const stack = root.getByTestId("strategy-stack");
  await expect(stack.getByRole("columnheader")).toHaveText(["Vision belief", "Focus choice", "Goal", "Roadmap items", "Findings"]);
  await expect(stack.locator("[data-group]").filter({ hasText: "Not under the strategy" })).toHaveCount(1);
  await expect(stack.getByTestId("stack-row").filter({ hasText: "Retention" })).toHaveCount(1);
  await expect(stack.getByTestId("stack-row").filter({ hasText: "Dark mode" })).toHaveCount(1);
});

// protects=the inspector shows the selected row's chain and findings; Waive with a reason
// moves the finding to Waived, and the owner's Inbox row drops from 4 new to 3; fails_when=a
// waiver needs no reason, stays Open, or the Inbox does not follow; no_claim=the audit
// event (pytest).
test("strategy: an owner waives a finding with a reason; it moves to Waived and the Inbox count drops", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);

  // The stack inspector: the chain and the finding of an item not under the strategy.
  await root.getByTestId("stack-row").filter({ hasText: "Dark mode" }).click();
  const inspector = root.getByTestId("stack-inspector");
  await expect(inspector).toContainText("Not under the strategy");
  await expect(inspector.getByTestId("inspector-finding")).toContainText("Outside the strategy");

  const drift = root.getByTestId("drift-list");
  await expect(drift.getByTestId("finding-row")).toHaveCount(4);
  const row = drift.getByTestId("finding-row").filter({ hasText: "Dark mode" });
  await expect(row).toContainText("Outside the strategy");
  await row.getByRole("button", { name: "Waive" }).click();
  const form = row.getByRole("group", { name: "Waive finding" });
  await expect(form.getByRole("button", { name: "Waive finding" })).toBeDisabled();
  await form.getByLabel("Why waive it?").fill("Dark mode is a one-week accessibility fix.");
  await form.getByRole("button", { name: "Waive finding" }).click();

  await expect(drift.getByTestId("finding-row")).toHaveCount(3);
  await expect(drift.getByTestId("finding-row").filter({ hasText: "Dark mode" })).toHaveCount(0);
  await drift.getByRole("group", { name: "Finding state" }).getByRole("button", { name: /^Waived/ }).click();
  const waived = drift.getByTestId("finding-row").filter({ hasText: "Dark mode" });
  await expect(waived).toContainText("Dark mode is a one-week accessibility fix.");
  await expect(waived.getByRole("button", { name: "Waive" })).toHaveCount(0);

  await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
  await expect(page.getByTestId("inbox-strategy").getByRole("row").filter({ hasText: "Strategy drift" })).toContainText(
    "Strategy drift · 3 new",
  );
});

// protects=an owner's Draft next version opens the sheet (what changed, the horizon, start
// from the last approved version) and Draft with Oracle starts the strategy_draft run;
// fails_when=the button or a field is missing, or no run starts; no_claim=what the agents
// write (the mock's local runtime writes nothing for this flow).
test("strategy: an owner drafts the next strategy version with Oracle from the sheet", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  await expect(root.getByRole("button", { name: "New vision" })).toHaveCount(0);
  await root.getByTestId("strategy-card").getByRole("button", { name: "Draft next version" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft next version" });
  await sheet.getByLabel("What changed since the last one").fill("Team plans moved up after the pricing change.");
  await sheet.getByLabel("From").fill("2027-01-01");
  await sheet.getByLabel("To").fill("2027-12-31");
  await expect(sheet.getByLabel("Start from the last approved version (v1)")).toBeChecked();
  await expect(sheet.getByRole("button", { name: "Start from the empty template" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Vision or strategy draft");
  await expect(page.getByText("product-strategy").first()).toBeVisible();
});

// protects=with no vision, an owner sees New vision; its sheet asks the horizon in years and
// Draft with Oracle creates the vision from the built-in template and starts the run; the
// template-only path opens the new document; fails_when=no New vision, or no document or
// run is made; no_claim=the vision's content.
test("strategy: with no vision, an owner starts one with Oracle, or from the empty template", async ({ page }) => {
  await withoutVision(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  await expect(root.getByTestId("vision-card").getByRole("button", { name: "Open vision" })).toHaveCount(0);
  await root.getByTestId("vision-card").getByRole("button", { name: "New vision" }).click();
  const sheet = page.getByRole("dialog", { name: "New vision" });
  await expect(sheet.getByLabel("Horizon in years")).toHaveValue("5");
  await expect(sheet.getByLabel(/Start from the last approved version/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "Start from the empty template" }).click();
  await expect(page).toHaveURL(/\/documents\/vision/);
  await expect(page.getByTestId("doc-header")).toContainText("Vision");

  await page.goto("/company/strategy");
  // The vision exists now (a draft, not approved): the card offers it and a next version.
  const card = strategyPage(page).getByTestId("vision-card");
  await expect(card.getByRole("button", { name: "New vision" })).toHaveCount(0);
  await card.getByRole("button", { name: "Draft next version" }).click();
  const next = page.getByRole("dialog", { name: "Draft next version" });
  await next.getByLabel("Horizon in years").fill("3");
  await next.getByRole("button", { name: "Draft with Oracle" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Vision or strategy draft");
});

// protects=only owners draft a vision or strategy, and Documents › New stays the PRD door;
// fails_when=an approver sees New vision or Draft next version, or New offers a vision or
// strategy template; no_claim=the API's 403 (pytest).
test("strategy: an approver sees no drafting buttons, and Documents › New still offers only a PRD", async ({ page }) => {
  await withoutVision(page);
  await as(page, "approver");
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  await expect(root.getByTestId("strategy-card")).toContainText("Self-serve onboarding");
  await expect(root.getByRole("button", { name: "New vision" })).toHaveCount(0);
  await expect(root.getByRole("button", { name: "Draft next version" })).toHaveCount(0);
  await expect(root.getByRole("button", { name: "New product strategy" })).toHaveCount(0);

  await page.goto("/documents/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New PRD");
  await expect(page.getByTestId("template-option-oracle-default")).toBeVisible();
  await expect(page.getByTestId("template-option-vision-narrative")).toHaveCount(0);
  await expect(page.getByTestId("template-option-product-strategy")).toHaveCount(0);
});

// protects=Open strategy leads to the strategy document with Company highlighted in the rail
// and the breadcrumb "Company › Strategy" back to this page; fails_when=PRDs is highlighted
// or the crumb says PRDs; no_claim=the version page's review (above).
test("strategy: Open strategy highlights Company and the breadcrumb reads Company › Strategy", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  await strategyPage(page).getByTestId("strategy-card").getByRole("link", { name: "Open strategy" }).click();
  await expect(page).toHaveURL(/\/documents\/product-strategy/);
  const nav = page.getByTestId("app-nav");
  await expect(nav.getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-prds")).not.toHaveAttribute("aria-current", "page");
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first();
  await expect(crumb).toContainText("Company › Strategy");
  await crumb.getByRole("link", { name: "Company › Strategy" }).click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
});

// protects=at 390 px the cards stack, the stack table keeps Choice, Goal and Items, and the
// page never scrolls sideways; fails_when=the cards sit side by side, other columns show,
// or the page overflows; no_claim=Chromium's layout.
test("strategy: phone, the cards stack and the stack table keeps Choice, Goal and Items", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withStrategy(page);
  await login(page);
  await page.goto("/company/strategy");
  const root = strategyPage(page);
  const vision = await root.getByTestId("vision-card").boundingBox();
  const strategy = await root.getByTestId("strategy-card").boundingBox();
  expect(vision && strategy).toBeTruthy();
  expect(strategy!.y).toBeGreaterThanOrEqual(vision!.y + vision!.height);
  const row = root.getByTestId("stack-row").filter({ hasText: "Raise activation" });
  const visibleCols = await row.locator("[data-col]").evaluateAll((cells) =>
    cells.filter((c) => (c as HTMLElement).checkVisibility()).map((c) => c.getAttribute("data-col")),
  );
  expect(visibleCols).toEqual(["choice", "goal", "items"]);
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
});

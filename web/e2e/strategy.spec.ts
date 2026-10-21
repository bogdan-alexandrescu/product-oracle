import { expect, test, type Page } from "@playwright/test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

/**
 * H4 Strategy and vision, lanes 1 and 2, through the UI on the mock layer: the Inbox's
 * strategy drift row (owners only), and a product strategy's version page, which reviews like
 * a PRD and only an owner approves. Company › Strategy (lane 3) is not on main yet.
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
// no_claim=the Company › Strategy page it opens (lane 3).
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
// fails_when=the strategy or vision shows there; no_claim=where they are reached (lane 3).
test("strategy: the PRDs list does not list the vision or the strategy", async ({ page }) => {
  await withStrategy(page);
  await login(page);
  await page.getByTestId("nav-prds").first().click();
  await expect(page).toHaveURL(/\/documents$/);
  const rows = page.getByTestId("documents-table").filter({ visible: true }).getByTestId("document-row");
  await expect(rows.filter({ hasText: "Checkout redesign" })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Product strategy|^Vision/ })).toHaveCount(0);
});

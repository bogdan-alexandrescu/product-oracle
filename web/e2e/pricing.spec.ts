import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, section, signOut } from "./helpers";

/*
 * H9 Pricing input (issue #516, criterion 10), driven through the UI on the mock layer. The
 * "pricing" scenario is the default company (Company zone America/Los_Angeles) plus a second
 * owner, Riley Park (riley@example.com), made-up deals ("Account 3" … "Account 14"), and two
 * pricing memos: "Team plan pricing", approved and not decided, and "Starter plan price",
 * decided as a pricing decision. The pricing owner is the earliest owner, Admin.
 * Each test states its card: protects / fails_when / no_claim.
 */

const APPROVER = "approver@example.com";
const COMMENTER = "commenter@example.com";
const SECOND_OWNER = "riley@example.com";
const QUESTION = "Should the Starter plan add a yearly price with two months free?";

const pricingScenario = (page: Page) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "pricing"]);

test.beforeEach(async ({ page }) => {
  await pricingScenario(page);
});

/** Company › Market from the rail, as a person gets there; Pricing is its first tab. */
async function openMarket(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-market").click();
  await expect(page).toHaveURL(/\/company\/market$/);
  await expect(page.getByTestId("pricing-table")).toBeVisible();
}

/** Opens a memo from Company › Market › Pricing (its document page). */
async function openMemo(page: Page, title: string) {
  await openMarket(page);
  await page.getByTestId("pricing-table").getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/documents\/[a-z0-9-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

test("10a: an approver drafts a new pricing memo with Oracle; it opens on the question, recommendation and options", async ({ page }) => {
  // protects=an approver opens Company › Market › Pricing, clicks New pricing memo, types a
  // question, sees the evidence window prefilled (the last six months through today) and
  // clicks Draft with Oracle; the run's memo is the latest version and opens brief first:
  // The question (with the typed question), Recommendation, then Options with one section
  // per option; the crumb says Company › Market › Pricing; fails_when=the button is missing
  // for an approver, the run does not write the memo, the question is lost, or the brief is
  // not first; no_claim=the real agents' wording or the API's $10.00 estimate (the mock
  // runtime writes a fixed draft).
  await login(page, APPROVER);
  await openMarket(page);
  await page.getByRole("button", { name: "New pricing memo" }).click();
  const sheet = page.getByRole("dialog", { name: "New pricing memo" });
  await sheet.getByLabel("Question").fill(QUESTION);
  await expect(sheet.getByLabel("From", { exact: true })).not.toHaveValue("");
  await expect(sheet.getByLabel("To", { exact: true })).not.toHaveValue("");
  await sheet.getByRole("button", { name: "Draft with Oracle" }).click();

  await expect(page).toHaveURL(/\/documents\/pricing-[a-z0-9-]+$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).first()).toContainText("Company › Market › Pricing");
  await page.getByRole("link", { name: "Open latest (v2)" }).click();
  const rows = page.getByTestId("outline-rail").filter({ visible: true }).locator("a[data-outline-key]");
  await expect(rows.nth(0)).toHaveAttribute("data-outline-key", "question");
  await expect(rows.nth(1)).toHaveAttribute("data-outline-key", "recommendation");
  await expect(rows.nth(2)).toHaveAttribute("data-outline-key", "options");
  await expect(section(page, "question")).toContainText(QUESTION);
  await expect(page.getByTestId("app-nav").getByTestId("nav-company")).toHaveAttribute("aria-current", "page");
  // Oracle's words on the memo: a company, never a workspace or tenant.
  await expect(page.getByTestId("doc-header").filter({ visible: true })).not.toContainText(/workspace|tenant/i);
  await expect(section(page, "question")).not.toContainText(/workspace|tenant/i);
});

test("10b: Import CSV on Win and loss: the dry run lists 3 rows to create and 1 refused with its line; Import adds 3", async ({ page }) => {
  // protects=an approver opens Win and loss, picks a CSV of 3 good rows and one with a bad
  // date on line 4 (the header is line 1), sees "3 rows to create" and "Line 4: decided_on
  // must be YYYY-MM-DD" before anything is created, then Import adds exactly the 3 rows;
  // fails_when=the dry run creates rows, the bad line is not named, or the good rows are not
  // imported; no_claim=the API's CSV parser (tests/test_deal_outcomes.py covers it).
  await login(page, APPROVER);
  await openMarket(page);
  await page.getByTestId("market-tab-win-loss").click();
  await expect(page).toHaveURL(/tab=win-loss/);
  const table = page.getByTestId("deals-table");
  await expect(table.getByTestId("deal-row")).toHaveCount(6);

  await page.getByRole("button", { name: "Import CSV" }).click();
  const sheet = page.getByRole("dialog", { name: "Import win and loss" });
  const csv = [
    "result,account,segment,plan,annual_value,currency,decided_on,reason,reason_note,alternative,price_quoted",
    "lost,Account 21,Teams 10-50,Team,4800,USD,2026-09-02,price,Asked for a flat price,,$20 per seat a month",
    "won,Account 22,Teams under 10,Starter,960,USD,2026-09-03,value,,,",
    "lost,Account 23,Teams 10-50,Team,,,next tuesday,price,,,",
    "churned,Account 24,Teams 50+,Business,,,2026-09-05,alternative,,Example Rival,",
  ].join("\n");
  await sheet.getByLabel("CSV file").setInputFiles({ name: "deals.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(sheet.getByTestId("import-create")).toHaveText("3 rows to create");
  await expect(sheet.getByTestId("import-refused-row")).toHaveCount(1);
  await expect(sheet.getByTestId("import-refused-row")).toHaveText("Line 4: decided_on must be YYYY-MM-DD");
  // The dry run created nothing.
  await expect(table.getByTestId("deal-row")).toHaveCount(6);

  await sheet.getByRole("button", { name: "Import 3 rows" }).click();
  await expect(sheet).toBeHidden();
  await expect(table.getByTestId("deal-row")).toHaveCount(9);
  await expect(table).toContainText("Account 21");
  await expect(table).toContainText("Account 24");
  await expect(table).not.toContainText("Account 23");
  // The alternative is kept as text until H7's alternatives land.
  await expect(table.getByTestId("deal-row").filter({ hasText: "Account 24" })).toContainText("Example Rival");
});

test("10c: the pricing owner clicks Decide on the approved memo, decides it in Company › Decisions and sees it Decided", async ({ page }) => {
  // protects=the pricing owner (Admin, the earliest owner) opens the approved memo, clicks
  // Decide, lands on its proposed decision in Company › Decisions with the memo's two
  // options, picks one, writes the reason and the expected outcome, sees it decided, and the
  // memo then reads Decided with its D-number and chosen option on Pricing; fails_when=Decide
  // is missing for the pricing owner, the decision lacks the memo's options, or the memo's
  // state does not follow; no_claim=H3's outcome record (tests/test_pricing_memo.py).
  await login(page);
  await openMemo(page, "Team plan pricing");
  await page.getByTestId("pricing-decide").click();
  await expect(page).toHaveURL(/\/company\/decisions\?d=\d+$/);
  const inspector = page.getByTestId("decision-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Price: Should the team plan move from per-seat to a flat price per team?");
  await expect(inspector.getByTestId("decision-option")).toHaveCount(2);
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Keep per-seat pricing" })).toBeVisible();
  await expect(inspector.getByTestId("decision-option").filter({ hasText: "Flat price per team" })).toBeVisible();

  await inspector.getByRole("button", { name: "Decide" }).click();
  const form = inspector.getByRole("form", { name: "Decide" });
  await form.getByRole("radio", { name: "Flat price per team" }).check();
  await form.getByLabel("Why").fill("Teams ask for one price; two of three losses were on price.");
  await form.getByLabel("Expected outcome").fill("More teams of 10 to 50 choose the Team plan.");
  await form.getByRole("button", { name: "Record decision" }).click();
  await expect(inspector.getByTestId("decision-chosen")).toContainText("Flat price per team");
  await expect(inspector).toContainText("Teams ask for one price; two of three losses were on price.");

  await openMarket(page);
  const row = page.getByTestId("memo-row").filter({ hasText: "Team plan pricing" });
  await expect(row.getByTestId("memo-state")).toHaveText("Decided");
  await expect(row.getByTestId("memo-decision")).toContainText("Flat price per team");
});

test("10d: another owner sees Waiting for Admin to decide, and no Decide button", async ({ page }) => {
  // protects=an owner who is not the pricing owner opens the approved memo and reads "Waiting
  // for Admin to decide" in its header, with no Decide button; fails_when=Decide shows for
  // them or the line names nobody; no_claim=the API's 403 for them (tests/test_pricing_memo.py).
  await login(page, SECOND_OWNER);
  await openMemo(page, "Team plan pricing");
  await expect(page.getByTestId("pricing-waiting")).toHaveText("Waiting for Admin to decide");
  await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(0);
});

test("10e: a commenter has no Market tab and no pricing decision in Company › Decisions", async ({ page }) => {
  // protects=a commenter sees no Market tab (so no Pricing or Win and loss), "Not found" at
  // its address, and no pricing decision among all of Company › Decisions, while an approver
  // sees that decision; fails_when=the tab is drawn (even disabled), the page shows memos or
  // deals, or the pricing decision is listed for the commenter; no_claim=MCP and search
  // (tests/test_pricing_visibility.py).
  const decided = "Price: Should the Starter plan cost less for teams under 5 seats?";
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^All/ }).click();
  await expect(page.getByTestId("decision-row").filter({ hasText: decided })).toHaveCount(1);
  await signOut(page);

  await login(page, COMMENTER);
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  const nav = page.getByRole("navigation", { name: "Company" });
  await expect(nav.getByTestId("company-tab-decisions")).toBeVisible();
  await expect(nav.getByTestId("company-tab-market")).toHaveCount(0);
  await nav.getByTestId("company-tab-decisions").click();
  await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^All/ }).click();
  await expect(page.getByTestId("decision-row").first()).toBeVisible();
  await expect(page.getByTestId("decision-row").filter({ hasText: decided })).toHaveCount(0);
  await page.goto("/company/market?tab=win-loss");
  await expect(page.getByTestId("market-not-found")).toHaveText("Not found");
  await expect(page.getByTestId("deals-table")).toHaveCount(0);
});

test("10f: an owner sets the Pricing owner on Settings › Company; after a reload the new name shows", async ({ page }) => {
  // protects=an owner picks Riley Park as the pricing owner on Settings › Company, saves,
  // reloads and sees Riley Park chosen; the approved memo then waits for Riley Park;
  // fails_when=the field is missing, the choice is not saved, or the memo header still names
  // Admin; no_claim=the API's validation of a non-owner (tests/test_pricing_memo.py).
  await login(page);
  await page.goto("/settings/company");
  const field = page.getByTestId("pricing-owner-panel").getByRole("combobox", { name: "Pricing owner" });
  await expect(field.locator("option:checked")).toHaveText("Admin");
  await field.selectOption({ label: "Riley Park" });
  await page.getByTestId("pricing-owner-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("pricing-owner-panel").getByRole("status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("pricing-owner-panel").getByRole("combobox", { name: "Pricing owner" }).locator("option:checked")).toHaveText("Riley Park");

  await openMemo(page, "Team plan pricing");
  await expect(page.getByTestId("pricing-waiting")).toHaveText("Waiting for Riley Park to decide");
});

test("10f: a commenter or approver does not see the Pricing owner field", async ({ page }) => {
  // protects=Settings › Company draws the Pricing owner field for owners only; fails_when=an
  // approver sees it; no_claim=the API's owner-only setting (tests/test_pricing_memo.py).
  await login(page, APPROVER);
  await page.goto("/settings/company");
  await expect(page.getByRole("heading", { level: 1, name: "Company" })).toBeVisible();
  await expect(page.getByTestId("pricing-owner-panel")).toHaveCount(0);
});

test("10g: at 390 px the Pricing and Win and loss tables have no horizontal scroll", async ({ page }) => {
  // protects=on a phone both tables collapse (Memo and State; Result and Reason) and neither
  // the page nor a table scrolls sideways; fails_when=a column forces the width past 390 px;
  // no_claim=other phone widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, APPROVER);
  await page.goto("/company/market");
  const memos = page.getByTestId("pricing-table");
  await expect(memos.getByTestId("memo-row").first()).toBeVisible();
  await expect(memos.getByTestId("memo-state").first()).toBeVisible();
  const noSideways = async (testId: string) => {
    const [docOver, tableOver] = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, el.scrollWidth - el.clientWidth];
    }, testId);
    expect(docOver).toBeLessThanOrEqual(0);
    expect(tableOver).toBeLessThanOrEqual(0);
  };
  await noSideways("pricing-table");
  await page.getByTestId("market-tab-win-loss").click();
  const deals = page.getByTestId("deals-table");
  await expect(deals.getByTestId("deal-row").first()).toBeVisible();
  await expect(deals.getByTestId("deal-reason").first()).toBeVisible();
  await noSideways("deals-table");
});

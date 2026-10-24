import { expect, test, type Page } from "@playwright/test";

import { MOCK_DENY_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
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
  // question, sees the evidence window prefilled (six calendar months back from today in the
  // Company time zone, through that day) and
  // clicks Draft with Oracle; the run's memo is the latest version and opens brief first:
  // The question (with the typed question), Recommendation, then Options with one section
  // per option; the crumb says Company › Market › Pricing; fails_when=the button is missing
  // for an approver, the window is 182 days or ends on the browser's (UTC) day, the run does
  // not write the memo, the question is lost, or the brief is
  // not first; no_claim=the real agents' wording or the API's $10.00 estimate (the mock
  // runtime writes a fixed draft).
  // 03:00 UTC on Sep 1 is still Aug 31 in the Company zone (America/Los_Angeles); six
  // calendar months back from Aug 31 is Feb 28 (182 days would be Mar 2).
  await page.clock.setFixedTime(new Date("2026-09-01T03:00:00Z"));
  await login(page, APPROVER);
  await openMarket(page);
  await page.getByRole("button", { name: "New pricing memo" }).click();
  const sheet = page.getByRole("dialog", { name: "New pricing memo" });
  await sheet.getByLabel("Question").fill(QUESTION);
  await expect(sheet.getByLabel("From", { exact: true })).toHaveValue("2026-02-28");
  await expect(sheet.getByLabel("To", { exact: true })).toHaveValue("2026-08-31");
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

/** Company › Market › Win and loss from the rail, as a person gets there. */
async function openWinLoss(page: Page) {
  await openMarket(page);
  await page.getByTestId("market-tab-win-loss").click();
  await expect(page).toHaveURL(/tab=win-loss/);
  await expect(page.getByTestId("deals-table").getByTestId("deal-row").first()).toBeVisible();
}

const accounts = (page: Page) => page.getByTestId("deals-table").getByTestId("deal-account");

test("10h: the Pricing and Win and loss tables label their dates with the Company time zone", async ({ page }) => {
  // protects=Pricing's Updated column and Win and loss's Decided on column both name the
  // Company time zone their days are in; fails_when=either header has no zone;
  // no_claim=the day itself (lib/format.ts formats it in the Company zone).
  await login(page, APPROVER);
  await openMarket(page);
  await expect(page.getByTestId("pricing-table").getByRole("columnheader", { name: "Updated (America/Los_Angeles)" })).toBeVisible();
  await page.getByTestId("market-tab-win-loss").click();
  await expect(page.getByTestId("deals-table").getByRole("columnheader", { name: "Decided on (America/Los_Angeles)" })).toBeVisible();
});

test("10i: Win and loss filters by result, reason and period", async ({ page }) => {
  // protects=an approver narrows the six deals by Result (Lost: Account 7 and Account 9),
  // then Reason (Price: Account 7), clears them, and by Period (on Dec 31 the last 3 months
  // hold Oct 2, 6 and 9: Account 11, 12 and 14); a filter that matches nothing says so;
  // fails_when=a filter is ignored or keeps rows it should drop; no_claim=the API's query
  // (tests/test_deal_outcomes.py).
  await page.clock.setFixedTime(new Date("2026-12-31T20:00:00Z"));
  await login(page, APPROVER);
  await openWinLoss(page);
  await expect(accounts(page)).toHaveCount(6);
  await page.getByLabel("Result").selectOption({ label: "Lost" });
  await expect(accounts(page)).toHaveText(["Account 9", "Account 7"]);
  await page.getByLabel("Reason").selectOption({ label: "Price" });
  await expect(accounts(page)).toHaveText(["Account 7"]);
  await page.getByLabel("Result").selectOption({ label: "Won" });
  await expect(page.getByTestId("deals-empty")).toHaveText("No win or loss records match");
  await page.getByLabel("Result").selectOption({ label: "Any result" });
  await page.getByLabel("Reason").selectOption({ label: "Any reason" });
  await expect(accounts(page)).toHaveCount(6);
  await page.getByLabel("Period").selectOption({ label: "Last 3 months" });
  await expect(accounts(page)).toHaveText(["Account 14", "Account 12", "Account 11"]);
});

test("10j: an approver adds, edits and deletes a win or loss record", async ({ page }) => {
  // protects=Add opens the dialog and a saved record shows in the table with its result and
  // reason; Edit from its row menu changes them; Delete asks first and removes the row;
  // fails_when=a saved record is missing, the edit does not show, or Delete removes the row
  // without asking or not at all; no_claim=the API's rules (tests/test_deal_outcomes.py).
  await login(page, APPROVER);
  await openWinLoss(page);
  await expect(accounts(page)).toHaveCount(6);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add win or loss" });
  await add.getByLabel("Result").selectOption({ label: "Won" });
  await add.getByLabel("Decided on").fill("2026-10-01");
  await add.getByLabel("Account").fill("Account 31");
  await add.getByLabel("Main reason").selectOption({ label: "Value not clear" });
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(accounts(page)).toHaveCount(7);
  const row = () => page.getByTestId("deal-row").filter({ hasText: "Account 31" });
  await expect(row().getByTestId("deal-result")).toHaveText("Won");
  await expect(row().getByTestId("deal-reason")).toHaveText("Value not clear");

  await row().getByRole("button", { name: "Actions for Account 31" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit win or loss" });
  await expect(edit.getByLabel("Account")).toHaveValue("Account 31");
  await edit.getByLabel("Result").selectOption({ label: "Lost" });
  await edit.getByLabel("Main reason").selectOption({ label: "Price" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(row().getByTestId("deal-result")).toHaveText("Lost");
  await expect(row().getByTestId("deal-reason")).toHaveText("Price");

  await row().getByRole("button", { name: "Actions for Account 31" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const ask = page.getByRole("alertdialog").filter({ hasText: "Delete Lost · Account 31" });
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(row()).toHaveCount(1);
  await row().getByRole("button", { name: "Actions for Account 31" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await ask.getByRole("button", { name: "Delete record" }).click();
  await expect(row()).toHaveCount(0);
  await expect(accounts(page)).toHaveCount(6);
});

/** Capabilities answer false for `ops` (the mock's MOCK_DENY_KEY), set before signing in. */
const deny = (page: Page, ops: string[]) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_DENY_KEY, ops.join(",")]);

test("10k: without list_deal_outcomes there is no Win and loss tab, and its address shows Pricing", async ({ page }) => {
  // protects=#370: the Win and loss tab is drawn only when the role may list deal outcomes;
  // its address then opens Pricing, with no deals; fails_when=the tab is drawn (even
  // disabled) or the deals table shows; no_claim=the API's 403 (tests/test_deal_outcomes.py).
  await deny(page, ["list_deal_outcomes"]);
  await login(page, APPROVER);
  await openMarket(page);
  await expect(page.getByTestId("market-tab-win-loss")).toHaveCount(0);
  await page.goto("/company/market?tab=win-loss");
  await expect(page.getByTestId("pricing-table")).toBeVisible();
  await expect(page.getByTestId("deals-table")).toHaveCount(0);
});

test("10k: Add, Import CSV, Edit and Delete are each drawn only when allowed", async ({ page }) => {
  // protects=#370: with creating, importing and deleting not allowed, Win and loss shows no
  // Add or Import CSV and each row's menu holds Edit only; fails_when=a control is drawn
  // (even disabled) without its operation; no_claim=the API's checks.
  await deny(page, ["create_deal_outcome", "import_deal_outcomes", "delete_deal_outcome"]);
  await login(page, APPROVER);
  await openWinLoss(page);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for Account 7" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
});

test("10k: with neither Edit nor Delete allowed, the rows have no actions menu", async ({ page }) => {
  // protects=#370: a row's menu is absent when it would be empty, while Add and Import CSV
  // stay for a role allowed them; fails_when=an empty menu is drawn, or Add and Import go
  // with it; no_claim=the API's checks.
  await deny(page, ["update_deal_outcome", "delete_deal_outcome"]);
  await login(page, APPROVER);
  await openWinLoss(page);
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
});

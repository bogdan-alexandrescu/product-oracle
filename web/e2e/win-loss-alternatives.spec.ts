import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Win and loss records linked to a market alternative (H9 x H7, issue #516), driven through
 * the UI on the mock layer. The "pricing" scenario holds six made-up deals and three
 * alternatives: Competitor A (alias "CompA"), Spreadsheets and Old Rival (archived).
 * Account 9 was lost to Competitor A. Each test states its card: protects / fails_when /
 * no_claim.
 */

const APPROVER = "approver@example.com";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "pricing"]);
});

/** Company › Market › Win and loss from the rail, as a person gets there. */
async function openWinLoss(page: Page) {
  await page.getByTestId("app-nav").getByTestId("nav-company").click();
  await expect(page).toHaveURL(/\/company\/strategy$/);
  await page.getByRole("navigation", { name: "Company" }).getByTestId("company-tab-market").click();
  await expect(page).toHaveURL(/\/company\/market$/);
  await page.getByTestId("market-tab-win-loss").click();
  await expect(page).toHaveURL(/tab=win-loss/);
  await expect(page.getByTestId("deals-table").getByTestId("deal-row").first()).toBeVisible();
}

const accounts = (page: Page) => page.getByTestId("deals-table").getByTestId("deal-account");
const row = (page: Page, account: string) => page.getByTestId("deal-row").filter({ hasText: account });

test("an approver links a record to an alternative and filters Win and loss by it", async ({ page }) => {
  // protects=the Alternative column shows the linked alternative's name (Account 9: Competitor
  // A); Edit offers the company's active alternatives and saving Spreadsheets on Account 7
  // shows it; the Alternative filter keeps only the records linked to the picked alternative
  // and "Any alternative" brings all six back; fails_when=the link is not saved or shown, the
  // filter is ignored, or it keeps records of another alternative; no_claim=the API's checks
  // (tests/test_deal_outcomes.py).
  await login(page, APPROVER);
  await openWinLoss(page);
  await expect(accounts(page)).toHaveCount(6);
  await expect(row(page, "Account 9").getByTestId("deal-alternative")).toHaveText("Competitor A");
  await expect(row(page, "Account 7").getByTestId("deal-alternative")).toHaveText("—");

  await row(page, "Account 7").getByRole("button", { name: "Actions for Account 7" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit win or loss" });
  await expect(edit.getByLabel(/^Alternative/)).toHaveValue("");
  await edit.getByLabel(/^Alternative/).selectOption({ label: "Spreadsheets" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(row(page, "Account 7").getByTestId("deal-alternative")).toHaveText("Spreadsheets");

  await page.getByLabel(/^Alternative/).selectOption({ label: "Competitor A" });
  await expect(accounts(page)).toHaveText(["Account 9"]);
  await page.getByLabel(/^Alternative/).selectOption({ label: "Spreadsheets" });
  await expect(accounts(page)).toHaveText(["Account 7"]);
  await page.getByLabel("Result").selectOption({ label: "Won" });
  await expect(page.getByTestId("deals-empty")).toHaveText("No win or loss records match");
  await page.getByLabel("Result").selectOption({ label: "Any result" });
  await page.getByLabel(/^Alternative/).selectOption({ label: "Any alternative" });
  await expect(accounts(page)).toHaveCount(6);
});

test("Add offers only active alternatives, and None leaves a record unlinked", async ({ page }) => {
  // protects=the Add dialog's Alternative list is None, Competitor A and Spreadsheets (not
  // the archived Old Rival); a record added with Competitor A shows it and is found by the
  // filter; editing it back to None clears the link; fails_when=an archived alternative is
  // offered, the pick is lost, or None keeps the link; no_claim=the Alternatives tab's
  // archive flow (e2e/market.spec.ts).
  await login(page, APPROVER);
  await openWinLoss(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add win or loss" });
  await expect(add.getByLabel(/^Alternative/).getByRole("option")).toHaveText(["None", "Competitor A", "Spreadsheets"]);
  await add.getByLabel("Decided on").fill("2026-10-01");
  await add.getByLabel("Account").fill("Account 31");
  await add.getByLabel("Main reason").selectOption({ label: "Chose an alternative" });
  await add.getByLabel(/^Alternative/).selectOption({ label: "Competitor A" });
  await add.getByRole("button", { name: "Add", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(row(page, "Account 31").getByTestId("deal-alternative")).toHaveText("Competitor A");
  await page.getByLabel(/^Alternative/).selectOption({ label: "Competitor A" });
  await expect(accounts(page)).toHaveText(["Account 31", "Account 9"]);

  await row(page, "Account 31").getByRole("button", { name: "Actions for Account 31" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit win or loss" });
  await expect(edit.getByLabel(/^Alternative/)).toHaveValue(/.+/);
  await edit.getByLabel(/^Alternative/).selectOption({ label: "None" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(accounts(page)).toHaveText(["Account 9"]);
});

test("Import CSV links an alternative by name or alias and keeps an unknown one as text", async ({ page }) => {
  // protects=the dry run says which named alternatives are not the company's ("Example
  // Rival") before anything is created; after Import, the row naming "compa" (Competitor
  // A's alias) is linked to Competitor A and found by the filter, and the row naming Example
  // Rival shows that name as text but is not linked; fails_when=a match is kept as text, an
  // unknown name is lost or linked, or the dry run is silent about it; no_claim=the API's
  // matching rules in full (tests/test_deal_outcomes.py).
  await login(page, APPROVER);
  await openWinLoss(page);
  await page.getByRole("button", { name: "Import CSV" }).click();
  const sheet = page.getByRole("dialog", { name: "Import win and loss" });
  const csv = [
    "result,account,segment,plan,annual_value,currency,decided_on,reason,reason_note,alternative,price_quoted",
    "lost,Account 41,Teams 10-50,Team,,,2026-09-02,alternative,,compa,",
    "churned,Account 42,Teams 50+,Business,,,2026-09-05,alternative,,Example Rival,",
  ].join("\n");
  await sheet.getByLabel("CSV file").setInputFiles({ name: "deals.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(sheet.getByTestId("import-create")).toHaveText("2 rows to create");
  await expect(sheet.getByTestId("import-unmatched")).toHaveText("Not one of your alternatives, kept as text in the note: Example Rival");
  await expect(accounts(page)).toHaveCount(6);

  await sheet.getByRole("button", { name: "Import 2 rows" }).click();
  await expect(sheet).toBeHidden();
  await expect(row(page, "Account 41").getByTestId("deal-alternative")).toHaveText("Competitor A");
  await expect(row(page, "Account 42").getByTestId("deal-alternative")).toHaveText("Example Rival");
  await page.getByLabel(/^Alternative/).selectOption({ label: "Competitor A" });
  await expect(accounts(page)).toHaveText(["Account 9", "Account 41"]);
});

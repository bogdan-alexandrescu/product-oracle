import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Fourth QA pass on Company › Market, driven through the UI as a person would on the mock
 * layer. The "market" scenario seeds made-up alternatives (Competitor A, direct; Competitor
 * B, indirect; Spreadsheets, the status quo) and the positioning inputs; the "pricing"
 * scenario seeds made-up deals ("Account 3" … "Account 14") and pricing memos. Each test
 * names the finding it protects.
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

test.use({ viewport: { width: 1440, height: 900 } });

const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
const subTab = (page: Page, name: string) => page.getByRole("tablist", { name: "Market" }).getByRole("tab", { name });
const alternativeRow = (page: Page, name: string) => page.getByTestId("alternative-row").filter({ visible: true }).filter({ hasText: name });
const inspector = (page: Page) => page.getByTestId("alternative-inspector").filter({ visible: true });
const field = (page: Page, key: string) => page.locator(`[data-testid="positioning-field"][data-field="${key}"]`).filter({ visible: true });

async function openAlternatives(page: Page, email = APPROVER) {
  await scenario(page, "market");
  await login(page, email);
  await page.goto("/company/market");
  await expect(alternativeRow(page, "Competitor A")).toBeVisible();
}

async function openAddAlternative(page: Page) {
  await page.getByRole("button", { name: "Add alternative", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add alternative" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("qa4-company-5: Add alternative refuses a website that is not https://", async ({ page }) => {
  await openAlternatives(page);
  const dialog = await openAddAlternative(page);
  await dialog.getByLabel("Name").fill("Shared docs");
  await dialog.getByLabel("Kind").selectOption({ label: "Status quo" });
  await dialog.getByLabel("Website").fill("not a url");
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog.getByTestId("website-error")).toContainText("Only https:// addresses can be added");
  await expect(dialog).toBeVisible();
  await expect(alternativeRow(page, "Shared docs")).toHaveCount(0);

  await dialog.getByLabel("Website").fill("https://docs.example");
  await expect(dialog.getByTestId("website-error")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog).toBeHidden();
  await expect(alternativeRow(page, "Shared docs")).toHaveCount(1);
  await expect(inspector(page)).toContainText("docs.example");
  await expect(inspector(page)).not.toContainText("not a url");
});

test("qa4-company-6: an approver edits an alternative's kind and website, then archives it", async ({ page }) => {
  await openAlternatives(page);
  await alternativeRow(page, "Spreadsheets").click();
  const panel = inspector(page);
  await expect(panel).toContainText("Spreadsheets");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit alternative" });
  await expect(dialog.getByLabel("Name")).toHaveValue("Spreadsheets");
  await dialog.getByLabel("Kind").selectOption({ label: "Indirect" });
  await dialog.getByLabel("Website").fill("sheets dot example");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByTestId("website-error")).toBeVisible();
  await dialog.getByLabel("Website").fill("https://sheets.example");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByTestId("alternative-about")).toContainText("sheets.example");
  await expect(alternativeRow(page, "Spreadsheets")).toContainText("Indirect");

  await panel.getByRole("button", { name: "Archive", exact: true }).click();
  const confirm = panel.getByTestId("archive-confirm");
  await expect(confirm).toContainText("Archive Spreadsheets?");
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(alternativeRow(page, "Spreadsheets")).toHaveCount(0);
  await expect(alternativeRow(page, "Competitor A")).toHaveCount(1);
});

test("qa4-company-6: a viewer sees no Edit or Archive on an alternative", async ({ page }) => {
  await openAlternatives(page, VIEWER);
  await alternativeRow(page, "Spreadsheets").click();
  const panel = inspector(page);
  await expect(panel).toContainText("Spreadsheets");
  await expect(panel.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
});

test("qa4-company-32: New pricing memo shows what the Oracle run costs on its button", async ({ page }) => {
  await scenario(page, "pricing");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=pricing");
  await expect(page.getByTestId("pricing-table")).toBeVisible();
  await page.getByRole("button", { name: "New pricing memo" }).click();
  const sheet = page.getByRole("dialog", { name: "New pricing memo" });
  await expect(sheet.getByRole("button", { name: /^Draft with Oracle · \$\d/ })).toBeVisible();
  await expect(sheet.getByTestId("pricing-memo-cost")).toContainText(/one Oracle run of about \$\d/);
});

test("qa4-company-33: the CSV import has a 'Choose a CSV file' button and shows the chosen file's name", async ({ page }) => {
  await scenario(page, "pricing");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=win-loss");
  await expect(page.getByTestId("deals-table")).toBeVisible();
  await page.getByRole("button", { name: "Import CSV" }).click();
  const sheet = page.getByRole("dialog", { name: "Import win and loss" });
  const choose = sheet.getByTestId("import-choose");
  await expect(choose).toBeVisible();
  await expect(choose).toHaveText("Choose a CSV file");
  await expect(sheet.getByTestId("import-file-name")).toHaveText("No file chosen yet");
  const csv = ["result,account,decided_on,reason", "won,Example Shop,2026-09-03,value"].join("\n");
  await sheet.getByLabel("CSV file").setInputFiles({ name: "deals.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(sheet.getByTestId("import-file-name")).toHaveText("deals.csv");
  await expect(choose).toHaveText("Choose another file");
  await expect(sheet.getByTestId("import-create")).toContainText("1 row to create");
});

test("qa4-company-34: Add win or loss marks its required fields and gives a clear Account example", async ({ page }) => {
  await scenario(page, "pricing");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=win-loss");
  await expect(page.getByTestId("deals-table")).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add win or loss" });
  await expect(add.getByLabel("Account")).toHaveAttribute("placeholder", "e.g. Acme Ltd");
  await expect(add.getByText("(required)", { exact: true })).toHaveCount(3);
  for (const name of ["Account", "Decided on", "Main reason"]) {
    await expect(add.locator("label").filter({ hasText: name }).getByText("(required)", { exact: true })).toHaveCount(1);
  }
});

test("qa4-company-35: Add alternative marks Name required and asks for a Kind", async ({ page }) => {
  await openAlternatives(page);
  const dialog = await openAddAlternative(page);
  await expect(dialog.locator("label").filter({ hasText: "Name" }).first().getByText("(required)", { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel("Kind")).toHaveValue("");
  await dialog.getByLabel("Name").fill("Weekly email habit");
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog).toContainText("Pick a kind");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Kind").selectOption({ label: "Status quo" });
  await dialog.getByRole("button", { name: "Add alternative" }).click();
  await expect(dialog).toBeHidden();
  await expect(alternativeRow(page, "Weekly email habit")).toContainText("Status quo");
});

test("qa4-company-36: Positioning's header has no Add alternative; the Change log's still has", async ({ page }) => {
  await scenario(page, "market");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=positioning");
  await expect(field(page, "alternatives")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add alternative", exact: true }).filter({ visible: true })).toHaveCount(0);
  await subTab(page, "Change log").click();
  await expect(page.getByTestId("change-row").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add alternative", exact: true }).filter({ visible: true })).toHaveCount(1);
});

test("qa4-company-37: editing a Positioning card leaves its neighbour's height alone", async ({ page }) => {
  await scenario(page, "market");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=positioning");
  const neighbour = field(page, "value_and_proof");
  const edited = field(page, "best_fit_customers");
  await expect(neighbour).toBeVisible();
  const before = (await neighbour.boundingBox())!.height;
  await edited.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(edited.getByRole("button", { name: "Save" })).toBeVisible();
  const editedHeight = (await edited.boundingBox())!.height;
  expect(editedHeight).toBeGreaterThan(before + 40);
  const after = (await neighbour.boundingBox())!.height;
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

test("qa4-company-37: editing Competitive alternatives offers the listed alternatives as a start", async ({ page }) => {
  await scenario(page, "market");
  await login(page, APPROVER);
  await page.goto("/company/market?tab=positioning");
  const card = field(page, "alternatives");
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  const offer = card.getByTestId("listed-alternatives");
  await expect(offer).toContainText("Competitor A");
  await expect(offer).toContainText("Spreadsheets");
  await offer.getByRole("button", { name: "Add them" }).click();
  await expect(card.getByLabel("Competitive alternatives, one per line")).toHaveValue(
    "Shared spreadsheets and a weekly meeting\nCompetitor A\nCompetitor B\nSpreadsheets",
  );
  await expect(card.getByTestId("listed-alternatives")).toHaveCount(0);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByTestId("positioning-item").filter({ hasText: "Competitor B" })).toHaveCount(1);
});

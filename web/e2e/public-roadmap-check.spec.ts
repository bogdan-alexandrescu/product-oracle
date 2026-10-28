import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5 lane 5, the Public check (spec-O5 §2, acceptance 18; owner answers O5-Q1, Q5, Q7): an
 * owner reviews every item's public text with its leak findings beside the exact page a
 * link holder sees, approves them, marks the version checked and shares it as Public, with
 * a passcode. The "sharing" scenario's roadmap has five items: two approved texts, one draft,
 * one excluded and one that serves no confirmed goal; its internal titles are marker strings.
 */

const DOC = "/documents/example-labs-roadmap";
// Internal words that must never reach the Public page.
const MARKERS = ["Platform roadmap, autumn", "Falcon alerts rework", "Billing ledger v2", "Northwind", "Dependencies and owners", "ENG-512", "Admin", "Partner API beta"];

async function sharing(page: Page, email?: string) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page, email);
}

test("check the Public version, then share it with a passcode", async ({ page }) => {
  await sharing(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption("public");
  await expect(sheet.getByTestId("public-check-state")).toHaveText("Not checked yet");
  await expect(sheet.getByRole("button", { name: "Create link" })).toBeDisabled();
  await sheet.getByRole("link", { name: "Check public version" }).click();

  await expect(page).toHaveURL(/\/documents\/example-labs-roadmap\/public$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Public version");
  const summary = page.getByTestId("public-summary");
  await expect(summary).toContainText("2 items on the public page · 3 left out");
  await expect(summary).toContainText("1 without an approved public text");
  await expect(summary).toContainText("1 excluded");
  await expect(summary).toContainText("1 not tied to a confirmed company goal");
  const removed = page.getByRole("region", { name: "What is removed" });
  await expect(removed).toContainText("owners");
  await expect(removed).toContainText("tracker links");

  const preview = page.frameLocator('iframe[title="Public page preview"]');
  await expect(preview.getByRole("heading", { name: "Example Co roadmap" })).toBeVisible();
  await expect(preview.getByText("This roadmap shows our current plans. It is not a commitment, and plans and timing can change.")).toBeVisible();

  // The draft names a seeded customer: the blocking finding stops its approval.
  const rows = page.getByTestId("public-row");
  await expect(rows).toHaveCount(5);
  await page.getByRole("radio", { name: /To approve/ }).click();
  await expect(rows).toHaveCount(1);
  const row = rows.filter({ hasText: "Northwind bulk import" });
  await expect(row.getByTestId("public-state")).toHaveText("Draft");
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Public title").fill("Bulk import for Northwind");
  await row.getByLabel("Public description").fill("Bring in many records at once from a spreadsheet.");
  await row.getByLabel("Stage").selectOption("planned");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByRole("alert")).toContainText("Customer name: Northwind");
  await expect(row.getByTestId("public-state")).toHaveText("Draft");

  await row.getByLabel("Public title").fill("Bulk import");
  await row.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("radio", { name: /All/ }).click();
  await expect(rows.filter({ hasText: "Northwind bulk import" }).getByTestId("public-state")).toHaveText("Approved");
  await expect(summary).toContainText("3 items on the public page · 2 left out");
  await expect(preview.getByText("Bulk import", { exact: true })).toBeVisible();
  await expect(preview.getByText("Planned", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("public-check")).toContainText("Checked by Admin");

  // Back on the document: the Public link needs the owner and the check, both there now.
  await page.getByRole("link", { name: "Back to the roadmap" }).click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await sheet.getByLabel("Audience").selectOption("public");
  await expect(sheet.getByTestId("public-check-state")).toHaveText(/Checked/);
  await sheet.getByLabel("Label").fill("Customers, autumn");
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("share-links").getByRole("row").filter({ hasText: "Customers, autumn" })).toContainText("Public");

  await page.goto(new URL(url).pathname);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  const shared = page.frameLocator('iframe[title="Shared roadmap"]');
  await expect(shared.getByRole("heading", { name: "Example Co roadmap" })).toBeVisible();
  for (const stage of ["Shipped recently", "In progress", "Planned", "Exploring"]) {
    await expect(shared.getByRole("heading", { name: stage })).toBeVisible();
  }
  await expect(shared.getByText("This roadmap shows our current plans.", { exact: false })).toBeVisible();
  await expect(shared.getByText(/Shared .* · expires /)).toBeVisible();
  const text = await shared.locator("body").innerText();
  for (const marker of MARKERS) expect(text).not.toContain(marker);
});

test("a text changed after the check lapses it", async ({ page }) => {
  await sharing(page);
  await page.goto(`${DOC}/public`);
  const rows = page.getByTestId("public-row");
  const draft = rows.filter({ hasText: "Northwind bulk import" });
  await draft.getByRole("button", { name: "Exclude" }).click();
  await expect(draft.getByTestId("public-state")).toHaveText("Excluded");
  await page.getByRole("button", { name: "Mark as checked" }).click();
  await expect(page.getByTestId("public-check")).toContainText("Checked by Admin");
  const approved = rows.filter({ hasText: "Falcon alerts rework" });
  await approved.getByRole("button", { name: "Edit" }).click();
  await approved.getByLabel("Public description").fill("A notice before you reach any plan limit.");
  await approved.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("public-check")).toContainText("Changed since checked");
});

test("a percentage is a warning: approve once it is ticked", async ({ page }) => {
  await sharing(page);
  await page.goto(`${DOC}/public`);
  const row = page.getByTestId("public-row").filter({ hasText: "Northwind bulk import" });
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Public title").fill("Faster import");
  await row.getByLabel("Public description").fill("Imports finish 40% sooner.");
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByRole("alert")).toContainText('Tick "I checked this"');
  await row.getByRole("checkbox", { name: /Money or metric/ }).check();
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByTestId("public-state")).toHaveText("Approved");
});

test("approvers check the Public version; commenters cannot open it", async ({ page }) => {
  await sharing(page, "commenter@example.com");
  await page.goto(`${DOC}/public`);
  await expect(page.getByText("Approvers and owners check the Public version.")).toBeVisible();
  await expect(page.getByTestId("public-row")).toHaveCount(0);
});

test("on a phone the check has a Review / Preview switch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await sharing(page);
  await page.goto(`${DOC}/public`);
  const pane = page.getByRole("radiogroup", { name: "Pane" });
  await expect(page.getByTestId("public-row").first()).toBeVisible();
  await expect(page.locator('iframe[title="Public page preview"]')).toBeHidden();
  await pane.getByRole("radio", { name: "Preview" }).click();
  await expect(page.locator('iframe[title="Public page preview"]')).toBeVisible();
  await expect(page.getByTestId("public-row").first()).toBeHidden();
});

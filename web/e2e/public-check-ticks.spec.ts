import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * O5, the Public check's "I checked this" ticks (owner decision BGD, 2026-10-26): an item
 * text's warnings (a decision's title, an approvers-only document, a plan or price, an
 * internal note's words, and the spec's money, date and title-copy warnings) each show what
 * was found and where, with one tick per warning kind; Approve waits for every tick and a
 * tick holds across reloads until the text changes. The page's own title and intro have no
 * tick: those kinds block there.
 */

const PUBLIC = "/documents/example-labs-roadmap/public";
// A decision the mock's decision log holds (web/lib/api/mock/shares.ts DECISION_TITLES).
const DECISION = "Retire the legacy exporter";

async function asApprover(page: Page, email = "approver@example.com") {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page, email);
  await page.goto(PUBLIC);
}

/** Saves the draft item's text with two warnings: a decision's title and a percentage. */
async function draftWithTwoWarnings(page: Page) {
  const row = page.getByTestId("public-row").filter({ hasText: "Northwind bulk import" });
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Public title").fill("Faster import");
  await row.getByLabel("Public description").fill(`Imports finish 40% sooner, as we chose to ${DECISION.toLowerCase()}.`);
  await row.getByRole("button", { name: "Save draft" }).click();
  await expect(row.getByTestId("public-state")).toHaveText("Draft");
  await row.getByRole("button", { name: "Edit" }).click();
  return row;
}

test("an approver ticks both warnings of a text and approves it", async ({ page }) => {
  await asApprover(page);
  const row = await draftWithTwoWarnings(page);

  const warnings = row.getByRole("group", { name: "Warnings to check" });
  await expect(warnings.getByTestId("public-warning")).toHaveCount(2);
  await expect(warnings).toContainText(`Decision: “${DECISION.toLowerCase()}” in the public description`);
  await expect(warnings).toContainText("Money or metric: “40%” in the public description");
  const approve = row.getByRole("button", { name: "Approve" });
  await expect(approve).toBeDisabled();
  await expect(row.getByTestId("public-approve-why")).toHaveText('Tick "I checked this" for each warning to approve this text.');

  await warnings.getByRole("checkbox", { name: /Decision.*I checked this/ }).check();
  await expect(approve).toBeDisabled();
  await warnings.getByRole("checkbox", { name: /Money or metric.*I checked this/ }).check();
  await expect(row.getByTestId("public-approve-why")).toHaveCount(0);
  await approve.click();
  await expect(row.getByTestId("public-state")).toHaveText("Approved");

  // The ticks hold across a reload, until the text changes.
  await page.reload();
  const again = page.getByTestId("public-row").filter({ hasText: "Northwind bulk import" });
  await again.getByRole("button", { name: "Edit" }).click();
  const ticks = again.getByRole("group", { name: "Warnings to check" }).getByRole("checkbox");
  await expect(ticks).toHaveCount(2);
  for (const tick of await ticks.all()) await expect(tick).toBeChecked();
  await again.getByLabel("Public description").fill(`Imports finish 50% sooner, as we chose to ${DECISION.toLowerCase()}.`);
  for (const tick of await ticks.all()) await expect(tick).not.toBeChecked();
});

test("approving with one warning unticked is refused with the sentence", async ({ page }) => {
  await asApprover(page);
  const row = await draftWithTwoWarnings(page);
  const warnings = row.getByRole("group", { name: "Warnings to check" });
  await warnings.getByRole("checkbox", { name: /Money or metric.*I checked this/ }).check();
  await row.getByRole("button", { name: "Save draft" }).click();
  await expect(row.getByTestId("public-state")).toHaveText("Draft");

  // The row's own Approve sends the saved ticks; the API refuses the unticked decision.
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(row.getByRole("alert")).toHaveText('Tick "I checked this" for each warning first');
  await expect(row.getByRole("checkbox", { name: /Money or metric.*I checked this/ })).toBeChecked();
  await expect(row.getByRole("checkbox", { name: /Decision.*I checked this/ })).not.toBeChecked();
  await expect(row.getByTestId("public-state")).toHaveText("Draft");
});

test("an intro with a blocking finding cannot be saved and shows why", async ({ page }) => {
  await asApprover(page);
  const panel = page.getByRole("region", { name: "Page title and intro" });
  await panel.getByLabel("Intro").fill(`This autumn we ${DECISION.toLowerCase()}.`);
  await panel.getByRole("button", { name: "Save" }).click();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("The public title or intro names something a public reader may not see");
  await expect(alert).toContainText(`Decision: “${DECISION.toLowerCase()}” in the intro`);
  await expect(panel.getByRole("checkbox")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("region", { name: "Page title and intro" }).getByLabel("Intro")).toHaveValue("");
});

test("a commenter sees no ticks", async ({ page }) => {
  await asApprover(page, "commenter@example.com");
  await expect(page.getByText("Approvers and owners check the Public version.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /I checked this/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Page title and intro" })).toHaveCount(0);
});

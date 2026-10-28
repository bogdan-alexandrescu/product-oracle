import { expect, test, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/**
 * #482 lane B: the ⋮ menu (Edit, Regenerate…, Delete…) by role, the delete dialog with what
 * goes along and the published warning, the toast with Undo, Settings › Trash with Restore,
 * and the regenerate dialog with its inputs, estimate and note.
 */

type Role = "viewer" | "commenter" | "approver";

async function asRole(page: Page, role: Role) {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

/** usage-alerts (approved, so published) has a derived roadmap and a tech brief. */
async function withFamily(page: Page) {
  await page.addInitScript(([key]) => localStorage.setItem(key, "trash-family"), [MOCK_SCENARIO_KEY] as const);
}

const PRD = "Usage alerts PRD";
const ROADMAP = "Usage alerts roadmap";
const BRIEF = "Early shipping cost: technical brief";

const prdRow = (page: Page, title: string) => page.getByTestId("document-row").filter({ hasText: title });

async function openPrds(page: Page) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-table")).toBeVisible();
}

/** Deletes usage-alerts from its row on PRDs: the dialog lists what goes with it and asks once more. */
async function deleteFamily(page: Page) {
  await openPrds(page);
  await prdRow(page, PRD).getByRole("button", { name: `Actions for ${PRD}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${PRD}` });
  const goes = dialog.getByTestId("delete-dependents");
  await expect(goes).toContainText(ROADMAP);
  await expect(goes).toContainText(BRIEF);
  // Published: the external copy stays, and the delete waits for a second yes.
  await expect(dialog.getByTestId("published-warning")).toContainText("external copy");
  const confirm = dialog.getByRole("button", { name: "Move to Trash" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Delete it here; the external copy stays where it is").check();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
}

async function expectFamilyGone(page: Page) {
  await expect(prdRow(page, PRD)).toHaveCount(0);
  await page.goto("/plan/documents");
  await expect(page.getByTestId("roadmaps-table")).toBeVisible();
  await expect(page.getByTestId("roadmap-row").filter({ hasText: ROADMAP })).toHaveCount(0);
  await expect(page.getByTestId("approved-prd").filter({ hasText: PRD })).toHaveCount(0);
  await page.goto("/documents/checkout-redesign-early-shipping-cost-spec");
  await expect(page.getByText(/not found/i).first()).toBeVisible();
}

async function expectFamilyBack(page: Page) {
  await openPrds(page);
  await expect(prdRow(page, PRD)).toBeVisible();
  await page.goto("/plan/documents");
  await expect(page.getByTestId("roadmap-row").filter({ hasText: ROADMAP })).toBeVisible();
  await page.goto("/documents/checkout-redesign-early-shipping-cost-spec");
  await expect(page.getByRole("heading", { level: 1, name: BRIEF })).toBeVisible();
}

async function deleteAndRestore(page: Page) {
  await withFamily(page);
  await login(page);
  await deleteFamily(page);
  await expect(page.getByRole("status").filter({ hasText: "Moved to Trash" })).toContainText(PRD);
  await expectFamilyGone(page);

  // Settings › Trash: one entry for the three, with its days left.
  await page.goto("/settings");
  await page.getByTestId("nav-trash").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/settings\/trash$/);
  const entries = page.getByTestId("trash-entry");
  await expect(entries).toHaveCount(1);
  const entry = entries.first();
  await expect(entry).toContainText(PRD);
  await expect(entry).toContainText(ROADMAP);
  await expect(entry).toContainText(BRIEF);
  await expect(entry).toContainText("30 days left");
  await entry.getByRole("button", { name: `Restore ${PRD}` }).click();
  await expect(entries).toHaveCount(0);
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await expectFamilyBack(page);
}

test("the delete dialog lists a PRD's tech brief made through its spec request", async ({ page }) => {
  // trash-family: the brief's versions name no source; only its spec request links it to the PRD.
  await withFamily(page);
  await login(page);
  await openPrds(page);
  await prdRow(page, PRD).getByRole("button", { name: `Actions for ${PRD}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${PRD}` });
  await expect(dialog.getByTestId("delete-dependents")).toContainText(BRIEF);
});

test("an owner deletes a PRD with its roadmap and brief, then restores them together from Settings › Trash", async ({ page }) => {
  await deleteAndRestore(page);
});

test("Undo on the toast right after a delete brings everything back", async ({ page }) => {
  await withFamily(page);
  await login(page);
  await deleteFamily(page);
  const toast = page.getByRole("status").filter({ hasText: "Moved to Trash" });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Restored" })).toBeVisible();
  await expect(prdRow(page, PRD)).toBeVisible();
  await page.goto("/settings/trash");
  await expect(page.getByText("Trash is empty")).toBeVisible();
});

test("an owner deletes from the document page and lands back on the list", async ({ page }) => {
  await login(page);
  await page.goto("/documents/visit-reminders");
  await page.getByRole("button", { name: "Actions for Visit reminders" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Visit reminders" });
  await expect(dialog.getByTestId("delete-dependents")).toContainText("Nothing else goes with it");
  await expect(dialog.getByTestId("published-warning")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(prdRow(page, "Visit reminders")).toHaveCount(0);
});

test("an owner deletes a brief from its page, then restores it from Settings › Trash", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "before-drafting"), [MOCK_SCENARIO_KEY] as const);
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await page.getByRole("button", { name: `Actions for ${BEFORE_DRAFTING.title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: `Delete ${BEFORE_DRAFTING.title}` }).getByRole("button", { name: "Move to Trash" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: BEFORE_DRAFTING.title });
  await expect(entry).toContainText("Brief");
  await entry.getByRole("button", { name: `Restore ${BEFORE_DRAFTING.title}` }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
});

test("an owner deletes a run from its page and restores it", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  const row = page.getByTestId("run-row").filter({ hasText: "Succeeded" }).first();
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const url = page.url();
  const menu = page.getByRole("button", { name: /^Actions for / });
  const title = (await menu.getAttribute("aria-label"))!.replace("Actions for ", "");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("dialog", { name: `Delete ${title}` }).getByRole("button", { name: "Move to Trash" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.goto("/settings/trash");
  await expect(page.getByTestId("trash-entry")).toHaveCount(1);
  await expect(page.getByTestId("trash-entry")).toContainText("Run");

  await page.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText("Trash is empty")).toBeVisible();
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
});

test("an approver sees no ⋮ menu on a run or a brief", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto("/runs");
  await page.getByTestId("run-row").first().getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
});

test("an owner sees Open v1, Regenerate… and Delete…", async ({ page }) => {
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap");
  await page.getByRole("button", { name: `Actions for ${ROADMAP}` }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${ROADMAP}` });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open v1", "Regenerate…", "Delete…"]);
});

test("an approver sees Regenerate and Open v1 but no Delete, and no Trash", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await openPrds(page);
  await prdRow(page, PRD).getByRole("button", { name: `Actions for ${PRD}` }).click();
  await expect(page.getByRole("menu", { name: `Actions for ${PRD}` }).getByRole("menuitem")).toHaveText([/^Open v\d+$/, "Regenerate…"]);
  await page.keyboard.press("Escape");

  await page.goto("/documents/usage-alerts-roadmap");
  await page.getByRole("button", { name: `Actions for ${ROADMAP}` }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${ROADMAP}` });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open v1", "Regenerate…"]);
  // Open v1 opens the latest version, where the section editors are.
  await menu.getByRole("menuitem", { name: "Open v1" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap\/v\/1/);

  await page.goto("/settings/members");
  await expect(page.getByTestId("settings-nav")).toBeVisible();
  await expect(page.getByTestId("nav-trash")).toHaveCount(0);
});

for (const role of ["commenter", "viewer"] as const) {
  test(`a ${role} sees no ⋮ menu on artifacts`, async ({ page }) => {
    await asRole(page, role);
    await login(page);
    await openPrds(page);
    await expect(prdRow(page, PRD)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
    await page.goto("/documents/usage-alerts-roadmap");
    await expect(page.getByRole("heading", { level: 1, name: ROADMAP })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
    // The version view (its sections keep their own menus).
    await page.goto("/documents/usage-alerts-roadmap/v/1");
    await expect(page.getByTestId("document-sections").filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${ROADMAP}` })).toHaveCount(0);
  });
}

test("regenerate a roadmap: inputs, estimate and a note, then the result is the next version", async ({ page }) => {
  await asRole(page, "approver");
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap");
  await expect(page.getByTestId("versions-table").getByRole("link", { name: "Version 1" })).toBeVisible();
  await expect(page.getByTestId("versions-table").getByRole("link", { name: "Version 2" })).toHaveCount(0);
  await page.getByRole("button", { name: `Actions for ${ROADMAP}` }).click();
  await page.getByRole("menuitem", { name: "Regenerate…" }).click();
  const dialog = page.getByRole("dialog", { name: `Regenerate ${ROADMAP}` });
  const start = dialog.getByRole("button", { name: "Start run" });
  await expect(start).toBeDisabled();
  await dialog.getByLabel("Note to the agents (optional)").fill("Keep the alert thresholds in Now.");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  const inputs = dialog.getByTestId("regenerate-inputs");
  await expect(inputs).toContainText("Usage alerts roadmap (usage-alerts-roadmap), its latest version");
  await expect(inputs).toContainText("Usage alerts PRD (usage-alerts), its latest approved version");
  await expect(dialog.getByTestId("regenerate-estimate")).toHaveText("$6.00");
  // A changed note makes the estimate stale.
  await dialog.getByLabel("Note to the agents (optional)").fill("Keep the alert thresholds in Now. Add the digest.");
  await expect(start).toBeDisabled();
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await start.click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await page.goto("/documents/usage-alerts-roadmap");
  const versions = page.getByTestId("versions-table");
  await expect(versions.getByRole("link", { name: "Version 2" })).toBeVisible();
  await expect(versions.getByRole("link", { name: "Version 1" })).toBeVisible();
});

test.describe("phone, dark", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });

  test("delete, Trash and Restore at 390 px", async ({ page }) => {
    await deleteAndRestore(page);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });

  test("the regenerate dialog fits at 390 px", async ({ page }) => {
    await asRole(page, "approver");
    await login(page);
    await page.goto("/documents/usage-alerts-roadmap");
    await page.getByRole("button", { name: `Actions for ${ROADMAP}` }).click();
    await page.getByRole("menuitem", { name: "Regenerate…" }).click();
    const dialog = page.getByRole("dialog", { name: `Regenerate ${ROADMAP}` });
    await dialog.getByRole("button", { name: "Estimate" }).click();
    await expect(dialog.getByTestId("regenerate-estimate")).toHaveText("$6.00");
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

test.describe("light", () => {
  test.use({ colorScheme: "light" });

  test("the delete dialog in the light theme", async ({ page }) => {
    await withFamily(page);
    await login(page);
    await deleteFamily(page);
    await expect(page.getByRole("status").filter({ hasText: "Moved to Trash" })).toBeVisible();
  });
});

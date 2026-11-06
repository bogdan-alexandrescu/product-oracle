import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass F, Settings: a wrong Settings URL keeps the Settings tabs (F-32); Trash deletes
 * for good, empties, names every restored item (F-68) and titles a run as the delete dialog does
 * (F-69); Company's explanations sit behind each card's (i) (F-70); Themes' (i) in plain words
 * (F-74); a new theme's key is made from its name (F-76).
 */

const PHONE = { width: 390, height: 844 };
const PRD = "Usage alerts PRD";

/** Deletes the run-review scenario's Usage alerts PRD from PRDs; returns how the dialog named its run. */
async function deletePrd(page: Page): Promise<string> {
  await page.goto("/documents");
  const row = page.getByTestId("document-row").filter({ hasText: PRD });
  await row.getByRole("button", { name: `Actions for ${PRD}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${PRD}` });
  const run = dialog.getByTestId("delete-run").first();
  await expect(run).toHaveText(/^The run of [A-Z][a-z]{2} \d{1,2} that wrote /);
  const runText = (await run.textContent())!.trim();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
  return runText;
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize(PHONE);
    });

    test("F-32: a wrong Settings URL shows Page not found under the Settings tabs", async ({ page }) => {
      await login(page);
      await page.goto("/settings/bad");
      await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toHaveCount(1);
      await expect(page.getByTestId("not-found-back")).toHaveText("Back to Settings");
      const tabs = page.getByTestId("settings-nav");
      await expect(tabs).toBeVisible();
      if (phone) {
        // A phone's Settings tabs are its page picker.
        await tabs.getByTestId("settings-nav-select").selectOption({ label: "Company" });
      } else {
        await tabs.getByRole("link", { name: "Company", exact: true }).click();
      }
      await expect(page).toHaveURL(/\/settings\/company$/);
    });

    test("F-68, F-69: Trash names a run as the delete dialog did, restores naming every item, deletes for good", async ({ page }) => {
      await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, "run-review"] as const);
      await login(page);
      const runText = await deletePrd(page);

      await page.goto("/settings/trash");
      const entry = page.getByTestId("trash-entry").filter({ hasText: PRD });
      // F-69: one title for the run, here and in the dialog.
      await expect(entry.getByText(runText, { exact: true })).toBeVisible();
      await expect(entry).not.toContainText("Baseline to PRD");

      // F-68: the note names every restored item, never "and 1 more".
      await entry.getByRole("button", { name: `Restore ${PRD}` }).click();
      const note = page.getByRole("status").filter({ hasText: "Restored" });
      await expect(note).toContainText(`Restored ${PRD}`);
      await expect(note).toContainText(runText);
      await expect(note).not.toContainText(/\d+ more/);
      await expect(entry).toHaveCount(0);

      // Delete for good: asks first, then it is gone.
      await deletePrd(page);
      await page.goto("/settings/trash");
      await entry.getByRole("button", { name: `Delete ${PRD} for good` }).click();
      const ask = page.getByRole("dialog");
      await expect(ask).toContainText("This cannot be undone.");
      await ask.getByRole("button", { name: "Delete for good" }).click();
      await expect(entry).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId("trash-entry").filter({ hasText: PRD })).toHaveCount(0);
    });

    test("F-68: Empty Trash deletes every item for good", async ({ page }) => {
      await login(page);
      await page.goto("/documents/visit-reminders");
      await page.getByRole("button", { name: "Actions for Visit reminders" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await page.getByRole("dialog", { name: "Delete Visit reminders" }).getByRole("button", { name: "Move to Trash" }).click();
      await expect(page).toHaveURL(/\/documents$/);
      await page.goto("/settings/trash");
      await expect(page.getByTestId("trash-entry").first()).toBeVisible();
      await page.getByRole("button", { name: "Empty Trash" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Empty Trash" }).click();
      await expect(page.getByTestId("trash-empty")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("trash-empty")).toBeVisible();
      await expect(page.getByRole("button", { name: "Empty Trash" })).toHaveCount(0);
    });

    test("F-70: Company's cards carry no explanation sentences; each sits behind the card's (i)", async ({ page }) => {
      await login(page);
      await page.goto("/settings/company");
      await expect(page.getByTestId("team-capacity-panel")).toBeVisible();
      for (const words of [
        "Save keeps the default horizons.",
        "One team builds every PRD's items, in order.",
        "The company has one roadmap, and every PRD's items go on it.",
        "Exports print no company name until you add one.",
        "PNG, JPEG or WebP, at most 512 KB",
      ]) {
        await expect(page.getByText(words).filter({ visible: true })).toHaveCount(0);
      }
      await expect(page.getByRole("button", { name: "About team capacity" })).toHaveAccessibleDescription(/One team builds every PRD's items, in order\./);
      await expect(page.getByRole("button", { name: "About product roadmap" })).toHaveAccessibleDescription("The company has one roadmap, and every PRD's items go on it.");
      await expect(page.getByTestId("brand-logo-rules")).toHaveAccessibleDescription(/PNG, JPEG or WebP, at most 512 KB/);
      await page.getByRole("button", { name: "About team capacity" }).click();
      await expect(page.getByRole("tooltip").filter({ visible: true })).toContainText("One team builds every PRD's items");
    });

    test("F-70: a viewer reads View only with why behind its (i), not a notice", async ({ page }) => {
      await login(page, "viewer@example.com");
      await page.goto("/settings/company");
      await expect(page.getByTestId("view-only")).toBeVisible();
      await expect(page.getByText("Only owners set horizons and the time zone.").filter({ visible: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "About View only" })).toHaveAccessibleDescription("Only owners set horizons and the time zone.");
    });

    test("F-74, F-76: Themes' (i) in plain words; New theme makes its key from the name", async ({ page }) => {
      await login(page);
      await page.goto("/settings/themes");
      await expect(page.getByRole("button", { name: "About themes" })).toHaveAccessibleDescription(/Text must be easy to read on its background\./);
      await expect(page.getByRole("button", { name: "About themes" })).not.toHaveAccessibleDescription(/WCAG/);
      await page.goto("/settings/themes/new");
      await expect(page.getByLabel("Key")).toHaveCount(0);
      await page.getByLabel("Name").fill("Example brand");
      await expect(page.getByTestId("theme-key")).toHaveText("Key: example-brand");
      await page.getByRole("button", { name: "Create theme" }).click();
      await expect(page).toHaveURL(/\/settings\/themes\/example-brand$/);
    });
  });
}

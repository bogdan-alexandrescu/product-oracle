import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/*
 * Visual QA pass F, Settings: a wrong Settings URL keeps the Settings tabs (F-32); Trash deletes
 * for good, empties, names every restored item (F-68) and titles a run as the delete dialog does
 * (F-69); Company's explanations sit behind each card's (i) (F-70); Themes' (i) in plain words
 * (F-74); a new theme's key is made from its name (F-76).
 */

const PHONE = { width: 390, height: 844 };
const PRD = "Checkout redesign PRD";

/** Deletes Checkout redesign PRD from PRDs; returns how the dialog named its first run. */
async function deletePrd(page: Page): Promise<string> {
  await page.goto("/documents");
  const row = page.getByTestId("document-row").filter({ hasText: PRD });
  await row.getByRole("button", { name: `Actions for ${PRD}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${PRD}` });
  const run = dialog.getByTestId("delete-run").first();
  await expect(run).toHaveText(/^The run of [A-Z][a-z]{2} \d{1,2} that wrote /);
  const runText = (await run.textContent())!.trim();
  // A published PRD asks once more.
  const external = dialog.getByLabel("Delete it here; the external copy stays where it is");
  if (await external.isVisible()) await external.check();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
  // The toast names the PRD and counts what went with it (its spec, brief and run), never lists them.
  await expect(page.getByRole("status").getByText(`Moved to Trash: ${PRD} and 3 items that went with it`, { exact: true })).toBeVisible();
  return runText;
}

/** Deletes a document from PRDs by its title, through its Actions menu. */
async function deleteDoc(page: Page, title: string) {
  await page.goto("/documents");
  await page.getByTestId("document-row").filter({ hasText: title }).getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${title}` });
  const external = dialog.getByLabel("Delete it here; the external copy stays where it is");
  // The dialog reads what goes with it first: then it can go, or asks once more.
  await expect(external.or(dialog.getByRole("button", { name: "Move to Trash", disabled: false }))).toBeVisible();
  if (await external.isVisible()) await external.check();
  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog).toHaveCount(0);
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
      await login(page);
      const runText = await deletePrd(page);

      await page.goto("/settings/trash");
      const entry = page.getByTestId("trash-entry").filter({ hasText: PRD });
      // F-69: one title for the run, here and in the dialog.
      await expect(entry.getByText(runText, { exact: true })).toBeVisible();
      await expect(entry).not.toContainText("Baseline to PRD");

      // The note names the item and counts what went with it, not every one of them.
      await entry.getByRole("button", { name: `Restore ${PRD}` }).click();
      const note = page.getByRole("status").filter({ hasText: "Restored" });
      await expect(note).toContainText(new RegExp(`^Restored ${PRD} and \\d+ items? that went with it`));
      await expect(note).not.toContainText(runText);
      await expect(entry).toHaveCount(0);

      // Delete for good: asks first, then it is gone.
      await deletePrd(page);
      await page.goto("/settings/trash");
      await entry.getByRole("button", { name: `Delete ${PRD} for good` }).click();
      const ask = page.getByRole("alertdialog");
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
      // The toast names the item and counts what went with it.
      await expect(page.getByRole("status").filter({ hasText: "Moved to Trash" })).toContainText(
        /^Moved to Trash: Visit reminders( and \d+ items? that went with it)?/,
      );
      await expect(page).toHaveURL(/\/documents$/);
      await page.goto("/settings/trash");
      await expect(page.getByTestId("trash-entry").first()).toBeVisible();
      await page.getByRole("button", { name: "Empty Trash" }).click();
      // The dialog names what goes, never a count of entries as if it were every item.
      const ask = page.getByRole("alertdialog");
      await expect(ask).toContainText("Everything here goes for good: ");
      await expect(ask).toContainText("Visit reminders");
      await expect(ask).not.toContainText(/\d+ items? goe?s? for good/);
      await ask.getByRole("button", { name: "Empty Trash" }).click();
      await expect(page.getByTestId("trash-empty")).toBeVisible();
      await page.reload();
      await expect(page.getByTestId("trash-empty")).toBeVisible();
      await expect(page.getByRole("button", { name: "Empty Trash" })).toHaveCount(0);
    });

    test("Trash: a row's name stays on one line, its buttons beside or under it", async ({ page }) => {
      await login(page);
      await deletePrd(page);
      await page.goto("/settings/trash");
      const entry = page.getByTestId("trash-entry").filter({ hasText: PRD });
      const name = entry.getByText(PRD, { exact: true });
      await expect(name).toBeVisible();
      const box = (await name.boundingBox())!;
      // One line, at its natural width: never squeezed to a letter per line.
      expect(box.height).toBeLessThan(30);
      const words = await name.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getClientRects().length;
      });
      expect(words).toBe(1);
      const forGood = (await entry.getByRole("button", { name: `Delete ${PRD} for good` }).boundingBox())!;
      if (phone) expect(forGood.y).toBeGreaterThanOrEqual(box.y + box.height);
      expect(forGood.x + forGood.width).toBeLessThanOrEqual((await entry.boundingBox())!.x + (await entry.boundingBox())!.width + 1);
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
      await expect(page.getByRole("textbox", { name: "Key" })).toHaveCount(0);
      await page.getByLabel("Name").fill("Example brand");
      await expect(page.getByTestId("theme-key")).toHaveText("Key: example-brand");
      await page.getByRole("button", { name: "Create theme" }).click();
      await expect(page).toHaveURL(/\/settings\/themes\/example-brand$/);
    });
  });
}

test("F-68: Empty Trash names up to three entries, then counts them", async ({ page }) => {
  await login(page);
  const names = [PRD, "Visit reminders", "Saved carts PRD"];
  for (const title of names) await deleteDoc(page, title);
  await page.goto("/settings/trash");
  await expect(page.getByTestId("trash-entry")).toHaveCount(3);
  await page.getByRole("button", { name: "Empty Trash" }).click();
  let ask = page.getByRole("alertdialog");
  // Three entries: each by its name, "A, B and C", newest first.
  await expect(ask).toContainText(`Everything here goes for good: ${names[2]}, ${names[1]} and ${names[0]}`);
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);

  await deleteDoc(page, "Clinic outreach PRD");
  await page.goto("/settings/trash");
  await expect(page.getByTestId("trash-entry")).toHaveCount(4);
  await page.getByRole("button", { name: "Empty Trash" }).click();
  ask = page.getByRole("alertdialog");
  // More than three: a count of the entries, not a long list.
  await expect(ask).toContainText(/Everything here goes for good: 4 deleted items[,.]/);
  for (const title of [...names, "Clinic outreach PRD"]) await expect(ask).not.toContainText(title);
});

test("Trash: a commenter and a viewer never see Delete for good or Empty Trash", async ({ page }) => {
  // Something is in Trash: an owner's deleted PRD.
  await login(page);
  await deletePrd(page);
  await page.goto("/settings/trash");
  await expect(page.getByRole("button", { name: "Empty Trash" })).toBeVisible();
  for (const email of ["commenter@example.com", "viewer@example.com"]) {
    await signOut(page);
    await login(page, email);
    await page.goto("/settings/trash");
    await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
    // A commenter's Trash holds only what they deleted (nothing); a viewer's is not theirs to open.
    await expect(email.startsWith("commenter") ? page.getByTestId("trash-empty") : page.getByText("Not available for your role")).toBeVisible();
    await expect(page.getByRole("button", { name: /for good$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Empty Trash" })).toHaveCount(0);
  }
});

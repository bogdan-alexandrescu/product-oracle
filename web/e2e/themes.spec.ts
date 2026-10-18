import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("themes: list, live preview, a low-contrast colour blocks saving", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes");
  await expect(page.getByRole("heading", { level: 1, name: "Themes" })).toBeVisible();
  await expect(page.locator('tr[data-testid^="theme-row-"]')).toHaveCount(6);
  await expect(page.getByTestId("theme-row-roadmap-board")).toContainText("Built-in");

  await page.getByRole("link", { name: "Clean document" }).click();
  await expect(page).toHaveURL(/\/settings\/themes\/clean-document$/);
  await expect(page.getByRole("heading", { level: 1, name: "Clean document" })).toBeVisible();

  // The preview renders the sample document with the tokens.
  const preview = page.getByTestId("theme-preview");
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(page.frameLocator('[data-testid="theme-preview"]').getByRole("heading", { name: "Example feature PRD" })).toBeVisible();

  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled(); // nothing changed yet

  // Muted text too light on white: WCAG AA fails, saving is blocked.
  await page.getByLabel("Muted", { exact: true }).fill("#aaaaaa");
  const contrast = page.getByTestId("contrast-errors");
  await expect(contrast).toContainText("colors.muted #aaaaaa on colors.background #ffffff has a contrast of 2.32:1");
  await expect(contrast).toContainText("WCAG AA needs at least 4.5:1");
  await expect(save).toBeDisabled();

  // A darker grey passes; the change saves and shows in the preview.
  await page.getByLabel("Muted", { exact: true }).fill("#4b5563");
  await expect(contrast).toHaveCount(0);
  await page.getByLabel("Base size (pt)").fill("12");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toContainText("Theme saved");
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel("Muted", { exact: true })).toHaveValue("#4b5563");
  await expect(page.getByLabel("Base size (pt)")).toHaveValue("12");
});

test("themes: archive and restore", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes/editorial-memo");
  await expect(page.getByRole("heading", { level: 1, name: "Editorial memo" })).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("status")).toContainText("Archived");

  await page.getByRole("link", { name: "← Themes" }).click();
  await expect(page.getByTestId("theme-row-editorial-memo")).toHaveCount(0);
  await page.getByLabel("Show archived").check();
  await expect(page.getByTestId("theme-row-editorial-memo")).toContainText("Archived");

  await page.getByRole("link", { name: "Editorial memo" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("status")).toContainText("Restored");
  await page.getByRole("link", { name: "← Themes" }).click();
  await page.getByLabel("Show archived").uncheck();
  await expect(page.getByTestId("theme-row-editorial-memo")).not.toContainText("Archived");
});

test("themes: create a new one from a copy", async ({ page }) => {
  await login(page);
  await page.goto("/settings/themes");
  await page.getByRole("link", { name: "New theme" }).click();
  await page.getByLabel("Key").fill("company-brand");
  await page.getByLabel("Name").fill("Company brand");
  await page.getByLabel("Start from").selectOption("technical-spec");
  await page.getByRole("button", { name: "Create theme" }).click();
  await expect(page).toHaveURL(/\/settings\/themes\/company-brand$/);
  await expect(page.getByRole("heading", { level: 1, name: "Company brand" })).toBeVisible();
  await expect(page.getByLabel("Accent", { exact: true })).toHaveValue("#0f5e8c");
});

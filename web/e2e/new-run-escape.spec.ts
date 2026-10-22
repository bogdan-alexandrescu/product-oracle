import { expect, test } from "@playwright/test";

import { login } from "./helpers";

/** #257: Escape in the PRD document field closes its suggestions, not the New run dialog. */
test("new run: Escape closes the document suggestions first, then the dialog", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "New run" });
  await expect(dialog).toBeVisible();

  // Choices that must survive the first Escape.
  await dialog.getByLabel("Depth").selectOption("deep");
  await dialog.getByLabel("Budget").fill("12");

  const field = dialog.getByRole("combobox", { name: "PRD document" });
  await field.fill("team");
  const suggestions = dialog.getByRole("listbox", { name: "Document suggestions" });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole("option", { name: /team-workspaces/ })).toBeVisible();

  await field.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("team");
  await expect(dialog.getByLabel("Depth")).toHaveValue("deep");
  await expect(dialog.getByLabel("Budget")).toHaveValue("12");

  await field.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("new run: picking a document suggestion fills the field", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "New run" });
  const field = dialog.getByRole("combobox", { name: "PRD document" });
  await field.fill("team-work");
  await dialog.getByRole("option", { name: /team-workspaces/ }).click();
  await expect(field).toHaveValue("team-workspaces");
  await expect(dialog.getByRole("listbox", { name: "Document suggestions" })).toHaveCount(0);
});

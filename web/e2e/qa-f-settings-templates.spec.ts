import { expect, test } from "./test";

import { login } from "./helpers";

/**
 * F-75 (Settings › Templates): a template's body showed as raw Markdown — front matter lines
 * ("template: ai-feature", "theme: technical-spec"), section ids ("{#behaviour}") and a status
 * line with bare "theme" / "brief" keys. Sections now show as named rows by default (as New
 * template already did), with the raw Markdown one click away under "Edit as Markdown", and
 * the status line reads in plain words ("Theme: …", "In the brief: …").
 */

test("qa-F-75: a template's sections show as named rows, not raw markup, with Edit as Markdown behind a switch", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/ai-feature");
  await expect(page.getByRole("heading", { level: 1, name: "AI feature PRD" })).toBeVisible();

  // Rows, not raw markup, by default.
  const rows = page.getByTestId("template-sections");
  await expect(rows).toBeVisible();
  await expect(rows).not.toContainText("{#");
  await expect(rows).not.toContainText("template:");
  await expect(page.getByLabel("Template body")).toHaveCount(0);

  // One named row per section, each with its own "Show in the brief" checkbox; the first two
  // (the template's brief: [behaviour, evals]) start checked, the rest do not.
  const sections = page.getByTestId("template-section");
  await expect(sections).toHaveCount(4);
  await expect(page.getByLabel("Section 1 heading")).toHaveValue("Model behaviour");
  await expect(page.getByLabel("Section 2 heading")).toHaveValue("Evals");
  await expect(page.getByLabel("Section 3 heading")).toHaveValue("Fallbacks");
  await expect(page.getByLabel("Section 4 heading")).toHaveValue("Cost");
  const briefBoxes = page.getByRole("checkbox", { name: "Show in the brief" });
  await expect(briefBoxes).toHaveCount(4);
  await expect(briefBoxes.nth(0)).toBeChecked();
  await expect(briefBoxes.nth(1)).toBeChecked();
  await expect(briefBoxes.nth(2)).not.toBeChecked();
  await expect(briefBoxes.nth(3)).not.toBeChecked();

  // The theme is picked by its name, not typed as a key.
  const themeSelect = page.getByLabel("Theme", { exact: true });
  await expect(themeSelect).toHaveValue("technical-spec");
  await expect(themeSelect.locator("option:checked")).toHaveText("Technical spec");

  // The status line reads in plain words: no bare "theme" / "brief" keys.
  const status = page.getByTestId("validation-ok");
  await expect(status).toContainText("Theme:");
  await expect(status).toContainText("In the brief:");
  await expect(status).not.toContainText("· theme ");
  await expect(status).not.toContainText("· brief ");
  await expect(page.getByTestId("check-theme")).toHaveText("Technical spec");
  await expect(page.getByTestId("brief-sections")).toHaveText("Model behaviour, Evals");

  // The raw Markdown sits one click away.
  await page.getByRole("button", { name: "Edit as Markdown" }).click();
  const editor = page.getByLabel("Template body");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/theme: technical-spec/);
  await expect(editor).toHaveValue(/brief: \[behaviour, evals\]/);
  await expect(editor).toHaveValue(/## Model behaviour \{#behaviour\}/);
  await expect(page.getByTestId("template-sections")).toHaveCount(0);

  // And back to rows.
  await page.getByRole("button", { name: "Back to rows" }).click();
  await expect(page.getByTestId("template-sections")).toBeVisible();
  await expect(page.getByLabel("Template body")).toHaveCount(0);
});

test("qa-F-75: New template's rows say 'Show in the brief', with the explanations behind an InfoTip", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/new");
  await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();

  // Rows by default, labelled "Show in the brief" (not the bare "In the brief").
  const sections = page.getByTestId("template-section");
  await expect(sections).toHaveCount(3);
  await expect(page.getByRole("checkbox", { name: "Show in the brief" })).toHaveCount(3);
  await expect(page.getByText("In the brief", { exact: true })).toHaveCount(0);

  // The explanation lines sit behind an InfoTip, not as plain text on the page.
  await expect(page.getByText("Every document from this template has these sections").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText("Its key is made from the name.").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("template-key")).toHaveText("Key: —");
  await expect(page.getByRole("button", { name: "About sections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "About the key" })).toBeVisible();

  // Opening the tip shows the words that used to sit on the page.
  await page.getByRole("button", { name: "About sections" }).click();
  await expect(page.getByText("Every document from this template has these sections")).toBeVisible();
});

test("qa-F-75: editing a section's name as a row and saving a new version persists it", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates/one-pager");
  await expect(page.getByRole("heading", { level: 1, name: "One-pager" })).toBeVisible();

  const heading = page.getByLabel("Section 1 heading");
  await expect(heading).toHaveValue("Problem");
  await heading.fill("Problem statement");

  const save = page.getByRole("button", { name: "Save as new version" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toContainText("Saved as version 2");
  await expect(page.getByTestId("latest-version")).toHaveText("v2");

  // The section id is kept (only its name changed); the new version's row and its stored body
  // both show the new name.
  await expect(page.getByTestId("version-body")).toContainText("## Problem statement {#problem}");
  await expect(page.getByLabel("Section 1 heading")).toHaveValue("Problem statement");
});

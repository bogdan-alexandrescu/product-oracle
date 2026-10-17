import { expect, test } from "@playwright/test";

import { login } from "./helpers";

test("templates: listed by kind, with built-in badges and an archived toggle", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates");
  await expect(page.getByRole("heading", { level: 1, name: "Templates" })).toBeVisible();
  const prd = page.getByTestId("templates-prd");
  const roadmap = page.getByTestId("templates-roadmap");
  await expect(prd.locator('tr[data-testid^="template-row-"]')).toHaveCount(7);
  await expect(roadmap.locator('tr[data-testid^="template-row-"]')).toHaveCount(5);
  await expect(prd.getByTestId("template-row-one-pager")).toContainText("Built-in");
  await expect(roadmap.getByTestId("template-row-outcome-roadmap")).toBeVisible();
  await expect(page.getByLabel("Show archived")).not.toBeChecked();
});

test("templates: view a version, live validation, save a new version, archive and restore", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates");
  await page.getByRole("link", { name: "One-pager" }).click();
  await expect(page).toHaveURL(/\/settings\/templates\/one-pager$/);
  await expect(page.getByRole("heading", { level: 1, name: "One-pager" })).toBeVisible();
  await expect(page.getByTestId("latest-version")).toHaveText("v1");
  await expect(page.getByTestId("version-body")).toContainText("## Problem {#problem}");
  await expect(page.getByTestId("validation-ok")).toBeVisible();

  // A bad body: a heading without an id and no sources section.
  const editor = page.getByLabel("Template body");
  await editor.fill("# Idea {#title}\n\n## Problem\n\nText [c:c1]\n");
  const problems = page.getByTestId("problems");
  await expect(problems).toContainText("Line 3: heading 'Problem' (level 2) must end with {#section-id}");
  await expect(problems).toContainText("Sources and data points");
  await expect(problems).toContainText("Line 5: citation [c:c1]");
  const save = page.getByRole("button", { name: "Save as new version" });
  await expect(save).toBeDisabled();

  // Fix it and save: a new immutable version.
  const body = "# Idea {#title}\n\n## Problem {#problem}\n\n## Risks {#risks}\n\n## Sources and data points {#sources}\n";
  await editor.fill(body);
  await expect(page.getByTestId("validation-ok")).toContainText("title, problem, risks, sources");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("status")).toContainText("Saved as version 2");
  await expect(page.getByTestId("latest-version")).toHaveText("v2");
  await expect(page.getByTestId("version-body")).toContainText("## Risks {#risks}");

  // The first version stays readable.
  const versions = page.getByLabel("Version", { exact: true });
  await expect(versions.locator("option")).toHaveCount(2);
  await versions.selectOption("1");
  await expect(page.getByTestId("version-body")).toContainText("## Who it is for {#audience}");
  await expect(page.getByTestId("version-body")).not.toContainText("{#risks}");

  // Archive: gone from the list until "Show archived"; then restore.
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("status")).toContainText("Archived");
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await page.getByRole("link", { name: "← Templates" }).click();
  await expect(page.getByTestId("template-row-one-pager")).toHaveCount(0);
  await page.getByLabel("Show archived").check();
  await expect(page.getByTestId("template-row-one-pager")).toContainText("Archived");
  await page.getByRole("link", { name: "One-pager" }).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("status")).toContainText("Restored");
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
});

test("templates: create a new one from the skeleton", async ({ page }) => {
  await login(page);
  await page.goto("/settings/templates");
  await page.getByRole("link", { name: "New template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();
  await page.getByLabel("Key").fill("launch-brief");
  await page.getByLabel("Name").fill("Launch brief");
  await expect(page.getByTestId("validation-ok")).toContainText("title, problem, solution, sources");
  await page.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/settings\/templates\/launch-brief$/);
  await expect(page.getByRole("heading", { level: 1, name: "Launch brief" })).toBeVisible();
  await page.getByRole("link", { name: "← Templates" }).click();
  await expect(page.getByTestId("templates-prd").getByTestId("template-row-launch-brief")).not.toContainText("Built-in");
});

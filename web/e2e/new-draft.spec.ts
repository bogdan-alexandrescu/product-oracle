import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

function answer(page: Page, question: string, option: string) {
  return page.getByRole("group", { name: question }).getByText(option, { exact: true }).click();
}

test("new PRD: answers give a recommendation; override template and theme; start from an empty skeleton", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();

  // No answers: the goal-traced default.
  await expect(page.getByTestId("recommended-template")).toHaveText("Goal-traced PRD");

  await answer(page, "What should this document decide?", "Whether to start at all");
  await expect(page.getByTestId("recommended-template")).toHaveText("One-pager");
  await expect(page.getByTestId("recommendation-reason")).toContainText("go / no-go");
  const templates = page.getByRole("radiogroup", { name: "Template" });
  await expect(templates.getByRole("radio", { name: /One-pager/ })).toBeChecked();
  await expect(page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "One-page brief" })).toBeChecked();

  await answer(page, "Does its output come from a model or agent?", "Yes");
  await answer(page, "What should this document decide?", "Commit to building it");
  await expect(page.getByTestId("recommended-template")).toHaveText("AI feature PRD");

  // Override the template and the theme.
  await page.getByTestId("template-option-prd-rfc").click();
  await expect(templates.getByRole("radio", { name: /Product spec \+ RFC/ })).toBeChecked();
  const themes = page.getByRole("radiogroup", { name: "Theme" });
  await expect(themes.getByTestId("theme-option-clean-document").locator("iframe")).toBeAttached();
  await page.getByTestId("theme-option-editorial-memo").click();
  await expect(themes.getByRole("radio", { name: "Editorial memo" })).toBeChecked();

  await page.getByRole("textbox", { name: "Title" }).fill("Address lookup PRD");
  // C4: the empty skeleton (POST /v1/drafts) moved under a quiet link of the New PRD door.
  await page.getByRole("button", { name: "Start from an empty skeleton instead" }).click();
  await expect(page).toHaveURL(/\/documents\/address-lookup-prd$/);
  await expect(page.getByRole("heading", { level: 1, name: "Address lookup PRD" })).toBeVisible();
  await expect(page.getByText("template prd-rfc v1")).toBeVisible();
  await page.getByRole("link", { name: "Open latest (v1)" }).click();
  await expect(page).toHaveURL(/\/documents\/address-lookup-prd\/v\/1$/);

  // The last choice is preselected next time.
  await page.goto("/documents/new?kind=prd");
  await expect(page.getByRole("radiogroup", { name: "Template" }).getByRole("radio", { name: /Product spec \+ RFC/ })).toBeChecked();
  await expect(page.getByText("Your last choice")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Editorial memo" })).toBeChecked();
});

test("new roadmap: a board audience gets the outcome roadmap; company default", async ({ page }) => {
  await login(page);
  await page.getByTestId("nav-plan").click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByRole("link", { name: "New roadmap" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New roadmap" })).toBeVisible();
  await expect(page.getByTestId("recommended-template")).toHaveText("Now / Next / Later");
  await expect(page.getByRole("spinbutton", { name: /Confirmed goals/ })).toHaveValue("2");

  await answer(page, "Who reads it first?", "Board or investors");
  await expect(page.getByTestId("recommended-template")).toHaveText("Outcome roadmap");
  await expect(page.getByTestId("recommendation-reason")).toContainText("are we working on the right things?");
  await expect(page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Roadmap board" })).toBeChecked();

  // Fewer confirmed goals than the outcome roadmap needs: a warning.
  await page.getByRole("spinbutton", { name: /Confirmed goals/ }).fill("1");
  await expect(page.getByTestId("recommendation-warnings")).toContainText("Only 1 confirmed goal(s)");

  // The owner makes it the company default; it shows on the next visit.
  await page.getByRole("button", { name: "Make company default" }).click();
  await expect(page.getByRole("status")).toContainText("Company default for new roadmaps saved");
  await page.reload();
  await expect(page.getByTestId("company-default")).toContainText("Outcome roadmap");
  // With no answers, the company default is the recommendation.
  await expect(page.getByTestId("recommended-template")).toHaveText("Outcome roadmap");
  await expect(page.getByTestId("recommendation-reason")).toContainText("company's default");

  await page.getByRole("textbox", { name: "Title" }).fill("Board roadmap");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/documents\/board-roadmap$/);
  await expect(page.getByText("template outcome-roadmap v1")).toBeVisible();
});

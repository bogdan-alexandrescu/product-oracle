import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * #255: a PRD whose latest version is only its template's skeleton offers Draft with Oracle
 * as its main action, and Publish waits as a secondary button until there is content.
 * Driven through the UI of the mock build: New PRD → empty skeleton → Draft with Oracle → run.
 */

async function newSkeletonPrd(page: Page, title: string) {
  await page.getByTestId("nav-prds").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole("link", { name: "New PRD" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByTestId("template-option-prd-rfc").click();
  await page.getByRole("button", { name: "Start from an empty skeleton instead" }).click();
  await expect(page).toHaveURL(/\/documents\/[a-z0-9-]+$/);
}

const draftButton = (page: Page) => page.getByTestId("draft-with-oracle").filter({ visible: true });

test("a skeleton-only PRD: Draft with Oracle is the main action and starts its draft run", async ({ page }) => {
  await login(page, "approver@example.com");
  await newSkeletonPrd(page, "Saved wishlists");
  await expect(page).toHaveURL(/\/documents\/saved-wishlists$/);

  // The overview Create draft lands on, then the document itself.
  await expect(draftButton(page)).toHaveAttribute("data-variant", "primary");
  const openLatest = page.getByRole("link", { name: "Open latest (v1)" });
  await expect(openLatest).toHaveAttribute("data-variant", "secondary");
  await openLatest.click();
  await expect(page).toHaveURL(/\/documents\/saved-wishlists\/v\/1$/);

  await expect(draftButton(page)).toHaveText("Draft with Oracle");
  await expect(draftButton(page)).toHaveAttribute("data-variant", "primary");
  await expect(page.getByTestId("publish-link")).toHaveAttribute("data-variant", "secondary");

  await draftButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Draft with Oracle" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "PRD document" })).toHaveValue("saved-wishlists");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByRole("button", { name: "Start run" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Start run" }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Saved wishlists/ }).first()).toBeVisible();
  await expect(page.getByText(/^Template: /).first()).toBeVisible();
});

test("a PRD with content keeps Publish as its main action and no Draft with Oracle", async ({ page }) => {
  await page.addInitScript((s) => localStorage.setItem("po-mock-scenario", s), "next-draft");
  await login(page);
  await page.goto("/documents/fleet-next/v/2");
  await expect(page.getByTestId("publish-link").filter({ visible: true })).toHaveAttribute("data-variant", "primary");
  await expect(draftButton(page)).toHaveCount(0);
});

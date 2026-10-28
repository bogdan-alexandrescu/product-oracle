import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 1, docs lane: the Impact page of Saved carts v2, on which nothing is built yet.

async function openImpact(page: Page) {
  await login(page);
  await page.goto("/documents/saved-carts/v/2/impact");
  await expect(page.getByTestId("impact-empty")).toBeVisible();
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`qa-docs-58 (${name}): the empty Impact says what to do, under the same header as Quality`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openImpact(page);
    const empty = page.getByTestId("impact-empty");
    await expect(empty).toContainText("No outputs depend on what v2 changed. Nothing to regenerate.");
    await expect(empty).toContainText("When a roadmap, spec or other output is built from this version");
    // No talk of lines and columns that are not drawn.
    await expect(page.getByText(/middle column|The lines show/)).toHaveCount(0);

    // The header: the PRDs list and the document by name, then "Impact v2", as Quality's.
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true });
    await expect(crumb.getByRole("link", { name: "PRDs" })).toBeVisible();
    await expect(crumb.getByRole("link", { name: "Saved carts PRD" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Impact");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("v2");
    await expect(page.getByText(/^← /)).toHaveCount(0);

    await page.goto("/documents/saved-carts/v/2/quality");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).getByRole("link", { name: "Saved carts PRD" })).toBeVisible();
  });
}

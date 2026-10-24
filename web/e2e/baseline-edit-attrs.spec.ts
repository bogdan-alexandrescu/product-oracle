import { expect, test, type Page } from "./test";

import { login } from "./helpers";

async function openFeature(page: Page, key: string, title: string) {
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByTestId(`feature-${key}`).getByRole("button", { name: title }).click();
  return page.getByRole("dialog", { name: title });
}

test("baseline: editing a feature's milestone saves only it, and shows in its history", async ({ page, context }) => {
  const d = await openFeature(page, "f.saved-carts", "Saved carts");
  await expect(d.locator('[data-attr="milestone"]')).toHaveText("Beta");

  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await expect(form).toContainText("Saving locks this item");
  // Every attribute the entry has is in the form, as text.
  await expect(form.getByLabel("Delivery status")).toHaveValue("planned");
  await expect(form.getByLabel("Effort")).toHaveValue("L");
  await expect(form.getByLabel("milestone")).toHaveValue("Beta");
  await form.getByLabel("milestone").fill("General availability");

  // Meanwhile the same person changes the effort in a second tab.
  const other = await context.newPage();
  await other.goto("/baseline");
  await other.getByTestId("feature-f.saved-carts").getByRole("button", { name: "Saved carts" }).click();
  const od = other.getByRole("dialog", { name: "Saved carts" });
  await od.getByRole("button", { name: "Edit" }).click();
  await od.getByRole("form", { name: "Edit" }).getByLabel("Effort").fill("XL");
  await od.getByRole("form", { name: "Edit" }).getByRole("button", { name: "Save" }).click();
  await expect(od.locator('[data-attr="effort"]')).toHaveText("XL");
  await other.close();

  await form.getByRole("button", { name: "Save" }).click();

  await expect(d.getByRole("status")).toContainText("now locked against agent changes");
  await expect(d.getByTestId("lock-note")).toContainText("Locked by you");
  await expect(d.locator('[data-attr="milestone"]')).toHaveText("General availability");
  // The effort the form left untouched is not written back over the other tab's change.
  await expect(d.locator('[data-attr="effort"]')).toHaveText("XL");

  const history = d.getByTestId("entity-history");
  await expect(history.getByRole("listitem").first()).toContainText("milestone: Beta → General availability");
});

test("baseline: the edit form adds a known attribute the entry lacks", async ({ page }) => {
  const d = await openFeature(page, "f.sample-data", "Sample data");
  await expect(d.locator('[data-attr="size"]')).toHaveCount(0);

  await d.getByRole("button", { name: "Edit" }).click();
  const form = d.getByRole("form", { name: "Edit" });
  await form.getByLabel("Add attribute").selectOption("size");
  await form.getByLabel("size").fill("Small");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(d.locator('[data-attr="size"]')).toHaveText("Small");
  await expect(d.locator('[data-attr="status"]')).toHaveText("Planned");
  const change = d.getByTestId("entity-history").getByRole("listitem").first();
  await expect(change).toContainText("size: Small");
  await expect(change).not.toContainText("status");
});

import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

async function openBaseline(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
}

test("baseline: Add item adds a risk, the Items tab lists it, and Archive takes it off with a reason", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("button", { name: "Add item" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await form.getByLabel("Kind").selectOption("risk");
  // Only a feature asks for its product and goals.
  await expect(form.getByLabel("Product")).toHaveCount(0);
  await form.getByLabel("Title").fill("Card network fees rise next year");
  await form.getByLabel("Description").fill("A made-up risk for the test.");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Added" })).toContainText("Added “Card network fees rise next year”");

  await page.getByRole("tab", { name: /Items/ }).click();
  await page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /Risks/ }).click();
  const list = page.getByRole("grid", { name: "Items" });
  await list.getByRole("button", { name: "Card network fees rise next year" }).click();

  const d = page.getByRole("dialog", { name: "Card network fees rise next year" });
  await expect(d).toContainText("Risk");
  await expect(d.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await d.getByRole("button", { name: "Archive" }).click();
  const ask = d.getByRole("form", { name: "Archive" });
  await ask.getByLabel("Reason").fill("Fees were fixed for three years.");
  await ask.getByRole("button", { name: "Archive" }).click();
  await expect(d.getByRole("status")).toContainText("Archived");
  await expect(d.getByTestId("entity-history").getByRole("listitem").first()).toContainText("Status: confirmed → rejected");
  await expect(list.getByRole("button", { name: "Card network fees rise next year" })).toHaveCount(0);
});

test("baseline: the Features table's Add makes a feature in its product, serving the goals picked", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("region", { name: "Feature × goal", exact: true }).getByRole("button", { name: "Add" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await expect(form.getByLabel("Kind")).toHaveValue("feature");
  await form.getByLabel("Title").fill("Gift cards");
  await form.getByLabel("Product").selectOption({ label: "Storefront" });
  await form.getByLabel("Raise activation").selectOption("3");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toHaveCount(0);

  const row = page.getByTestId("product-p.storefront").getByRole("row").filter({ hasText: "Gift cards" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Gift cards" }).click();
  const d = page.getByRole("dialog", { name: "Gift cards" });
  await expect(d.getByRole("list", { name: "Supports" })).toContainText("Raise activation");
  await expect(d.getByRole("list", { name: "Part of" })).toContainText("Storefront");
});

test("baseline: the Goals table's Add proposes a goal, and the drawer confirms it", async ({ page }) => {
  await openBaseline(page);
  await page.getByRole("region", { name: "Goals", exact: true }).getByRole("button", { name: "Add" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await expect(form.getByLabel("Kind")).toHaveValue("goal");
  await form.getByLabel("Title").fill("Halve support tickets");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added" })).toContainText("goals start proposed");

  await page.getByRole("grid", { name: "Goals" }).getByRole("button", { name: "Halve support tickets" }).click();
  const d = page.getByRole("dialog", { name: "Halve support tickets" });
  await expect(d.getByText("Proposed").first()).toBeVisible();
  await d.getByRole("button", { name: "Confirm" }).click();
  await expect(d.getByRole("status")).toContainText("Confirmed");
  await expect(d.getByRole("button", { name: "Archive" })).toBeVisible();
});

test("baseline: the drawer rejects a proposed feature, with a reason", async ({ page }) => {
  await openBaseline(page);
  await page.getByTestId("feature-f.usage-export").getByRole("button", { name: "Usage export" }).click();
  const d = page.getByRole("dialog", { name: "Usage export" });
  await expect(d.getByRole("button", { name: "Confirm" })).toBeVisible();
  await d.getByRole("button", { name: "Reject" }).click();
  const ask = d.getByRole("form", { name: "Reject" });
  // Back leaves it as it was.
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(d.getByRole("form", { name: "Reject" })).toHaveCount(0);
  await d.getByRole("button", { name: "Reject" }).click();
  await d.getByRole("form", { name: "Reject" }).getByLabel("Reason").fill("Not this year.");
  await d.getByRole("form", { name: "Reject" }).getByRole("button", { name: "Reject" }).click();
  await expect(d.getByRole("status")).toContainText("Rejected");
  await expect(page.getByTestId("feature-f.usage-export")).toHaveCount(0);
});

test("baseline: a viewer sees no Add, Confirm, Reject or Archive (#370: a role that can never act sees no control)", async ({ page }) => {
  await openBaseline(page, "viewer@example.com");
  await expect(page.getByRole("button", { name: "Add item" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Goals", exact: true }).getByRole("button", { name: "Add" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Feature × goal", exact: true }).getByRole("button", { name: "Add" })).toHaveCount(0);

  await page.getByTestId("feature-f.usage-export").getByRole("button", { name: "Usage export" }).click();
  const d = page.getByRole("dialog", { name: "Usage export" });
  await expect(d).toContainText("Proposed");
  await expect(d.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Reject" })).toHaveCount(0);
  await expect(d.getByTestId("decide-note")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);

  await page.getByRole("tab", { name: /Items/ }).click();
  await expect(page.getByRole("region", { name: "Items", exact: true }).getByRole("button", { name: "Add" })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`baseline: a failed link keeps the new feature and Try again makes only the missing links (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openBaseline(page);
    await page.getByRole("region", { name: "Feature × goal", exact: true }).getByRole("button", { name: "Add" }).click();
    const form = page.getByRole("dialog", { name: "Add an item" });
    await form.getByLabel("Title").fill("Loyalty points");
    await form.getByLabel("Product").selectOption({ label: "Storefront" });
    await form.getByLabel("Raise activation").selectOption("2");
    // The first link's request (the product link) fails once, after the feature is made.
    await page.evaluate(() => {
      localStorage.setItem("po-mock-fail-once", "POST /v1/baseline/edges");
      (globalThis as { __poMockCalls?: string[] }).__poMockCalls = [];
    });
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("“Loyalty points” was added");
    await expect(form.getByRole("button", { name: "Try again" })).toBeVisible();
    await form.getByRole("button", { name: "Try again" }).click();
    await expect(form).toHaveCount(0);

    const calls = await page.evaluate(() => (globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []);
    expect(calls.filter((c) => c.startsWith("POST /v1/baseline/entities"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("POST /v1/baseline/edges"))).toHaveLength(3);

    const rows = page.getByTestId("product-p.storefront").getByRole("row").filter({ hasText: "Loyalty points" });
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: "Loyalty points" }).click();
    const d = page.getByRole("dialog", { name: "Loyalty points" });
    await expect(d.getByRole("list", { name: "Supports" })).toContainText("Raise activation");
    await expect(d.getByRole("list", { name: "Part of" })).toContainText("Storefront");
  });
}

test("baseline: on a phone the Add item form fits and adds an assumption", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBaseline(page);
  await page.getByRole("button", { name: "Add item" }).click();
  const form = page.getByRole("dialog", { name: "Add an item" });
  await form.getByLabel("Kind").selectOption("assumption");
  await form.getByLabel("Title").fill("Shops sell mostly on phones");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("tab", { name: /Items/ }).click();
  await expect(page.getByRole("grid", { name: "Items" }).getByRole("button", { name: "Shops sell mostly on phones" })).toBeVisible();
});

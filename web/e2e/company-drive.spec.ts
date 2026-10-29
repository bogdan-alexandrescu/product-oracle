import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/** Connects the mock Google account (OAuth connects at once in mock mode). */
async function connectGoogle(page: Page) {
  await page.goto("/settings/connections");
  await page.getByTestId("connection-card-google").getByRole("button", { name: "Connect with Google Docs" }).click();
  await expect(page).toHaveURL(/connected=google/);
}

test("settings › sources › Google Drive: an owner sets the company's domains and shared drives", async ({ page }) => {
  await login(page);
  await connectGoogle(page);
  await page.goto("/settings/sources");
  const drive = page.getByTestId("company-drive");
  await expect(drive.getByRole("heading", { name: "Google Drive" })).toBeVisible();

  // Company email domains: seeded from the mock company; a bad one is refused, a new one saved.
  const domains = drive.getByTestId("company-domains");
  await expect(domains.getByRole("list", { name: "Company email domains" }).getByRole("listitem")).toHaveText(["example.com"]);
  const add = domains.getByRole("form", { name: "Add a company domain" });
  await add.getByLabel("Add a domain").fill("not a domain");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(domains.getByRole("alert")).toContainText("Not a domain");
  await add.getByLabel("Add a domain").fill("@Example.ORG");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(domains.getByRole("list", { name: "Company email domains" }).getByRole("listitem")).toHaveText([
    "example.com",
    "example.org",
  ]);
  await expect(add.getByLabel("Add a domain")).toHaveValue("");

  // Company shared drives: none yet; add one from the Google account's shared drives.
  const shared = drive.getByTestId("company-shared-drives");
  await expect(shared).toContainText("None yet.");
  await shared.getByRole("button", { name: "Add shared drives" }).click();
  const choices = shared.getByTestId("shared-drive-choices");
  await expect(choices.getByLabel("Google account")).toHaveValue(/.+/);
  const available = choices.getByRole("list", { name: "Shared drives of pat@example.com" });
  await expect(available.getByRole("listitem")).toHaveText([/Product/, /Design/, /Partner: Acme/]);
  await available.getByRole("button", { name: "Add Product" }).click();
  const saved = shared.getByRole("list", { name: "Company shared drives" });
  await expect(saved.getByRole("listitem")).toHaveText(["Product"]);
  await expect(available.getByRole("listitem", { name: "Product" })).toContainText("Added");
  await expect(available.getByRole("button", { name: "Add Product" })).toHaveCount(0);

  // Both settings survive a reload.
  await page.reload();
  await expect(drive.getByTestId("company-domains").getByRole("listitem")).toHaveText(["example.com", "example.org"]);
  await expect(saved.getByRole("listitem")).toHaveText(["Product"]);

  // Removing a shared drive takes it off the list.
  await saved.getByRole("button", { name: "Remove Product" }).click();
  await expect(saved).toHaveCount(0);
  await expect(shared).toContainText("None yet.");
});

test("settings › sources › Google Drive: a public mail provider is not a company domain", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const domains = page.getByTestId("company-drive").getByTestId("company-domains");
  // Removing a domain hides, from every member's sources, the docs it let in.
  await expect(domains).toContainText("Removing a domain hides the docs it let in from every member’s sources at once.");
  const add = domains.getByRole("form", { name: "Add a company domain" });
  await add.getByLabel("Add a domain").fill("gmail.com");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(domains.getByRole("alert")).toContainText("gmail.com is a public mail provider");
  await expect(domains.getByRole("list", { name: "Company email domains" }).getByRole("listitem")).toHaveText(["example.com"]);
});

test("settings › sources › Google Drive: owners only", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "approver"), MOCK_ROLE_KEY);
  await login(page);
  await page.goto("/settings/sources");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByRole("list", { name: "My sources" })).toBeVisible();
  await expect(page.getByTestId("company-drive")).toHaveCount(0);
  await expect(page.getByText("Company email domains")).toHaveCount(0);
});

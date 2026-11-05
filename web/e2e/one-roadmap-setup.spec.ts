import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * one-roadmap-many-prds, set up from the UI: Settings › Company creates the company's one
 * roadmap (Product roadmap) and sets the team's size and focus; a PRD's page marks it replaced
 * by another PRD and clears it. Approvers and owners only; a viewer sees none of the controls.
 * Driven through the UI against the mock (web/lib/api/mock/one-roadmap.ts, invented data).
 */

async function open(page: Page, scenario: string | null, email?: string) {
  if (scenario) await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
}

/**
 * protects = an owner creates the product roadmap from Settings › Company and it then shows as
 * created, with a link to it; fails_when = no panel or button, or it still reads "No product
 * roadmap yet" after a reload; no_claim = what a run writes onto it (the API's tests).
 */
test("an owner creates the product roadmap in Settings", async ({ page }) => {
  await open(page, null);
  await page.goto("/settings/company");
  const panel = page.getByTestId("product-roadmap-panel");
  await expect(panel.getByTestId("product-roadmap-state")).toContainText("No product roadmap yet");
  await panel.getByRole("button", { name: "Create the product roadmap" }).click();
  await expect(panel.getByTestId("product-roadmap-state")).toHaveText("Created: Product roadmap. Every PRD's items go on it.");
  await expect(panel.getByRole("button", { name: "Create the product roadmap" })).toHaveCount(0);

  await page.reload();
  await expect(panel.getByTestId("product-roadmap-state")).toHaveText("Created: Product roadmap. Every PRD's items go on it.");
  await panel.getByRole("link", { name: "Product roadmap" }).click();
  await expect(page).toHaveURL(/\/documents\/product-roadmap$/);
});

/**
 * protects = an owner sets the team's size and focus in Settings › Company and they persist;
 * fails_when = no Team capacity panel, Save does not store it, or the values reset on reload;
 * no_claim = how the queue's dates follow from them (the API's tests).
 */
test("an owner sets team size and focus, and they stay after a reload", async ({ page }) => {
  await open(page, null);
  await page.goto("/settings/company");
  const panel = page.getByTestId("team-capacity-panel");
  await expect(panel.getByLabel("Team size")).toHaveValue("1");
  await expect(panel.getByLabel("Focus")).toHaveValue("100");
  await panel.getByLabel("Team size").fill("6");
  await panel.getByLabel("Focus").fill("80");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByTestId("team-capacity-saved")).toHaveText("Saved");

  await page.reload();
  await expect(panel.getByLabel("Team size")).toHaveValue("6");
  await expect(panel.getByLabel("Focus")).toHaveValue("80");

  // A focus over 100% is refused in words.
  await panel.getByLabel("Focus").fill("120");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel).toContainText("Focus is more than 0% and at most 100%.");
});

/**
 * protects = an approver marks a PRD replaced by another from its page and sees the read-only
 * line naming it, then clears it; fails_when = no Replaced by action, the line does not name the
 * picked PRD, or Clear leaves it; no_claim = the carried schedule bases (the API's tests).
 */
test("an approver marks a PRD replaced by another, then clears it", async ({ page }) => {
  await open(page, "one-roadmap", "approver@example.com");
  await page.goto("/documents/user-safety");
  await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true })).toContainText("User Safety");
  await expect(page.getByTestId("replaced-by").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Build roadmap/ })).toBeVisible();

  await page.getByRole("button", { name: "Replaced by" }).click();
  const dialog = page.getByTestId("replaced-by-dialog");
  await dialog.getByLabel("Scale").check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const line = page.getByTestId("replaced-by").filter({ visible: true });
  await expect(line).toHaveText("Replaced by Scale. Read-only: its items no longer feed the roadmap.");
  await expect(page.getByRole("button", { name: /Build roadmap/ })).toHaveCount(0);

  await page.reload();
  await expect(line).toHaveText("Replaced by Scale. Read-only: its items no longer feed the roadmap.");
  await page.getByRole("button", { name: "Replaced by" }).click();
  await expect(dialog.getByLabel("Scale")).toBeChecked();
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("replaced-by").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Build roadmap/ })).toBeVisible();
});

/**
 * protects = a viewer sees neither Create the product roadmap nor Replaced by; fails_when =
 * either control shows to a viewer; no_claim = the API's own role checks (its tests).
 */
test("a viewer sees no setup controls", async ({ page }) => {
  await open(page, "one-roadmap", "viewer@example.com");
  await page.goto("/settings/company");
  const panel = page.getByTestId("product-roadmap-panel");
  await expect(panel.getByTestId("product-roadmap-state")).toHaveText("Created: Product roadmap. Every PRD's items go on it.");
  await expect(page.getByTestId("team-capacity-panel")).toHaveCount(0);

  await page.goto("/documents/user-safety");
  await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true })).toContainText("User Safety");
  await expect(page.getByRole("button", { name: "Replaced by" })).toHaveCount(0);
});

import { expect, test, type Page } from "./test";

import { SUGGESTED_BLOCKER } from "../lib/api/mock/baseline";
import { login } from "./helpers";

/**
 * B4 (owner, 2026-10-20): an intake answer's constraint, accepted into the baseline, is a
 * "suggested blocker"; Promote to blocker opens the blocker form pre-filled from it, all
 * editable, and saving makes it a blocker and clears the mark.
 */
async function openProposals(page: Page, role?: "approver" | "viewer") {
  if (role) await page.addInitScript((r) => localStorage.setItem("po-mock-role", r), role);
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  await page.getByRole("tab", { name: /Proposals/ }).click();
}

test("baseline: an approver promotes an intake's suggested blocker from the pre-filled form", async ({ page }) => {
  await openProposals(page, "approver");
  const row = page.getByTestId("suggested-blocker-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(SUGGESTED_BLOCKER.title);
  await expect(row).toContainText("From an intake answer · high severity · Third-party policy");
  await row.getByRole("button", { name: "Promote to blocker" }).click();

  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer.getByTestId("suggested-blocker")).toHaveText("Suggested blocker");
  const form = drawer.getByRole("form", { name: "Promote to blocker" });
  // Pre-filled from the intake answer: the constraint and the suggestion.
  await expect(form.getByLabel("Statement")).toHaveValue(SUGGESTED_BLOCKER.title);
  await expect(form.getByLabel("Detail")).toHaveValue(/Which third-party rules or policies limit this\?/);
  await expect(form.getByLabel("Type")).toHaveValue("unknown");
  await expect(form.getByLabel("Severity")).toHaveValue("high");
  await expect(form.getByLabel("Limit kind")).toHaveValue("policy");
  await expect(form.getByLabel("Status")).toHaveValue("open");
  await expect(form.getByRole("list", { name: "Blocker evidence" })).toContainText("Carrier terms summary");

  // All editable.
  await form.getByLabel("Statement").fill("Carrier terms cap address storage at 30 days");
  await form.getByLabel("Type").selectOption("hard");
  await form.getByLabel("Severity").selectOption("critical");
  await form.getByLabel("Third party (optional)").fill("Example carrier");
  await form.getByRole("button", { name: "Save blocker" }).click();

  await expect(drawer).toContainText("Promoted to a blocker. The suggested-blocker mark is cleared.");
  await expect(drawer.getByRole("heading", { name: "Carrier terms cap address storage at 30 days" })).toBeVisible();
  await expect(drawer.getByTestId("suggested-blocker")).toHaveCount(0);
  await expect(drawer.getByText("Blocker", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("form", { name: "Promote to blocker" })).toHaveCount(0);
  await expect(page.getByTestId("suggested-blocker-row")).toHaveCount(0);
});

test("baseline: the suggested-blocker mark in the inspector, and Cancel keeps it", async ({ page }) => {
  await openProposals(page, "approver");
  await page.getByTestId("suggested-blocker-row").getByRole("button", { name: SUGGESTED_BLOCKER.title }).click();
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer.getByTestId("suggested-blocker")).toBeVisible();
  await expect(drawer.getByTestId("suggestion")).toHaveText("high severity · unknown type · Third-party policy");
  // The raw mark is not drawn again under Attributes.
  await expect(drawer.locator('[data-attr="proposed_blocker"]')).toHaveCount(0);
  await drawer.getByRole("button", { name: "Promote to blocker" }).click();
  const form = drawer.getByRole("form", { name: "Promote to blocker" });
  await form.getByLabel("Limit kind").selectOption("other");
  await form.getByLabel("Third party (optional)").fill("Example carrier");
  await form.getByRole("button", { name: "Save blocker" }).click();
  await expect(form).toContainText("A third party's limit needs a kind");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(drawer.getByTestId("suggested-blocker")).toBeVisible();
  await expect(page.getByTestId("suggested-blocker-row")).toHaveCount(1);
});

test("baseline: a viewer sees the suggested blocker but cannot promote it", async ({ page }) => {
  await openProposals(page, "viewer");
  const row = page.getByTestId("suggested-blocker-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Promote to blocker" })).toHaveCount(0);
  await row.getByRole("button", { name: SUGGESTED_BLOCKER.title }).click();
  const drawer = page.getByTestId("entity-drawer");
  await expect(drawer.getByTestId("suggested-blocker")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Promote to blocker" })).toHaveCount(0);
});

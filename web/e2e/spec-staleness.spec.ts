import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * #481 A spec version that may be stale is reviewed or reconciled from its tech brief page:
 * Potentially stale › Review (marked reviewed against the changed PRD, with an optional
 * note; writes the trace's staleness action, as the Plan inspector's does) and Reconcile
 * (Regenerate from the PRD, the changed sections named; it only proposes the regeneration,
 * owner decision 2026-10-23, so the version stays Potentially stale until the regenerated
 * one supersedes it or someone presses Review). Shown to the roles that may approve
 * the spec, hidden for the others (#370). On the mock layer, driven as a person would.
 */

const SPEC = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";

const stale = (page: Page) => page.getByTestId("spec-staleness").filter({ visible: true });

test("an approver reviews a potentially stale spec, the label clears and Approve then succeeds", async ({ page }) => {
  // protects=#481 Done when 1; fails_when=Review or Reconcile is missing for an approver,
  // Review leaves the label, or Approve still refuses; no_claim=the API's write
  // (api/tests/test_warning_wording.py).
  await login(page, "approver@example.com");
  await page.goto(SPEC);
  const panel = stale(page);
  await expect(panel).toContainText("Potentially stale");
  await expect(panel.getByRole("button", { name: "Reconcile" })).toBeVisible();

  // Approve first is refused, and names the controls.
  await page.getByRole("button", { name: "Approve version" }).click();
  const confirm = page.getByRole("group", { name: "Confirm approval" });
  await confirm.getByRole("button", { name: "Confirm" }).click();
  await expect(confirm.getByRole("alert")).toContainText("Potentially stale › Review / Reconcile");
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await panel.getByRole("button", { name: "Review" }).click();
  await panel.getByLabel("Note (optional)").fill("Checked against the new shipping estimate wording");
  await panel.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(panel).toContainText("Under review");
  await expect(panel).not.toContainText("Potentially stale");
  await expect(panel.getByRole("button", { name: "Review" })).toHaveCount(0);

  await page.getByRole("button", { name: "Approve version" }).click();
  await page.getByRole("group", { name: "Confirm approval" }).getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/✓ Approved/).first()).toBeVisible();
});

test("Reconcile opens Regenerate from the PRD with the changed sections named, and starts nothing by itself", async ({ page }) => {
  // protects=#481 Build 1; fails_when=Reconcile starts a run on its own, or does not name
  // the changed sections; no_claim=what the regeneration run writes (api/tests/test_specs.py).
  await login(page);
  await page.goto(SPEC);
  const panel = stale(page);
  await panel.getByRole("button", { name: "Reconcile" }).click();
  const regen = panel.getByRole("group", { name: "Regenerate from the PRD" });
  await expect(regen).toContainText('"5.2 Shipping step"');
  // Opening it changed nothing: the label stays.
  await expect(panel).toContainText("Potentially stale");
  await regen.getByRole("button", { name: "Cancel" }).click();
  await expect(regen).toHaveCount(0);
});

test("Reconcile only proposes the regeneration: the version stays stale and Approve refused; Review still clears it", async ({ page }) => {
  // protects=#481 fixes item 1 (owner decision 2026-10-23); fails_when=Reconcile settles the
  // label, offers a second Reconcile while its regeneration runs, or lets Approve pass, or
  // Review no longer clears the label; no_claim=the import superseding the version
  // (api/tests/test_spec_reconcile.py).
  await login(page);
  await page.goto(SPEC);
  const panel = stale(page);
  await panel.getByRole("button", { name: "Reconcile" }).click();
  await panel.getByRole("button", { name: "Regenerate from the PRD" }).click();
  await expect(panel).toContainText("Potentially stale · regeneration running");
  await expect(panel).not.toContainText("Under review");
  await expect(panel.getByRole("link", { name: "Estimate and start it" })).toHaveAttribute("href", /^\/runs\//);
  await expect(panel.getByRole("button", { name: "Reconcile" })).toHaveCount(0);

  // The label holds after a reload: it is the spec's, not the page's.
  await page.reload();
  await expect(stale(page)).toContainText("Potentially stale · regeneration running");

  await page.getByRole("button", { name: "Approve version" }).click();
  const confirm = page.getByRole("group", { name: "Confirm approval" });
  await confirm.getByRole("button", { name: "Confirm" }).click();
  await expect(confirm.getByRole("alert")).toContainText("Potentially stale › Review / Reconcile");
  await confirm.getByRole("button", { name: "Cancel" }).click();

  await stale(page).getByRole("button", { name: "Review" }).click();
  await stale(page).getByRole("button", { name: "Mark reviewed" }).click();
  await expect(stale(page)).toContainText("Under review");
  await expect(stale(page)).not.toContainText("Potentially stale");
});

test("a viewer sees the label but neither control", async ({ page }) => {
  // protects=#481 Done when 1, #370; fails_when=a viewer sees Review or Reconcile;
  // no_claim=the API's refusal (api/tests/test_warning_wording.py).
  await login(page, "viewer@example.com");
  await page.goto(SPEC);
  const panel = stale(page);
  await expect(panel).toContainText("Potentially stale");
  await expect(panel.getByRole("button", { name: "Review" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Reconcile" })).toHaveCount(0);
  await expect(page.getByTestId("view-only").filter({ visible: true })).toBeVisible();
});

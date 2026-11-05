import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * C7 on the Feature set review screen: two blocking problems of the same code on one feature
 * (it depends on two left-out features) are two reasons in its inspector, each with its own
 * Waive, its own reason box and its own waiver, named in the bar by the problem it waives.
 *
 * Test cards (protects / fails_when / no_claim):
 * - own-box: protects=Waive on one problem opens only its box, and a waiver answers that
 *   problem only, keeping its own reason; fails_when=both boxes open together, one waiver
 *   marks both waived, or the second shows the first's reason; no_claim=the run page's gate
 *   (fs-stop-waive.spec.ts).
 * - chip: protects=the bar's staged chip names the problem it waives ("Waive: <feature>
 *   depends on <feature>"); fails_when=it names the feature's key, or the same dependency for
 *   both; no_claim=the chips of edits and accepts.
 * - gate-names: protects=the run page's gate rows name the feature by its title;
 *   fails_when=a row shows the feature's key.
 */

const FIRST = "Bulk address edit depends on Shared address book export";
const SECOND = "Bulk address edit depends on Address sharing";

async function openStop(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "feature-set-two"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").click();
  return page.getByTestId("checkpoint-feature_set");
}

test("The run page's gate names each problem's feature by its title, never its key", async ({ page }) => {
  const cp = await openStop(page);
  const rows = cp.getByTestId("approve-gate").getByTestId("gate-reason");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Bulk address edit");
  await expect(cp.getByTestId("approve-gate")).not.toContainText("bulk-address-edit");
});

test("Waive on one of two same-kind problems opens its own box and waives it alone, with its own reason", async ({ page }) => {
  const cp = await openStop(page);
  await cp.getByRole("link", { name: "Review feature set" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Feature set" })).toBeVisible();
  await page.getByTestId("scope-row").filter({ hasText: "Bulk address edit" }).getByTestId("feature-title").click();
  const inspector = page.getByTestId("scope-inspector");
  const reasons = inspector.getByTestId("reason-depends_on_excluded");
  await expect(reasons).toHaveCount(2);
  const first = reasons.filter({ hasText: "Shared address book export" });
  const second = reasons.filter({ hasText: "Address sharing" });

  await first.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(inspector.getByTestId("waive-form")).toHaveCount(1);
  await expect(first.getByTestId("waive-form")).toBeVisible();
  await first.getByLabel("Why is this fine?").fill("The export ships in the same release");
  await first.getByTestId("waive-form").getByRole("button", { name: "Waive", exact: true }).click();

  await expect(first).toContainText("Waived: The export ships in the same release");
  await expect(second).not.toContainText("Waived");
  await expect(second.getByRole("button", { name: "Waive", exact: true })).toBeVisible();
  const chips = page.getByTestId("staged-chip");
  await expect(chips.filter({ hasText: `Waive: ${FIRST}` })).toHaveCount(1);
  await expect(chips.filter({ hasText: "bulk-address-edit" })).toHaveCount(0);

  await second.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(inspector.getByTestId("waive-form")).toHaveCount(1);
  await second.getByLabel("Why is this fine?").fill("Sharing is a nice to have");
  await second.getByTestId("waive-form").getByRole("button", { name: "Waive", exact: true }).click();
  await expect(second).toContainText("Waived: Sharing is a nice to have");
  await expect(first).toContainText("Waived: The export ships in the same release");
  await expect(chips.filter({ hasText: `Waive: ${SECOND}` })).toHaveCount(1);

  // Undo on one brings back that one only.
  await first.getByRole("button", { name: "Undo" }).click();
  await expect(first.getByRole("button", { name: "Waive", exact: true })).toBeVisible();
  await expect(second).toContainText("Waived: Sharing is a nice to have");
});

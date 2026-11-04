import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * D3 at the feature set's stop: two blocking problems of the same code on one feature (it
 * depends on two left-out features) are two rows under the decision, each with its own
 * Waive…, its own reason box and its own Waive; a waiver drops its row at once, once.
 *
 * Test cards (protects / fails_when / no_claim):
 * - own-box: protects=Waive… on one problem opens only its box, and each box keeps its own
 *   text; fails_when=both boxes open together or typing in one fills the other;
 *   no_claim=the API's waiver (api/tests/test_checkpoint_gate_refs.py).
 * - waive-one: protects=Waive on one problem waives that one only, the list shows the other
 *   once, and the second waiver keeps its own reason; fails_when=both go with one reason, a
 *   row is listed twice, or the waived one stays until a reload; no_claim=the review screen.
 */

// The run the "feature-set-two" mock scenario seeds (web/lib/api/mock/runs.ts).
const FIRST = "bulk-address-edit depends on shared-address-book-export, which is excluded";
const SECOND = "bulk-address-edit depends on address-labels, which is excluded";

async function openStop(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "feature-set-two"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").click();
  return page.getByTestId("checkpoint-feature_set");
}

test("Waive… on one problem opens only its own reason box, each with its own text", async ({ page }) => {
  const cp = await openStop(page);
  const gate = cp.getByTestId("approve-gate");
  await expect(gate.getByTestId("gate-reason")).toHaveCount(2);
  const first = gate.getByTestId("gate-reason").filter({ hasText: FIRST });
  const second = gate.getByTestId("gate-reason").filter({ hasText: SECOND });
  await first.getByRole("button", { name: "Waive…" }).click();
  await expect(gate.getByRole("textbox")).toHaveCount(1);
  await expect(first.getByLabel(`Reason to waive: ${FIRST}`)).toBeVisible();
  await expect(second.getByRole("button", { name: "Waive…" })).toBeVisible();
  await first.getByRole("textbox").fill("The export ships in the same release");
  await second.getByRole("button", { name: "Waive…" }).click();
  await expect(gate.getByRole("textbox")).toHaveCount(2);
  await expect(second.getByRole("textbox")).toHaveValue("");
  await second.getByRole("textbox").fill("Labels are a nice to have");
  await expect(first.getByRole("textbox")).toHaveValue("The export ships in the same release");
});

test("Waive on one problem waives it alone: the other is listed once and waived with its own reason", async ({ page }) => {
  const cp = await openStop(page);
  const approve = cp.getByRole("button", { name: "Approve and continue" });
  const gate = cp.getByTestId("approve-gate");
  const first = gate.getByTestId("gate-reason").filter({ hasText: FIRST });
  const second = gate.getByTestId("gate-reason").filter({ hasText: SECOND });
  await second.getByRole("button", { name: "Waive…" }).click();
  await second.getByRole("textbox").fill("Labels are a nice to have");
  await first.getByRole("button", { name: "Waive…" }).click();
  await first.getByRole("textbox").fill("The export ships in the same release");
  await first.getByRole("button", { name: "Waive", exact: true }).click();
  // The waived one goes at once; the other is listed once, its box and text kept.
  await expect(gate.getByTestId("gate-reason")).toHaveCount(1);
  await expect(gate.getByText(FIRST)).toHaveCount(0);
  await expect(gate.getByText(SECOND)).toHaveCount(1);
  await expect(gate).toContainText("1 blocking problem left");
  await expect(second.getByRole("textbox")).toHaveValue("Labels are a nice to have");
  await expect(approve).toBeDisabled();
  await second.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(cp.getByTestId("approve-gate")).toHaveCount(0);
  await expect(approve).toBeEnabled();
  // Both waivers stay staged: after a reload nothing is open.
  await page.reload();
  await expect(page.getByTestId("checkpoint-feature_set").getByTestId("approve-gate")).toHaveCount(0);
});

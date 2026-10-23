import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * C6 Feature set and PRD scope: the run page's feature-set line summarises the check of
 * feature_set.yaml, expands to every problem (full text) and the advisory flags per feature,
 * and a blocking problem disables Approve and continue with the server's reason while Request
 * changes stays.
 *
 * Test cards (protects / fails_when / no_claim):
 * - criteria 11: protects=the approver sees the check and cannot approve past a blocking
 *   problem; fails_when=the counts or the problem text are missing, Approve is enabled, or
 *   Request changes is blocked; no_claim=the server's gate (api/tests/test_prd_scope.py).
 * - D3 criterion 8a: protects=the feature set's blocking problem is a reason of the one
 *   approve gate: listed under the decision with Waive…, and a waiver with a reason enables
 *   Approve and continue; fails_when=the problem is refused outside the gate (no Waive…) or
 *   Approve stays disabled after the waiver; no_claim=the server's gate
 *   (api/tests/test_checkpoint_gate_kinds.py).
 * - criterion 12: protects=the problem text is readable on a phone; fails_when=it is
 *   truncated or the page scrolls sideways at 390 px; no_claim=other viewports.
 */

// The run the "feature-set" mock scenario seeds (web/lib/api/mock/runs.ts), waiting at the
// feature set with one blocking problem and two flags.
const RUN = "7a11c0de-0000-4000-8000-0000000000f5";
const LINE = "Feature set: 6 features, 14 requirements, 2 left out · 1 problem";
const PROBLEM = "bulk-address-edit depends on shared-address-book-export, which is excluded";
const REASON = "1 blocking problem left: fix or waive them, or send back to the agents.";

async function seeded(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "feature-set"), MOCK_SCENARIO_KEY);
  await login(page);
}

test("the feature-set line shows the check, and a blocking problem disables Approve while Request changes works", async ({ page }) => {
  await seeded(page);
  await page.getByTestId("nav-runs").click();
  await page.getByTestId("run-row").filter({ hasText: "saved-addresses" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();

  const segment = page.getByTestId("segment-feature_set");
  const check = segment.getByTestId("feature-set-check");
  const toggle = check.getByRole("button", { name: LINE });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(check.getByTestId("feature-set-problems")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const problems = check.getByTestId("feature-set-problems").getByRole("listitem");
  await expect(problems).toHaveCount(1);
  await expect(problems.first()).toHaveText(PROBLEM);
  // The advisory flags, per feature.
  const flags = check.getByTestId("feature-set-flags").getByRole("listitem");
  await expect(flags).toHaveCount(2);
  await expect(flags.filter({ hasText: "bulk-address-edit" })).toContainText("serves no goal, low confidence");
  await expect(flags.filter({ hasText: "saved-addresses" })).toContainText("new feature");

  // The checkpoint: Approve and continue is disabled with the approve gate's reason.
  const cp = page.getByTestId("checkpoint-feature_set");
  await expect(cp.getByTestId("approve-gate").getByText(REASON)).toBeVisible();
  const approve = cp.getByRole("button", { name: "Approve and continue" });
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute("title", REASON);

  // Request changes still works: the segment runs again with the note.
  await cp.getByLabel("Note for the agents").fill("Keep bulk edit off the excluded address book");
  await cp.getByRole("button", { name: "Request changes" }).click();
  await expect(segment).toContainText("attempt 2");
  await expect(page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" })).toHaveCount(0);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
});

test("the feature set's blocking problem is waived under the decision, and Approve and continue is enabled", async ({ page }) => {
  await seeded(page);
  await page.getByTestId("nav-runs").click();
  await page.getByTestId("run-row").filter({ hasText: "saved-addresses" }).getByRole("link").click();
  const cp = page.getByTestId("checkpoint-feature_set");
  const approve = cp.getByRole("button", { name: "Approve and continue" });
  await expect(approve).toBeDisabled();
  const gate = cp.getByTestId("approve-gate");
  await expect(gate.getByTestId("gate-reason")).toHaveCount(1);
  const row = gate.getByTestId("gate-reason").filter({ hasText: "bulk-address-edit" });
  await expect(row).toContainText(PROBLEM);
  await row.getByRole("button", { name: "Waive…" }).click();
  await row.getByLabel(`Reason to waive: ${PROBLEM}`).fill("The export ships in the same release");
  await row.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(cp.getByTestId("approve-gate")).toHaveCount(0);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByTestId("checkpoint-feature_set").filter({ hasText: "Waiting" })).toHaveCount(0);
});

test("at 390 px the problem text wraps: nothing truncated, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seeded(page);
  await page.goto(`/runs/${RUN}`);
  const check = page.getByTestId("segment-feature_set").getByTestId("feature-set-check");
  await check.getByRole("button", { name: LINE }).click();
  const problem = check.getByTestId("feature-set-problems").getByRole("listitem").first();
  await expect(problem).toHaveText(PROBLEM);
  const shape = await problem.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      ellipsis: style.textOverflow === "ellipsis",
      nowrap: style.whiteSpace === "nowrap",
      clipped: el.scrollWidth > el.clientWidth,
      lines: el.getBoundingClientRect().height / parseFloat(style.lineHeight),
    };
  });
  expect(shape.ellipsis).toBe(false);
  expect(shape.nowrap).toBe(false);
  expect(shape.clipped).toBe(false);
  expect(shape.lines).toBeGreaterThan(1.5);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

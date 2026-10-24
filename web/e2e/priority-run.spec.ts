import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { PRIORITY_BLOCKED_RUN, PRIORITY_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

/**
 * C8 Priority order snapshot: the run's priority.yaml is a proposed snapshot; the
 * Priorities screen in run mode compares it with Oracle's live ranking (Live # and Δ),
 * shows the check's problems on the rows, and approves or sends back the stop.
 *
 * Test cards (protects / fails_when / no_claim):
 * - "review and approve the run's order" (criterion 8): protects=the run mode end to end on
 *   the mock; fails_when=deltas, chips or the approve gate disagree with the check;
 *   no_claim=the real API (api/tests/test_priority_run_order.py).
 * - "a blocking problem disables Approve order; Request changes sends it back"
 *   (criterion 9): protects=call c3 on the screen; fails_when=Approve order is enabled with
 *   a blocking problem or Request changes does not send the segment back; no_claim=the
 *   server's gate.
 * - "the Snapshots panel lists saved snapshots only" (criterion 10): protects=rule 7 on the
 *   screen; fails_when=a proposed order is listed or the saved run order lacks its PRD;
 *   no_claim=the list's order.
 * - "at 390 px Live # and Δ show in the row card" (criterion 11): protects=the phone layout;
 *   fails_when=either column is hidden or the page scrolls sideways; no_claim=other widths.
 */

const APPROVER = "approver@example.com";

async function seeded(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "priority-order"), MOCK_SCENARIO_KEY);
  await login(page, APPROVER);
}

test("review and approve the run's order", async ({ page }) => {
  await seeded(page);
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  const cp = page.getByTestId("checkpoint-priority_order");
  await cp.getByRole("link", { name: "Review the order" }).click();

  await expect(page).toHaveURL(/\/priorities\?snapshot=/);
  const band = page.getByTestId("snapshot-band");
  await expect(band).toContainText("Proposed by Baseline to PRD · saved-addresses · waiting for you");
  // The method switch is locked to the snapshot's method.
  const methods = page.getByRole("radiogroup", { name: "Ranking method" });
  await expect(methods.getByRole("radio", { name: "Goal-weighted" })).toHaveAttribute("aria-checked", "true");
  await expect(methods.getByRole("radio", { name: "RICE" })).toBeDisabled();

  // The run's order, with Live # and Δ.
  const table = page.getByTestId("priority-table");
  await expect(table.getByRole("columnheader", { name: "Live #" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Δ" })).toBeVisible();
  const rows = page.locator('tr[data-testid^="priority-row-"]');
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("priority-row-", "")))).toEqual([
    "F-5",
    "F-4",
    "F-2",
    "F-1",
    "F-7",
  ]);
  const moved = page.getByTestId("priority-row-F-4");
  await expect(moved.getByTestId("live-rank")).toHaveText("5");
  await expect(moved.getByTestId("delta")).toHaveText("↑3");
  await expect(page.getByTestId("priority-row-F-2").getByTestId("delta")).toHaveText("↓1");
  await expect(page.getByTestId("priority-row-F-5").getByTestId("delta")).toHaveText("=");
  // The differs_from_live row: an amber chip with its message.
  const chip = moved.getByTestId("problem-differs_from_live");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-kind", "warn");
  await expect(chip).toHaveAttribute("title", "F-4 is ranked 2 here and 5 in the live ranking");

  // Why rank 2: the run's explanation above Oracle's live formula.
  await moved.getByRole("button", { name: /Usage alerts/ }).click();
  const why = page.getByTestId("run-explanation");
  await expect(why).toContainText("Why rank 2");
  await expect(why).toContainText("Alerts keep teams active; ranked early on purpose");
  await expect(page.getByTestId("explanation-F-4").getByRole("list", { name: "Steps" })).toBeVisible();

  // Approve order: saved for the PRD, and the run moves on.
  await band.getByRole("button", { name: "Approve order" }).click();
  await expect(band).toContainText("Saved for Saved addresses");
  await expect(band.getByRole("button", { name: "Approve order" })).toHaveCount(0);
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
  await expect(page.getByTestId("segment-prd_draft").getByTestId("segment-state")).toHaveText("Running");
});

test("a blocking problem disables Approve order; Request changes sends it back", async ({ page }) => {
  await seeded(page);
  await page.goto(`/runs/${PRIORITY_BLOCKED_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  const band = page.getByTestId("snapshot-band");
  await expect(band).toContainText("waiting for you");
  const approve = band.getByRole("button", { name: "Approve order" });
  await expect(approve).toBeDisabled();
  await expect(band.getByTestId("cannot-approve")).toContainText("1 blocking problem");
  const chip = page.getByTestId("priority-row-F-2").getByTestId("problem-before_prerequisite");
  await expect(chip).toHaveAttribute("data-kind", "crit");
  await expect(chip).toHaveAttribute("title", "F-2 is ranked 1, above F-5 (rank 2), which it depends on");

  const requestChanges = band.getByRole("button", { name: "Request changes" });
  await expect(requestChanges).toBeDisabled();
  await band.getByLabel("Note for the agents").fill("Address lookup comes first");
  await requestChanges.click();
  await expect(band).toContainText("Discarded");
  await page.goto(`/runs/${PRIORITY_BLOCKED_RUN}`);
  await expect(page.getByTestId("segment-priority")).toContainText("attempt 2");
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Running");
});

test("the Snapshots panel lists saved snapshots only, each run order with its PRD", async ({ page }) => {
  await seeded(page);
  await page.goto("/priorities");
  const list = page.getByTestId("snapshot-list");
  // Seeded: one saved run order (Checkout redesign) and two proposed ones, never listed.
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Checkout redesign PRD · approved order");

  // Approving a proposed order lists it, with its PRD.
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  await page.getByTestId("snapshot-band").getByRole("button", { name: "Approve order" }).click();
  await expect(page.getByTestId("snapshot-band")).toContainText("Saved for Saved addresses");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Saved addresses PRD · approved order");
  await page.goto("/priorities");
  await expect(page.getByTestId("snapshot-band")).toHaveCount(0);
  await expect(page.getByTestId("snapshot-list").getByRole("listitem")).toHaveCount(2);
});

test("at 390 px Live # and Δ show in the row card, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seeded(page);
  await page.goto(`/runs/${PRIORITY_RUN}`);
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click();
  const row = page.getByTestId("priority-row-F-4");
  await expect(row.getByTestId("live-rank")).toBeVisible();
  await expect(row.getByTestId("live-rank")).toHaveText("5");
  await expect(row.getByTestId("delta")).toBeVisible();
  await expect(row.getByTestId("delta")).toHaveText("↑3");
  await expect(row.getByTestId("problem-differs_from_live")).toBeVisible();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

import { expect, test, type Page } from "./test";

import { CONSOLE_HELD_RUN, CONSOLE_HELD_RUN_ID } from "../lib/api/mock/runs";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSeeded, seedConsoleHeld, seedRun } from "./helpers";

/**
 * D3 on the run page, the review minors PR 1249 skipped: the staged waive chip names the
 * problem and the feature, a refused waive says why and keeps its reason, and each gate reason
 * row carries its ref. Driven through the UI over the mock API.
 *
 * Test cards (protects / fails_when / no_claim):
 * - chip-names: protects=a staged waive reads "Waive <problem> on <code> <feature>";
 *   fails_when=it reads "Waive" alone; no_claim=the review screen's rows.
 * - refused: protects=a refused waive keeps its form open with the reason and shows the API's
 *   words under it; fails_when=the form closes with nothing said; no_claim=the API's refusal.
 * - data-ref: protects=a gate reason row carries its ref, else its code; fails_when=no data-ref.
 */

const decision = (page: Page) => page.getByRole("group", { name: "Decide: Roadmap items" });
const REASON = "Section lands in the next PRD version";

/** The console-held run with its Usage export item keyed F-12, as a feature with a code. */
const CODED_RUN = JSON.parse(JSON.stringify(CONSOLE_HELD_RUN).replaceAll("usage-export", "F-12")) as typeof CONSOLE_HELD_RUN;

async function waiveUsageExport(page: Page) {
  const row = decision(page).getByTestId("gate-reason").filter({ hasText: "Usage export" });
  await row.getByRole("button", { name: "Waive…" }).click();
  await row.getByRole("textbox").fill(REASON);
  await row.getByRole("button", { name: "Waive", exact: true }).click();
  return row;
}

test("the staged waive chip names the problem and the feature with its code", async ({ page }) => {
  await login(page);
  await openSeeded(page, (p) => seedRun(p, CODED_RUN), `/runs/${CONSOLE_HELD_RUN_ID}`);
  await waiveUsageExport(page);
  const chip = page.getByTestId("draft-action").filter({ hasText: "Staged by" });
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText(/^Waive No PRD section on F-12 Usage export · Staged by /);
});

test("a refused waive keeps its form and reason and says why", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  const row = decision(page).getByTestId("gate-reason").filter({ hasText: "Usage export" });
  await row.getByRole("button", { name: "Waive…" }).click();
  await row.getByRole("textbox").fill(REASON);

  // Meanwhile, in a second tab, the stop is waived and the console approval confirmed.
  const other = await page.context().newPage();
  await other.goto(`/runs/${CONSOLE_HELD_RUN_ID}`);
  await waiveUsageExport(other);
  const confirm = decision(other).getByRole("button", { name: "Confirm approval" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(other.getByTestId("segment-roadmap_items").getByTestId("checkpoint-roadmap_items")).toContainText("Approved");
  await other.close();

  await row.getByRole("button", { name: "Waive", exact: true }).click();
  await expect(row.getByRole("alert")).toHaveText("This checkpoint is decided");
  await expect(row.getByRole("textbox")).toHaveValue(REASON);
  await expect(row.getByRole("button", { name: "Waive", exact: true })).toBeEnabled();
});

test("each gate reason row carries its ref, else its code", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  await expect(decision(page).locator('[data-testid="gate-reason"][data-ref="unknown_prd_section"]')).toContainText("Usage export");
});

test("two problems of one code on one feature carry two refs", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "feature-set-two"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByTestId("nav-runs").click();
  await page.locator('[data-testid="run-row"][data-document="saved-addresses"]').getByRole("link").click();
  const rows = page.getByTestId("checkpoint-feature_set").getByTestId("approve-gate").getByTestId("gate-reason");
  await expect(rows).toHaveCount(2);
  const refs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-ref") ?? ""));
  expect(refs.every((r) => r.includes("~"))).toBe(true);
  expect(new Set(refs).size).toBe(2);
});

import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

const CAUSE = "The writer stopped: its session ran out of room.";

/** Seeds a Baseline to PRD run that failed at its PRD draft with the given run and step errors. */
async function seedFailedRun(page: Page, runError: string, stepError: string): Promise<string> {
  // Seed from a page that runs no app code (a mock request in flight would save over the seed).
  await page.goto("/icon.svg");
  return page.evaluate(([runError, stepError]) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type S = Record<string, unknown> & { seq: number; name: string; checkpoint: string | null };
    const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
    const id = "7a11c0de-0000-4000-8000-0000000000f1";
    const at = "2026-10-17T09:00:00Z";
    const run = { ...JSON.parse(JSON.stringify(base)), id, document_slug: "guest-checkout", document_id: null, created_at: at, started_at: at };
    const segments: S[] = run.segments;
    const failed = segments.find((s) => s.name === "prd_draft")!;
    for (const s of segments) {
      const before = s.seq < failed.seq;
      Object.assign(s, {
        id: crypto.randomUUID(),
        status: before ? "succeeded" : s === failed ? "failed" : "pending",
        cost_usd: before || s === failed ? 1 : 0,
        error: s === failed ? stepError : null,
        started_at: before || s === failed ? at : null,
        finished_at: before || s === failed ? at : null,
        artifacts: [],
        draft_import: null,
        attempts:
          before || s === failed
            ? [{ attempt: 1, workflow_id: `mock-wf-qa-${s.seq}`, submitted_at: at, cost_usd: 1, note: null, state: before ? "succeeded" : "failed" }]
            : [],
      });
    }
    run.checkpoints = segments
      .filter((s) => s.seq < failed.seq && s.checkpoint)
      .map((s) => ({
        id: crypto.randomUUID(),
        run_id: id,
        kind: s.checkpoint,
        status: "approved",
        approver_role: "approver",
        segment_seq: s.seq,
        decided_by: null,
        decided_at: at,
        note: null,
        payload: {},
        created_at: at,
        can_decide: false,
      }));
    Object.assign(run, { status: "failed", waiting_on: null, finished_at: at, error: runError, can_retry: false, stuck: null });
    db.runs.runs.push(run);
    localStorage.setItem(key, JSON.stringify(db));
    return id;
  }, [runError, stepError] as const);
}

test("a failed run says why once: the banner has it, the step row does not repeat it", async ({ page }) => {
  await login(page);
  const id = await seedFailedRun(page, CAUSE, CAUSE);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByTestId("segment-state")).toHaveText("Failed");
  await expect(prd).not.toContainText(CAUSE);
  await expect(page.getByText(CAUSE, { exact: false }).filter({ visible: true })).toHaveCount(1);
  // The step is still the one to retry.
  await expect(prd.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("a step's own different error stays on its row beside the run's", async ({ page }) => {
  await login(page);
  const id = await seedFailedRun(page, "PRD draft failed.", CAUSE);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText(CAUSE);
  await expect(page.getByText("PRD draft failed.").filter({ visible: true })).toHaveCount(1);
});

test("a running run that has reported no cost says so in the side panel and keeps its not-checked note behind an (i)", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "slow-agents"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" }).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  const progress = page.getByTestId("segment-roadmap_items").getByTestId("segment-progress");
  await expect(progress.getByTestId("segment-cost")).toHaveText("Cost not reported yet");
  // The side panel agrees: no "$0.00" before any cost is reported.
  const cost = page.getByTestId("run-details").getByTestId("run-cost");
  await expect(cost).toContainText("Cost not reported yet");
  await expect(cost).not.toContainText("$0.00");

  // The not-checked sentence is behind an (i), not in the footer.
  const note = "The agents' progress shows after the next check.";
  await expect(progress).toContainText("Not checked yet");
  await expect(progress.getByText(note)).toBeHidden();
  await progress.getByRole("button", { name: "About the progress check" }).click();
  await expect(progress.getByText(note)).toBeVisible();

  // Once a cost is reported, both places show it.
  await page.getByRole("button", { name: "Refresh progress" }).click();
  await expect(progress.getByTestId("segment-cost")).toContainText("spent so far");
  await expect(cost).toContainText("estimated");
  await expect(cost).not.toContainText("Cost not reported yet");
  await expect(page.getByTestId("run-details").getByTestId("run-spent")).not.toHaveText("$0.00");
});

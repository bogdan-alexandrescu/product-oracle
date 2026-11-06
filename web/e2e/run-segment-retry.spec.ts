import { expect, test, type Page } from "./test";

import { login } from "./helpers";

const CAUSE = "The writer stopped: its session ran out of room.";

/** The run's status badge (Next keeps the list page mounted but hidden). */
function status(page: Page) {
  return page.getByTestId("run-status").filter({ visible: true });
}

/**
 * Seeds the mock with a Baseline to PRD run that failed at its PRD draft: the steps before it
 * succeeded and their stops were approved; the writer's session ran out of room. Returns its id.
 */
async function seedFailedRun(page: Page, overBudget = false): Promise<string> {
  // Seed from a page that runs no app code (a mock request in flight would save over the seed).
  await page.goto("/icon.svg");
  return page.evaluate(([cause, overBudget]) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type S = Record<string, unknown> & { seq: number; name: string; checkpoint: string | null };
    const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
    const id = "7a11c0de-0000-4000-8000-0000000000e9";
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
        error: s === failed ? cause : null,
        started_at: before || s === failed ? at : null,
        finished_at: before || s === failed ? at : null,
        artifacts: [],
        draft_import: null,
        attempts:
          before || s === failed
            ? [{ attempt: 1, workflow_id: `mock-wf-retry-${s.seq}`, submitted_at: at, cost_usd: 1, note: null, state: before ? "succeeded" : "failed" }]
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
    Object.assign(run, { status: "failed", waiting_on: null, finished_at: at, error: `PRD draft: ${cause}`, can_retry: false, stuck: null });
    // Its spend past its ceiling: it stopped at its budget.
    if (overBudget) Object.assign(run, { spent_usd: 40, overrun_ceiling_usd: 1 });
    db.runs.runs.push(run);
    localStorage.setItem(key, JSON.stringify(db));
    return id;
  }, [CAUSE, overBudget] as const);
}

test("a run that failed at its PRD draft: Retry runs that step again, the steps before it stay approved", async ({ page }) => {
  await login(page);
  const id = await seedFailedRun(page);
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Guest checkout · Ground Truth to PRD" })).toBeVisible();
  await expect(status(page)).toHaveText("Failed");

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText(CAUSE);
  await expect(prd.getByTestId("segment-state")).toHaveText("Failed");
  const retry = prd.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(prd.getByTestId("segment-retry")).toContainText("Retry this step.");
  // Only the step the run stopped at offers it.
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);

  await retry.click();
  await expect(prd.getByTestId("segment-state")).toHaveText("Running");
  await expect(status(page)).toHaveText("Running");
  await expect(prd).not.toContainText(CAUSE);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  // The steps before it stay as they were: succeeded, their stops approved.
  await expect(page.getByTestId("segment-feature_set").getByTestId("segment-state")).toHaveText("Succeeded");
  await expect(page.getByTestId("segment-feature_set").getByTestId("checkpoint-feature_set")).toContainText("Approved");
});

test("a viewer reads why the run failed but is offered no Retry", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-role", "viewer"));
  await login(page);
  const id = await seedFailedRun(page);
  await page.goto(`/runs/${id}`);

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText(CAUSE);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  // "Retry this step." only beside a Retry the person has.
  await expect(page.getByText("Retry this step.")).toHaveCount(0);
});

test("a run that stopped at its budget says why and offers no Retry", async ({ page }) => {
  await login(page);
  const id = await seedFailedRun(page, true);
  await page.goto(`/runs/${id}`);
  await expect(status(page)).toHaveText("Failed");
  await expect(page.getByTestId("budget-stopped")).toHaveText("This run stopped at its budget; start it again with a new estimate.");

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText(CAUSE);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByText("Retry this step.")).toHaveCount(0);
});

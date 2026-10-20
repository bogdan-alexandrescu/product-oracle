import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/** The run's status badge (Next keeps the list page mounted but hidden). */
function status(page: Page) {
  return page.getByTestId("run-status").filter({ visible: true });
}

async function openRuns(page: Page) {
  await login(page);
  await page.getByTestId("nav-runs").click();
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
}

test("runs list shows each run with its status, estimate and spend", async ({ page }) => {
  await openRuns(page);
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(4);
  const waiting = rows.filter({ hasText: "team-onboarding" });
  await expect(waiting).toContainText("Waiting for review");
  await expect(waiting).toContainText("Confirm the baseline");
  await expect(waiting).toContainText("$26.50");
  await expect(rows.filter({ hasText: "usage-alerts-v2" })).toContainText("Awaiting cost approval");
  await expect(rows.filter({ hasText: "team-workspaces" })).toContainText("Paused: over budget");
});

test("run detail: approve each checkpoint through to the imported PRD", async ({ page }) => {
  await openRuns(page);
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(page.getByTestId("run-notes")).toContainText("Local agent runtime");
  await expect(page.getByTestId("run-spent")).toHaveText("$6.30");

  // The open checkpoint: its state in the row (named once, in the decision and the inspector),
  // Decide as the page's primary action.
  const chip = page.getByTestId("segment-baseline").getByTestId("checkpoint-waiting");
  await expect(chip).toHaveText(/^Waiting/);
  await expect(chip).toHaveAttribute("href", "#decide");
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Confirm the baseline");
  await expect(page.getByRole("complementary", { name: "Run" }).filter({ visible: true })).toContainText("Confirm the baseline");
  await page.getByRole("link", { name: "Decide", exact: true }).click();
  await expect(page).toHaveURL(/#decide$/);
  await expect(page.locator("#decide")).toBeInViewport();

  // The baseline's artifacts can be read before deciding.
  const baseline = page.getByTestId("segment-baseline");
  await baseline.getByRole("button", { name: "baseline.yaml" }).click();
  await expect(page.getByTestId("artifact-content")).toContainText("confidence");

  // Requesting changes needs a note; the segment runs again.
  const cp = page.getByTestId("checkpoint-baseline_confirm");
  await expect(cp.getByRole("button", { name: "Request changes" })).toBeDisabled();
  await cp.getByLabel("Note for the agents").fill("Add a target for G2");
  await cp.getByRole("button", { name: "Request changes" }).click();
  await expect(baseline).toContainText("attempt 2");
  await expect(status(page)).toHaveText("Running");

  const segments = ["baseline", "feature_set", "priority", "prd_draft"];
  const checkpoints = ["baseline_confirm", "feature_set", "priority_order", "prd_review"];
  for (const [i, kind] of checkpoints.entries()) {
    await page.getByRole("button", { name: "Check agents now" }).click();
    const row = page.getByTestId(`segment-${segments[i]}`).getByTestId(`checkpoint-${kind}`).filter({ hasText: "Waiting" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Approve and continue" }).click();
    await expect(row).toHaveCount(0);
  }
  await expect(status(page)).toHaveText("Succeeded");
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText("Imported as team-onboarding v1");
  await prd.getByRole("link", { name: "team-onboarding v1" }).click();
  await expect(page).toHaveURL(/\/documents\/team-onboarding\/v\/1$/);
});

test("new run: knobs, estimate before start, skipped checkpoints", async ({ page }) => {
  await openRuns(page);
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "New run" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("runtime-notes")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Start run" })).toBeDisabled();

  await dialog.getByPlaceholder("new-prd-slug or an existing document").fill("billing-revamp");
  await dialog.getByLabel("Stop for Feature set and dependencies").uncheck();
  await dialog.getByLabel("Stop for Priority order").uncheck();
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$26.50");

  // Changing a knob clears the estimate until it is re-run.
  await dialog.getByLabel("Depth").selectOption("quick");
  await expect(dialog.getByTestId("estimate")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$13.25");

  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(status(page)).toHaveText("Running");
  await expect(page.getByTestId("segment-feature_set")).toContainText("Feature set and dependencies: off");

  await page.getByRole("button", { name: "Check agents now" }).click();
  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  // Feature set and priority order are off: two ticks run straight to the PRD draft.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("segment-feature_set").getByTestId("checkpoint-feature_set")).toContainText("Skipped");
  await page.getByRole("button", { name: "Check agents now" }).click();
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(page.getByTestId("checkpoint-prd_review")).toContainText("Waiting");
});

test("new run over $50 waits for an owner's approval", async ({ page }) => {
  await openRuns(page);
  await page.getByRole("button", { name: "New run" }).click();
  const dialog = page.getByRole("dialog", { name: "New run" });
  await dialog.getByPlaceholder("new-prd-slug or an existing document").fill("platform-prd");
  await dialog.getByLabel("Depth").selectOption("deep");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$53.00");
  await expect(dialog).toContainText("an owner approves the cost");
  await dialog.getByRole("button", { name: "Ask an owner to approve" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await expect(status(page)).toHaveText("Awaiting cost approval");
  await page.getByRole("button", { name: "Approve $53.00 and start" }).click();
  await expect(status(page)).toHaveText("Running");
});

/**
 * Seeds the mock with a run waiting at its PRD review whose draft Oracle refused at segment
 * end (the import error on the segment and in the checkpoint's payload). Returns its id.
 */
async function seedRejectedDraft(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type S = Record<string, unknown> & { seq: number; checkpoint: string };
    const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
    const id = "7a11c0de-0000-4000-8000-0000000000d1";
    const at = "2026-10-17T09:00:00Z";
    const error = "prd.md was rejected: [invalid_citation] citation #1 (o-g1) is invalid: source";
    const run = { ...JSON.parse(JSON.stringify(base)), id, document_slug: "guest-checkout", document_id: null, created_at: at, started_at: at };
    const segments: S[] = run.segments;
    for (const s of segments) {
      Object.assign(s, {
        id: crypto.randomUUID(),
        status: "succeeded",
        cost_usd: 1,
        attempts: [{ attempt: 1, workflow_id: `mock-wf-rej-${s.seq}`, submitted_at: at, cost_usd: 1, note: null, state: "succeeded" }],
      });
    }
    const draft = { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, source: null, prd_links: null };
    Object.assign(segments[3], { artifacts: ["prd.md"], draft_import: draft });
    run.checkpoints = segments.map((s) => {
      const open = s.seq === 4;
      return {
        id: crypto.randomUUID(),
        run_id: id,
        kind: s.checkpoint,
        status: open ? "pending" : "approved",
        approver_role: "approver",
        segment_seq: s.seq,
        decided_by: null,
        decided_at: open ? null : at,
        note: null,
        payload: open ? { segment_seq: 4, segment: "prd_draft", attempt: 1, artifacts: ["prd.md"], import: { error } } : {},
        created_at: at,
        can_decide: open,
      };
    });
    Object.assign(run, { status: "awaiting_checkpoint", waiting_on: "prd_review" });
    db.runs.runs.push(run);
    db.runs.artifacts[`${id}|4|prd.md`] = "---\ntitle: Guest checkout PRD\n---\n\n# Guest checkout PRD {#title}\n";
    localStorage.setItem(key, JSON.stringify(db));
    return id;
  });
}

test("a rejected draft: Retry import imports it, and the segment links the PRD", async ({ page }) => {
  await login(page);
  const id = await seedRejectedDraft(page);
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd).toContainText("Draft not imported: prd.md was rejected: [invalid_citation]");
  const retry = prd.getByRole("button", { name: "Retry import" });
  await expect(retry).toBeVisible();
  // Only the segment whose draft was refused offers it.
  await expect(page.getByRole("button", { name: "Retry import" })).toHaveCount(1);
  // The review cannot be approved without a draft; changes can still be requested.
  const review = prd.getByTestId("checkpoint-prd_review");
  await expect(review.getByRole("button", { name: "Approve and continue" })).toBeDisabled();
  await expect(review.getByTestId("cannot-approve")).toHaveText("The draft was not imported: retry import, or request changes.");
  await review.getByLabel("Note for the agents").fill("Fix the citations");
  await expect(review.getByRole("button", { name: "Request changes" })).toBeEnabled();

  await retry.click();
  await expect(prd).toContainText("Imported as guest-checkout v1");
  await expect(prd).not.toContainText("Draft not imported");
  await expect(retry).toHaveCount(0);
  // Nothing is decided: the review still waits for a person, who may approve it now.
  await expect(prd.getByTestId("checkpoint-waiting")).toBeVisible();
  await expect(status(page)).toHaveText("Waiting for review");
  await expect(review.getByRole("button", { name: "Approve and continue" })).toBeEnabled();
  await expect(review.getByTestId("cannot-approve")).toHaveCount(0);

  await prd.getByRole("link", { name: "guest-checkout v1" }).click();
  await expect(page).toHaveURL(/\/documents\/guest-checkout\/v\/1$/);
});

test("cancel a run: it asks in the page, never in a browser dialog; going back does nothing", async ({ page }) => {
  // UI test finding E5 (2026-10-20): a native confirm froze the tab for browser automation.
  const native: string[] = [];
  page.on("dialog", (d) => {
    native.push(d.message());
    void d.dismiss();
  });
  await openRuns(page);
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const before = await status(page).textContent();
  const cancel = page.getByTestId("run-cancel").filter({ visible: true });
  const ask = page.getByRole("alertdialog", { name: "Cancel run" });

  await cancel.click();
  await expect(ask).toContainText("Cancel this run? Agents still working are stopped.");
  await expect(ask.getByRole("button", { name: "Cancel run" })).toBeFocused();
  await ask.getByRole("button", { name: "Back" }).click();
  await expect(ask).toHaveCount(0);
  await expect(cancel).toBeFocused();
  // Escape is Back too.
  await cancel.click();
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await page.reload();
  await expect(status(page)).toHaveText(before!);
  await expect(cancel).toBeVisible();

  await cancel.click();
  await ask.getByRole("button", { name: "Cancel run" }).click();
  await expect(ask).toHaveCount(0);
  expect(native).toEqual([]);
  await expect(status(page)).toHaveText("Cancelled");
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Skipped");
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
});

test("mock run ids and times are stable: every page load, the runs list, the inbox and run detail agree", async ({ browser }) => {
  // Two fresh browsers seed the mock separately; the seeded runs keep their ids and times.
  const ids: Record<string, string>[] = [];
  const dates: string[] = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openRuns(page);
    const rows = page.getByTestId("run-row");
    await expect(rows).toHaveCount(4);
    const byRun: Record<string, string> = {};
    for (const row of await rows.all()) {
      const slug = (await row.getByRole("link").first().innerText()).trim();
      byRun[slug] = (await row.getByRole("link").first().getAttribute("href"))!;
    }
    ids.push(byRun);

    // The started run's dates, in its inspector.
    await rows.filter({ hasText: "team-onboarding" }).locator("td").nth(2).click();
    const inspector = page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
    await expect(inspector).toContainText("team-onboarding");
    await expect(inspector).toContainText("Started");
    dates.push(await inspector.innerText());

    // The inbox shows the same short ids as the list; run detail the same id.
    const short = (slug: string) => byRun[slug]!.split("/").pop()!.slice(0, 4);
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-approvals")).toContainText(short("usage-alerts-v2"));
    await expect(page.getByTestId("inbox-checkpoints")).toContainText(short("team-onboarding"));
    await page.goto(byRun["team-onboarding"]!);
    await expect(page.getByText(`Run ${short("team-onboarding")}`)).toBeVisible();
    await context.close();
  }
  expect(Object.keys(ids[0]!).sort()).toEqual(["checkout-redesign", "team-onboarding", "team-workspaces", "usage-alerts-v2"]);
  expect(ids[1]).toEqual(ids[0]);
  expect(dates[1]).toEqual(dates[0]);
});

import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
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

test("runs list shows each run with its status, and cost only on the approval and the overrun", async ({ page }) => {
  await openRuns(page);
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(5);
  const waiting = rows.filter({ hasText: "team-onboarding" });
  await expect(waiting).toContainText("Waiting for review");
  await expect(waiting).toContainText("Confirm the baseline");
  // P3d Cost prominence: no figure on a row that needs no cost decision.
  await expect(waiting).not.toContainText("$");
  const approval = rows.filter({ hasText: "usage-alerts-v2" });
  await expect(approval).toContainText("Awaiting cost approval");
  await expect(approval.locator('[data-cost="prominent"]')).toContainText("est.");
  const overrun = rows.filter({ hasText: "team-workspaces" });
  await expect(overrun).toContainText("Paused: over budget");
  await expect(overrun.locator('[data-cost="prominent"]')).toHaveText("$14.20 / $9.00");
});

test("run detail: approve each checkpoint through to the imported PRD", async ({ page }) => {
  await openRuns(page);
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(page.getByTestId("run-notes")).toContainText("Local agent runtime");
  // P3d Cost prominence: the cost is one small line in Details.
  await expect(page.getByTestId("run-details").getByTestId("run-cost")).toHaveText("$6.30 of $26.50 est.");

  // The open checkpoint: its state in the row (named once, in the decision and the inspector),
  // Decide as the page's primary action.
  const chip = page.getByTestId("segment-baseline").getByTestId("checkpoint-waiting");
  await expect(chip).toHaveText(/^Waiting/);
  await expect(chip).toHaveAttribute("href", "#decide");
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Confirm the baseline");
  await expect(page.getByRole("complementary", { name: "Run" }).filter({ visible: true })).toContainText("Confirm the baseline");
  await page.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(page).toHaveURL(/#decide$/);
  await expect(page.locator("#decide")).toBeInViewport();
  await expect(page.locator("#decide")).toBeFocused();

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

/**
 * C4: a Baseline to PRD run starts at New PRD (the brief, then Draft with Oracle on the
 * Before drafting page), no longer from Runs › New run. Rebuilding the baseline keeps the
 * whole flow, so its figures are the dialog's were.
 */
async function draftSheet(page: Page, title: string) {
  await login(page);
  await page.goto("/documents/new?kind=prd");
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Teams pay through a slow manual invoice. Billing should be self-serve.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  await sheet.getByRole("radio", { name: /^Rebuild it/ }).check();
  return sheet;
}

test("new run: knobs, estimate before start, skipped checkpoints", async ({ page }) => {
  const sheet = await draftSheet(page, "Billing revamp");
  await expect(sheet.getByRole("button", { name: "Start drafting" })).toBeDisabled();

  await sheet.getByRole("switch", { name: "Feature set and dependencies" }).uncheck();
  await sheet.getByRole("switch", { name: "Priority order" }).uncheck();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $26.50");

  // Changing a knob re-estimates the same draft run.
  await sheet.getByRole("group", { name: "Depth" }).getByRole("button", { name: "Quick" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toHaveText("Estimated $13.25");

  await sheet.getByRole("button", { name: "Start drafting" }).click();
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
  const sheet = await draftSheet(page, "Platform PRD");
  await sheet.getByRole("group", { name: "Depth" }).getByRole("button", { name: "Deep" }).click();
  await sheet.getByRole("button", { name: "Estimate" }).click();
  await expect(sheet.getByTestId("draft-estimate")).toContainText("Estimated $53.00");
  await expect(sheet.getByTestId("draft-estimate")).toContainText("Needs an owner's approval before it starts");
  await sheet.getByRole("button", { name: "Start drafting" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);

  await expect(status(page)).toHaveText("Awaiting cost approval");
  await page.getByRole("button", { name: "Approve $53.00 and start" }).click();
  await expect(status(page)).toHaveText("Running");
});

/**
 * Seeds the mock with a run waiting at its PRD review whose draft Oracle refused at segment
 * end (the import error on the segment and in the checkpoint's payload). Returns its id.
 */
async function seedRejectedDraft(page: Page, withProblems = false): Promise<string> {
  return page.evaluate((withProblems) => {
    const key = "po-mock-db-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    type S = Record<string, unknown> & { seq: number; checkpoint: string };
    const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
    const id = "7a11c0de-0000-4000-8000-0000000000d1";
    const at = "2026-10-17T09:00:00Z";
    let error = "prd.md was rejected: [invalid_citation] citation #1 (o-g1) is invalid: source";
    // As the API stores a refusal (oracle.runs.rejection): 24 citations of source 'x', cited 102 times.
    const problems: Record<string, unknown>[] = [];
    let summary: string | null = null;
    if (withProblems) {
      for (let i = 1; i <= 24; i++) {
        problems.push({ code: "invalid_citation", message: `citation #${i} (k${i}) is invalid: source 'x' isn't accepted`, section_key: null, cite_key: `k${i}`, line: null });
      }
      for (let s = 0; s < 34; s++) {
        for (let j = 0; j < 3; j++) {
          const key = `k${((s * 3 + j) % 24) + 1}`;
          problems.push({ code: "unknown_citation", message: `[c:${key}] in section 's${s}' is not defined in front matter 'citations'`, section_key: `s${s}`, cite_key: key, line: 80 + s * 4 });
        }
      }
      error = `prd.md was rejected: ${problems.map((p) => `[${p.code}] ${p.message}`).join("; ")}`;
      summary = "Oracle refused prd.md: 24 citations use source 'x', which isn't accepted; 102 references fail because of them.";
    }
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
    const draft = { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, problems, summary, source: null, prd_links: null };
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
        payload: open ? { segment_seq: 4, segment: "prd_draft", attempt: 1, artifacts: ["prd.md"], import: { error, problems, summary } } : {},
        created_at: at,
        can_decide: open,
      };
    });
    Object.assign(run, { status: "awaiting_checkpoint", waiting_on: "prd_review" });
    db.runs.runs.push(run);
    db.runs.artifacts[`${id}|4|prd.md`] = "---\ntitle: Guest checkout PRD\n---\n\n# Guest checkout PRD {#title}\n";
    localStorage.setItem(key, JSON.stringify(db));
    return id;
  }, withProblems);
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

const SUMMARY = "Oracle refused prd.md: 24 citations use source 'x', which isn't accepted; 102 references fail because of them.";

test("a rejected draft reads Draft rejected, with one summary line and every problem behind a disclosure", async ({ page }) => {
  await login(page);
  const id = await seedRejectedDraft(page, true);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  // The segment's state says the draft was refused, not Succeeded; the others did succeed.
  await expect(prd.getByTestId("segment-state")).toHaveText("Draft rejected");
  await expect(page.getByTestId("segment-baseline").getByTestId("segment-state")).toHaveText("Succeeded");
  // One plain line, grouped by cause, instead of the validator's 126 problems.
  await expect(prd.getByTestId("draft-rejected-summary")).toHaveText(SUMMARY);
  await expect(prd).not.toContainText("[unknown_citation]");
  // The raw list is collapsed; opened, one problem per line.
  const toggle = prd.getByRole("button", { name: "Show all 126 problems" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(prd.getByTestId("draft-problems")).toHaveCount(0);
  await toggle.click();
  const hide = prd.getByRole("button", { name: "Hide the problems" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  const list = prd.getByTestId("draft-problems");
  await expect(list.getByRole("listitem")).toHaveCount(126);
  await expect(list.getByRole("listitem").first()).toHaveText("citation #1 (k1) is invalid: source 'x' isn't accepted");
  await expect(list.getByRole("listitem").nth(24)).toHaveText("Line 80: [c:k1] in section 's0' is not defined in front matter 'citations'");
  await hide.click();
  await expect(prd.getByTestId("draft-problems")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The runs list says it too.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "guest-checkout" });
  await expect(row.getByTestId("run-draft-rejected")).toHaveText("Draft rejected");
  await expect(row.getByTestId("run-draft-rejected")).toHaveAttribute("title", SUMMARY);
  await expect(page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByTestId("run-draft-rejected")).toHaveCount(0);
});

test("a rejected draft: Send back to writer pre-fills Request changes with the summary", async ({ page }) => {
  await login(page);
  const id = await seedRejectedDraft(page, true);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  const review = prd.getByTestId("checkpoint-prd_review");
  const note = review.getByLabel("Note for the agents");
  await expect(note).toHaveValue("");
  await prd.getByRole("button", { name: "Send back to writer" }).click();
  // The Request changes flow, opened with the summary as its note, ready to edit.
  await expect(note).toHaveValue(SUMMARY);
  await expect(note).toBeFocused();
  await expect(note).toBeInViewport();
  await note.press("End");
  await note.pressSequentially(" Use source 'oracle'.");
  await expect(note).toHaveValue(`${SUMMARY} Use source 'oracle'.`);
  // Nothing is sent until the person sends it.
  await expect(status(page)).toHaveText("Waiting for review");
  await review.getByRole("button", { name: "Request changes" }).click();
  await expect(prd).toContainText("attempt 2");
  await expect(status(page)).toHaveText("Running");
});

test("Decide scrolls to the decision panel and focuses it", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 520 });
  await login(page);
  const id = await seedRejectedDraft(page, true);
  await page.goto(`/runs/${id}`);
  const panel = page.getByTestId("segment-prd_draft").getByTestId("checkpoint-prd_review");
  await expect(panel).not.toBeInViewport();
  await page.getByRole("button", { name: "Decide", exact: true }).click();
  await expect(panel).toBeInViewport();
  await expect(panel).toBeFocused();
  await expect(page).toHaveURL(/#decide$/);
  // Its actions follow in tab order.
  await page.keyboard.press("Tab");
  await expect(panel.getByLabel("Note for the agents")).toBeFocused();
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
  // Destructive: Back has the focus, so Enter right after it opens does not cancel.
  await expect(ask.getByRole("button", { name: "Back" })).toBeFocused();
  await expect(ask.getByRole("button", { name: "Cancel run" })).toHaveAttribute("data-variant", "danger");
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  await expect(status(page)).toHaveText(before!);
  await cancel.click();
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
    await expect(rows).toHaveCount(5);
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
  expect(Object.keys(ids[0]!).sort()).toEqual(["checkout-redesign", "saved-carts", "team-onboarding", "team-workspaces", "usage-alerts-v2"]);
  expect(ids[1]).toEqual(ids[0]);
  expect(dates[1]).toEqual(dates[0]);
});

test("a decision SwarmCloud has not taken yet: recorded, shown as delivering, final, then delivered", async ({ page }) => {
  // Owner decision 2026-10-20: the decision is recorded before SwarmCloud is told. Here
  // SwarmCloud takes nothing until the next tick, so the decide call answers 503.
  await page.addInitScript((key) => localStorage.setItem(key, "undelivered"), MOCK_SCENARIO_KEY);
  await openRuns(page);
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await expect(page.getByTestId("checkpoint-baseline_confirm")).toContainText("Waiting");
  // A second tab on the same run, still showing the open review (another approver, say).
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(other.getByTestId("checkpoint-baseline_confirm")).toContainText("Waiting");

  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  // The page re-reads the run: the review is approved, delivering, with why it waits. That
  // says what the 503 said, so no error is drawn as well.
  const segment = page.getByTestId("segment-baseline");
  const delivering = segment.getByTestId("checkpoint-delivering");
  await expect(delivering).toHaveCount(1);
  await expect(delivering).toContainText(
    "Approved by admin@example.com, delivering to the run… (1 try, last: SwarmCloud HTTP 503 unavailable)",
  );
  await expect(page.getByRole("alert").filter({ hasText: "did not confirm" })).toHaveCount(0);
  // Decided: one fewer waiting on me (10 in the seeded company); the delivery is not counted.
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("9");
  await expect(segment.getByTestId("checkpoint-baseline_confirm")).toContainText("Approved");
  await expect(segment.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);

  // The other tab decides too: a recorded decision is final (409), and it re-reads the run.
  const stale = other.getByTestId("checkpoint-baseline_confirm");
  await stale.getByLabel("Note for the agents").fill("Add a target for G2");
  await stale.getByRole("button", { name: "Request changes" }).click();
  await expect(other.getByRole("alert").filter({ hasText: "already decided" })).toBeVisible();
  await expect(other.getByTestId("segment-baseline").getByTestId("checkpoint-delivering")).toContainText("Approved by admin@example.com");
  await other.close();

  // The tick delivers it: the line goes, the review reads approved, the run goes on.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(delivering).toHaveCount(0);
  await expect(segment.getByTestId("checkpoint-baseline_confirm")).toContainText("Approved");
  await expect(status(page)).toHaveText("Running");
});

test("a run delivering a decision reads Delivering decision: header, side panel and runs list", async ({ page }) => {
  // Owner decision 2026-10-20: amber, with a clock, as other in-progress states.
  await page.addInitScript((key) => localStorage.setItem(key, "undelivered"), MOCK_SCENARIO_KEY);
  await openRuns(page);
  await page.getByTestId("run-row").filter({ hasText: "team-onboarding" }).getByRole("link").click();
  await page.getByTestId("checkpoint-baseline_confirm").getByRole("button", { name: "Approve and continue" }).click();
  await expect(page.getByTestId("segment-baseline").getByTestId("checkpoint-delivering")).toBeVisible();

  const amber = (scope: Page | ReturnType<Page["getByTestId"]>) =>
    scope.locator('[data-kind="warn"]').filter({ has: page.getByTestId("run-status") });
  // The header chip.
  await expect(status(page)).toHaveText("Delivering decision");
  await expect(amber(page).filter({ visible: true }).locator("svg")).toHaveCount(1);
  // The side panel.
  const panel = page.getByRole("complementary", { name: "Run" }).filter({ visible: true });
  await expect(panel).toContainText("Run · delivering decision");
  await expect(panel).not.toContainText("waiting for review");
  // The runs list: the row's chip.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "team-onboarding" });
  await expect(row.getByTestId("run-status")).toHaveText("Delivering decision");
  await expect(amber(row).locator("svg")).toHaveCount(1);
  await expect(row).not.toContainText("Waiting for review");
  // Nothing to decide on it: no Decide, and the list's waiting counts leave it out.
  await expect(row.getByRole("button", { name: "Decide" })).toHaveCount(0);
  await expect(page.getByText("1 checkpoint")).toHaveCount(0);

  // Delivered: the run reads Running again.
  await row.getByRole("link").first().click();
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(status(page)).toHaveText("Running");
});

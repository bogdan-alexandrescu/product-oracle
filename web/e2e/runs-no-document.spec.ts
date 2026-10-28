import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { NO_DOCUMENT_RUN } from "../lib/api/mock/runs";
import { login } from "./helpers";

// Owner decisions, 2026-10-25: a run that finished with no document (its review approved
// past a refused draft) gets an Inbox row with a plain reason and the action to take; its
// Draft rejected chip clears once it succeeded; an owner's retry is shown in the version's
// history as "imported again by" them; and once another segment imported a version, the
// refused segment says why it cannot be retried and offers a new run. #583 review: the row
// clears itself once a later run imports the document, and runs that finished before it
// shipped get none (the "no-document" scenario reaches them without writing the mock's state).

const ID = "7a11c0de-0000-4000-8000-0000000000e1";

/** A succeeded run whose PRD draft was refused and whose review was approved anyway. */
async function seedFinishedWithoutDocument(page: Page, otherImported = false): Promise<string> {
  await page.goto("/icon.svg");
  return page.evaluate(
    ({ id, otherImported }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      type S = Record<string, unknown> & { seq: number; checkpoint: string };
      const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
      const at = "2026-10-17T09:00:00Z";
      const error = "prd.md was rejected: [invalid_citation] citation #1 (o-g1) is invalid: source";
      const summary = "Oracle refused prd.md: 1 citation uses source 'o', which isn't accepted.";
      const run = {
        ...JSON.parse(JSON.stringify(base)),
        id,
        document_slug: "guest-checkout",
        document_id: null,
        status: "succeeded",
        waiting_on: null,
        created_at: at,
        started_at: at,
        finished_at: at,
      };
      const segments: S[] = run.segments;
      for (const s of segments) {
        Object.assign(s, {
          id: crypto.randomUUID(),
          status: "succeeded",
          cost_usd: 1,
          attempts: [{ attempt: 1, workflow_id: `mock-wf-nodoc-${s.seq}`, submitted_at: at, cost_usd: 1, note: null, state: "succeeded" }],
        });
      }
      const refused = { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, problems: [], summary, source: null, prd_links: null };
      Object.assign(segments[3], { artifacts: ["prd.md"], draft_import: refused });
      if (otherImported) {
        const imported = { document_id: crypto.randomUUID(), slug: "guest-checkout", kind: "prd", version: 1, created: true, warnings: [], error: null, problems: [], summary: null, source: null, prd_links: null };
        Object.assign(segments[2], { draft_import: imported });
      }
      run.checkpoints = segments.map((s) => ({
        id: crypto.randomUUID(),
        run_id: id,
        kind: s.checkpoint,
        status: "approved",
        approver_role: "approver",
        segment_seq: s.seq,
        decided_by: null,
        decided_at: at,
        note: null,
        payload: s.seq === 4 ? { segment_seq: 4, segment: "prd_draft", attempt: 1, artifacts: ["prd.md"], import: { error, problems: [], summary } } : {},
        created_at: at,
        can_decide: false,
      }));
      db.runs.runs.push(run);
      db.runs.artifacts[`${id}|4|prd.md`] = "---\ntitle: Guest checkout PRD\n---\n\n# Guest checkout PRD {#title}\n";
      localStorage.setItem(key, JSON.stringify(db));
      return id;
    },
    { id: ID, otherImported },
  );
}

/**
 * The "no-document" scenario (#583 review): guest-checkout's run finished with no document
 * just now, old-checkout's on Oct 1, before the No document row shipped. The clock is set
 * past that day, as the API's NO_DOCUMENT_SINCE.
 */
async function noDocumentScenario(page: Page) {
  await page.clock.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  await page.addInitScript((key) => localStorage.setItem(key, "no-document"), MOCK_SCENARIO_KEY);
  await login(page);
}

/**
 * No No document row in the Inbox: in New, nor in Open, where a row seen on an earlier visit
 * moves (the Inbox's own data loaded first, so an empty list is not one still loading).
 */
async function noRowInTheInbox(page: Page) {
  await page.getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  const tabs = page.getByTestId("inbox-state-tabs").filter({ visible: true });
  for (const tab of [/^New/, /^Open/]) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(tabs.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("inbox-no-document")).toHaveCount(0);
  }
}

test("a run that finished with no document: an Inbox row says why and what to do, and the run reads no Draft rejected", async ({ page }) => {
  await noDocumentScenario(page);
  await page.goto("/inbox");
  const row = page.getByTestId("inbox-no-document");
  // The run from before the row shipped gets none.
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("guest-checkout finished without a document: Oracle refused its draft");
  await expect(row).toContainText("Retry import");

  // The runs list: Succeeded, with no Draft rejected chip.
  await page.getByTestId("nav-runs").click();
  const listed = page.locator('[data-testid="run-row"][data-document="guest-checkout"]');
  await expect(listed).toContainText("Succeeded");
  await expect(listed.getByTestId("run-draft-rejected")).toHaveCount(0);

  // Retry import on the run imports it and clears the row; the version's history says who
  // imported it again.
  // The first visit's page stays in the DOM, hidden: only the row shown counts.
  await page.getByTestId("nav-inbox").click();
  const seen = page.getByTestId("inbox-no-document").filter({ visible: true });
  await page.getByRole("row").filter({ has: seen }).getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${NO_DOCUMENT_RUN}$`));
  const prd = page.getByTestId("segment-prd_draft").filter({ visible: true });
  await prd.getByRole("button", { name: "Retry import" }).click();
  await expect(prd).toContainText("Imported as guest-checkout v");
  await noRowInTheInbox(page);
  await page.goto("/documents/guest-checkout");
  const again = page.getByTestId("version-inspector").getByTestId("version-imported-again");
  await expect(again).toHaveText(/^imported again by .+ on \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
});

test("the No document row clears itself once a later run imports the document", async ({ page }) => {
  await noDocumentScenario(page);
  // In-app navigation keeps the pages left behind in the DOM, hidden (cacheComponents): Home's
  // Needs you draws the same row, and the finished run's page the same segment. Only what is
  // shown counts.
  await page.getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  const row = page.getByTestId("inbox-no-document").filter({ visible: true });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("or start a new run");

  // The owner follows the advice: a new run of the same document, from the finished run.
  await page.getByRole("row").filter({ has: row }).getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${NO_DOCUMENT_RUN}$`));
  await page.getByTestId("segment-prd_draft").filter({ visible: true }).getByRole("button", { name: "Start a new run" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("PRD document")).toHaveValue("guest-checkout");
  // Only the PRD review stops: the other stops are switched off.
  const stops = dialog.getByRole("checkbox", { name: /^Stop for / });
  await expect(stops.first()).toBeVisible();
  for (const stop of await stops.all()) {
    if (!/PRD review/.test((await stop.getAttribute("aria-label")) ?? "")) await stop.uncheck();
  }
  await expect(dialog.getByRole("checkbox", { name: "Stop for PRD review" })).toBeChecked();
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).not.toHaveURL(new RegExp(NO_DOCUMENT_RUN));
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  const runUrl = page.url();

  // The agents run to the PRD review, which is decided in the version its draft made.
  const prd = page.getByTestId("segment-prd_draft").filter({ visible: true });
  const review = prd.getByTestId("checkpoint-prd_review").filter({ hasText: "Waiting" });
  await expect(async () => {
    await page.getByRole("button", { name: "Check agents now" }).click();
    await expect(review).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await review.getByRole("link", { name: "Open review" }).click();
  await expect(page).toHaveURL(/\/documents\/guest-checkout\/v\/1\?run_review=/);
  const bar = page.getByTestId("run-review-bar").filter({ visible: true });
  await bar.getByRole("button", { name: "Approve draft" }).click();
  await bar.getByRole("group", { name: "Confirm Approve draft" }).getByRole("button", { name: "Approve draft" }).click();
  await expect(bar).toContainText("Approved");
  await page.goto(runUrl);
  await expect(page.getByTestId("segment-prd_draft")).toContainText("Imported as guest-checkout v1");

  // The finished run's row is gone, with nobody dismissing it.
  await noRowInTheInbox(page);
});

test("once another segment imported a version, the refused one says why in plain words and offers a new run", async ({ page }) => {
  await login(page);
  await seedFinishedWithoutDocument(page, true);
  await page.goto(`/runs/${ID}`);
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByRole("button", { name: "Retry import" })).toHaveCount(0);
  await expect(prd.getByTestId("draft-retry-refused")).toContainText("already imported guest-checkout v1");
  await prd.getByRole("button", { name: "Start a new run" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("PRD document")).toHaveValue("guest-checkout");
  // Not a run that needs a person: no Inbox row.
  await page.goto("/inbox");
  await expect(page.getByTestId("inbox-no-document")).toHaveCount(0);
});

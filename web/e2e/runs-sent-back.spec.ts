import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers";

/**
 * A refused draft goes back to the writer before a person is asked (owner, 2026-10-20). While
 * Oracle's own NOT_YET has the revision running, the run reads "Revising: sent back by Oracle",
 * not "Draft rejected", and the Inbox shows that state, not a decision request. A clean
 * revision clears it: the review opens for a person with the draft imported.
 */

const ID = "7a11c0de-0000-4000-8000-0000000000e1";
const SUMMARY = "Oracle refused prd.md: 2 citations use source 'jira', which isn't accepted; 3 references fail because of them.";
const REVISING = "Revising: sent back by Oracle";

/** The run's status badge (Next keeps the list page mounted but hidden). */
function status(page: Page) {
  return page.getByTestId("run-status").filter({ visible: true });
}

/**
 * Seeds the mock with a run whose PRD draft Oracle refused at import and sent back to the
 * writer itself: no checkpoint stands for that review, the revision runs as attempt 2 with
 * Oracle's findings, and the refused import stays on the segment until the revision lands.
 */
async function seedSentBack(page: Page): Promise<string> {
  return page.evaluate(
    ({ id, summary }) => {
      const key = "po-mock-db-v2";
      const db = JSON.parse(localStorage.getItem(key)!);
      type S = Record<string, unknown> & { seq: number; checkpoint: string };
      const base = db.runs.runs.find((r: { document_slug: string }) => r.document_slug === "team-onboarding");
      const at = "2026-10-17T09:00:00Z";
      const wf = "mock-wf-sent-back";
      // As the API stores the refusal: two citations of source 'jira', cited three times.
      const problems: Record<string, unknown>[] = [
        { code: "invalid_citation", message: "citation #1 (j1) is invalid: source 'jira' isn't accepted", section_key: null, cite_key: "j1", line: null },
        { code: "invalid_citation", message: "citation #2 (j2) is invalid: source 'jira' isn't accepted", section_key: null, cite_key: "j2", line: null },
        { code: "unknown_citation", message: "[c:j1] in section 'problem' is not defined in front matter 'citations'", section_key: "problem", cite_key: "j1", line: 14 },
        { code: "unknown_citation", message: "[c:j2] in section 'problem' is not defined in front matter 'citations'", section_key: "problem", cite_key: "j2", line: 14 },
        { code: "unknown_citation", message: "[c:j1] in section 'goals' is not defined in front matter 'citations'", section_key: "goals", cite_key: "j1", line: 20 },
      ];
      const error = `prd.md was rejected: ${problems.map((p) => `[${p.code}] ${p.message}`).join("; ")}`;
      const run = { ...JSON.parse(JSON.stringify(base)), id, document_slug: "guest-checkout", document_id: null, created_at: at, started_at: at };
      const segments: S[] = run.segments;
      for (const s of segments) {
        Object.assign(s, {
          id: crypto.randomUUID(),
          status: "succeeded",
          cost_usd: 1,
          attempts: [{ attempt: 1, workflow_id: wf, submitted_at: at, cost_usd: 1, note: null, note_by: null, state: "succeeded" }],
        });
      }
      const findings = [
        "Oracle could not import prd.md as the document's next version, so it sent the draft back before a person reviews it.",
        "Citations: citation #1 (j1) is invalid: source 'jira' isn't accepted; citation #2 (j2) is invalid: source 'jira' isn't accepted.",
      ].join("\n");
      Object.assign(segments[3], {
        status: "running",
        artifacts: ["prd.md"],
        draft_import: { document_id: null, slug: null, kind: null, version: null, created: null, warnings: [], error, problems, summary, source: null, prd_links: null },
      });
      (segments[3].attempts as unknown[]).push({ attempt: 2, workflow_id: wf, submitted_at: at, cost_usd: 0, note: findings, note_by: "Oracle", state: "running" });
      // Oracle answered the PRD review itself: no checkpoint stands for it.
      run.checkpoints = segments.slice(0, 3).map((s) => ({
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
        cannot_approve: null,
      }));
      Object.assign(run, { status: "running", waiting_on: null });
      db.runs.runs.push(run);
      db.runs.artifacts[`${id}|4|prd.md`] = "---\ntitle: Guest checkout PRD\n---\n\n# Guest checkout PRD {#title}\n";
      localStorage.setItem(key, JSON.stringify(db));
      return id;
    },
    { id: ID, summary: SUMMARY },
  );
}

test("a draft Oracle sent back reads Revising on the run page and the runs list, with nothing to decide", async ({ page }) => {
  await login(page);
  const id = await seedSentBack(page);
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
  await expect(status(page)).toHaveText("Running");

  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByTestId("segment-state")).toHaveText(REVISING);
  await expect(prd).not.toContainText("Draft rejected");
  await expect(prd).toContainText("attempt 2");
  // What Oracle refused, as context: the same summary, its problems behind the disclosure.
  const sentBack = prd.getByTestId("draft-sent-back");
  await expect(sentBack.getByTestId("draft-sent-back-summary")).toHaveText(SUMMARY);
  await expect(sentBack).toContainText("Oracle sent the draft back to the writer");
  await expect(prd.getByTestId("draft-rejected")).toHaveCount(0);
  await sentBack.getByRole("button", { name: "Show all 5 problems" }).click();
  await expect(sentBack.getByTestId("draft-problems").getByRole("listitem")).toHaveCount(5);
  // Nothing to decide or retry: no checkpoint waits, no Retry import, no Send back to writer.
  await expect(prd.getByTestId("checkpoint-waiting")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Decide", exact: true })).toHaveCount(0);
  await expect(prd.getByRole("button", { name: "Retry import" })).toHaveCount(0);
  await expect(prd.getByRole("button", { name: "Send back to writer" })).toHaveCount(0);

  // The runs list says Revising too, with the summary on hover, and no Draft rejected.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "guest-checkout" });
  await expect(row.getByTestId("run-sent-back")).toHaveText("Revising");
  await expect(row.getByTestId("run-sent-back")).toHaveAttribute("title", `${REVISING}. ${SUMMARY}`);
  await expect(row.getByTestId("run-draft-rejected")).toHaveCount(0);
});

test("the Inbox shows a draft Oracle sent back as Revising, not a decision, and does not count it", async ({ page }) => {
  await login(page);
  await seedSentBack(page);
  await page.goto("/inbox");
  const tabs = page.getByTestId("inbox-state-tabs");
  // The seed's 10 waiting, unchanged: nothing of this run asks for a decision.
  await expect(page.getByText("10 waiting").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("nav-inbox-badge")).toHaveText("10");
  await expect(tabs.getByRole("tab", { name: /^New/ })).toHaveText("New10");
  await expect(page.getByTestId("inbox-checkpoints")).not.toContainText("guest-checkout");
  await expect(page.getByTestId("inbox-revising")).toHaveCount(0);

  // Under Open, shown and not counted, as the run page shows it.
  await tabs.getByRole("tab", { name: /^Open/ }).click();
  await expect(tabs.getByRole("tab", { name: /^Open/ })).toHaveText("Open0");
  const revising = page.getByTestId("inbox-revising");
  await expect(revising.locator("tr[data-row]")).toHaveCount(1);
  const item = revising.getByTestId("inbox-revising-state");
  await expect(item).toHaveText(REVISING);
  await expect(item).toHaveAttribute("title", SUMMARY);
  await expect(revising).toContainText("guest-checkout");
  await expect(revising.getByRole("button")).toHaveCount(0);
  await revising.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${ID}$`));
  await expect(page.getByTestId("segment-prd_draft").getByTestId("segment-state")).toHaveText(REVISING);
});

test("a clean revision clears Revising: the draft is imported and the review waits for a person", async ({ page }) => {
  await login(page);
  const id = await seedSentBack(page);
  await page.goto(`/runs/${id}`);
  const prd = page.getByTestId("segment-prd_draft");
  await expect(prd.getByTestId("segment-state")).toHaveText(REVISING);

  // The writer's revision finishes; Oracle imports it as the review opens.
  await page.getByRole("button", { name: "Check agents now" }).click();
  await expect(prd).toContainText("Imported as guest-checkout v1");
  await expect(prd.getByTestId("segment-state")).toHaveText("Succeeded");
  await expect(prd.getByTestId("draft-sent-back")).toHaveCount(0);
  await expect(prd).not.toContainText("Revising");
  await expect(status(page)).toHaveText("Waiting for review");
  const review = prd.getByTestId("checkpoint-prd_review");
  await expect(prd.getByTestId("checkpoint-waiting")).toBeVisible();
  await expect(review.getByRole("button", { name: "Approve and continue" })).toBeEnabled();
  await expect(review.getByTestId("cannot-approve")).toHaveCount(0);

  // The Inbox: the review is a decision now, counted; the Revising row is gone.
  await page.goto("/inbox");
  await expect(page.getByText("11 waiting").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("inbox-checkpoints")).toContainText("guest-checkout");
  await page.getByTestId("inbox-state-tabs").getByRole("tab", { name: /^Open/ }).click();
  await expect(page.getByTestId("inbox-revising")).toHaveCount(0);

  // The runs list: neither Revising nor Draft rejected.
  await page.getByTestId("nav-runs").click();
  const row = page.getByTestId("run-row").filter({ hasText: "guest-checkout" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("run-sent-back")).toHaveCount(0);
  await expect(row.getByTestId("run-draft-rejected")).toHaveCount(0);
});

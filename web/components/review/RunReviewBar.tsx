"use client";

import { useState } from "react";

import { Button, Sheet } from "@/components/ds";
import { api, ApiError, unwrap } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * D10: the run review bar of a version a run's draft made (one review place). The run's
 * PRD or roadmap review is decided here: Approve draft (an inline confirmation names the
 * unreviewed sections) and Send back to agents (a sheet listing what goes, the document's
 * own feedback, and an optional note). Commenters and viewers read it only; when the review
 * policy names a designated decider, only they decide and others read who does. Hidden when no
 * run review points at this version (404).
 */
export function RunReviewBar({ doc, n, refreshKey, onDecided }: { doc: string; n: number; refreshKey: string; onDecided: () => void }) {
  const { role } = useMe();
  const q = useQuery(
    `run-review|${doc}|${n}|${refreshKey}`,
    async () => {
      try {
        return await unwrap(api.GET("/v1/documents/{doc}/versions/{n}/run-review", { params: { path: { doc, n } } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    { keepPrevious: true },
  );
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = q.data;
  if (!r) return null;

  const { total, reviewed } = r.sections;
  const unreviewed = total - reviewed;
  const deciding = r.status === "pending" && r.can_decide && hasRole(role, r.approver_role);
  const hours = r.wait.state === "open" && r.wait.seconds_left != null ? Math.max(1, Math.round(r.wait.seconds_left / 3600)) : null;

  async function decide(decision: "approved" | "changes_requested", text?: string) {
    if (!r) return;
    setSaving(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          params: { path: { run_id: r.run_id, checkpoint_id: r.checkpoint_id } },
          body: { decision, note: text?.trim() || null },
        }),
      );
      setConfirming(false);
      setSending(false);
      setNote("");
      await q.reload();
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decide.");
    } finally {
      setSaving(false);
    }
  }

  const state =
    r.status === "approved" ? "Approved" : r.status === "changes_requested" ? "Sent back to agents" : r.status === "pending" ? null : r.status.replace("_", " ");

  return (
    <section
      data-testid="run-review-bar"
      aria-label="Run review"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-button border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-accent-ink"
    >
      <p className="min-w-0 flex-1 font-medium" data-testid="run-review-text">
        Run review · {r.flow_title} · draft v{n} · {reviewed} of {total} sections reviewed
        {hours != null && state == null && <> · {hours} h left</>}
        {state && <b className="font-semibold"> · {state}</b>}
      </p>
      {r.status === "pending" && !deciding && (
        <span className="text-text2">{r.decider_name ? `${r.decider_name} decides (designated decider)` : "An approver decides"}</span>
      )}
      {deciding && !confirming && (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" icon="back" onClick={() => setSending(true)}>
            Send back to agents
          </Button>
          <Button variant="primary" icon="check" disabled={saving} onClick={() => (unreviewed > 0 ? setConfirming(true) : decide("approved"))}>
            Approve draft
          </Button>
        </div>
      )}
      {deciding && confirming && (
        <div className="flex basis-full flex-wrap items-center justify-end gap-2" role="group" aria-label="Confirm Approve draft">
          <span className="min-w-0 flex-1 font-semibold text-text">
            {plural(unreviewed, "section")} {unreviewed === 1 ? "isn't" : "aren't"} reviewed yet. The run&apos;s review ends; they stay open for review and the next draft.
          </span>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="primary" icon="check" disabled={saving} onClick={() => decide("approved")} autoFocus>
            Approve draft
          </Button>
        </div>
      )}
      {error && !sending && (
        <p role="alert" className="basis-full text-sm font-medium text-crit">
          {error}
        </p>
      )}
      <Sheet open={sending} title="Send back to agents" onClose={() => setSending(false)} testId="send-back-sheet">
        <div className="flex flex-col gap-3 p-4 text-sm">
          <p data-testid="send-back-counts" className="font-medium text-text">
            {plural(r.feedback.open, "open feedback item")} · {plural(r.feedback.staged, "staged change")} · {plural(r.feedback.verdicts, "section")} with
            Request changes or Reject
          </p>
          <p className="text-text2">The agents write the next draft from these; approved sections stay as they are.</p>
          <label className="flex flex-col gap-1 font-medium text-text">
            Note to the agents (optional)
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-button border border-line bg-surface px-3 py-2 font-normal"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm font-medium text-crit">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSending(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => decide("changes_requested", note)}>
              Send back
            </Button>
          </div>
        </div>
      </Sheet>
    </section>
  );
}

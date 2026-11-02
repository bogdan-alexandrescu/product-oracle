"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ds/Icon";
import { api, ApiError, unwrap } from "@/lib/api/client";
import { calendarDay, dayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

/** "Fri Oct 30": a moment's day in the company's zone. */
function dayWords(at: string, zone: string) {
  return calendarDay(dayIn(at, zone), { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

/** "Usage alerts plan" for the Usage alerts PRD (as Simple › Decisions names a run). */
export function runName(title: string) {
  return `${title.trim().replace(/\s+PRD$/i, "")} plan`;
}

const BOX = "rounded-[14px] border border-line bg-surface p-4 shadow-sm";

/**
 * build-rundecide RD2 b "Separate Approve step": a run's PRD review on the Simple PRD page.
 * Approving the review lets the run go on (an optional note the run's next steps read); right
 * after, the run's next stop asks to approve the PRD as its own step ("Approve the PRD"), and the
 * status by the title then reads Approved. To change the PRD first, Start a review meeting stays above.
 * Shown to whoever decides the review, then to whoever may approve the PRD; hidden otherwise.
 */
export function RunReviewStep({ doc, title, n, approved, onState, onApproved }: { doc: string; title: string; n: number; approved: boolean; onState?: (s: "waiting" | "done" | null) => void; onApproved: () => void }) {
  const { can, me } = useMe();
  const zone = useCompanyZone();
  const q = useQuery(
    `simple-run-review|${doc}|${n}`,
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
  const r = q.data ?? null;
  const runId = r?.status === "approved" ? r.run_id : null;
  const decisions = useQuery(`simple-run-review-decided|${runId ?? "none"}`, async () => (runId ? unwrap(api.GET("/v1/runs/{run_id}/decisions", { params: { path: { run_id: runId } } })) : null));
  const [box, setBox] = useState<null | "approve" | "send">(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The PRD's status by the title follows the run: In review while its review or the PRD's approval waits.
  const state = done ? "done" : r && !approved && (r.status === "pending" || r.status === "approved") ? "waiting" : null;
  useEffect(() => onState?.(state), [state, onState]);
  if (!r) return null;
  const name = runName(title);
  const you = me?.name?.trim() || me?.email || "you";

  async function decide(decision: "approved" | "changes_requested") {
    if (!r) return;
    setSaving(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          params: { path: { run_id: r.run_id, checkpoint_id: r.checkpoint_id } },
          body: { decision, note: note.trim() || null },
        }),
      );
      setBox(null);
      setNote("");
      await q.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decide.");
    } finally {
      setSaving(false);
    }
  }

  async function approvePrd() {
    setSaving(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/approve", { params: { path: { doc, n } } }));
      setDone(new Date().toISOString());
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve the PRD.");
    } finally {
      setSaving(false);
    }
  }

  const errorLine = error && (
    <p role="alert" className="simple-small mt-2 text-crit">
      {error}
    </p>
  );

  if (done) {
    return (
      <section className={BOX} aria-label="The run's PRD review" data-testid="run-review-step">
        <p className="flex items-start gap-2.5">
          <span className="simple-ico simple-ico-done" aria-hidden>
            <Icon name="check" size={20} stroke={1.7} />
          </span>
          <span className="simple-rb">
            <b className="font-[650]">You approved the PRD, version {n}.</b>
            <span className="simple-meta">
              Second of two steps · {name} goes on to its dates · {you} · {dayWords(done, zone)}
            </span>
          </span>
        </p>
      </section>
    );
  }

  if (r.status === "approved") {
    if (approved || !can("approve_version")) return null;
    const mine = decisions.data?.filter((d) => d.checkpoint_id === r.checkpoint_id)[0];
    const by = mine?.decided_by_name ? (mine.decided_by_name === me?.name || mine.decided_by_name === me?.email ? `you (${mine.decided_by_name})` : mine.decided_by_name) : null;
    return (
      <section className={BOX} aria-label="The run's PRD review" data-testid="run-review-step">
        <p className="simple-meta inline-flex flex-wrap items-center gap-1.5" data-testid="run-review-approved">
          <Icon name="check" size={16} stroke={1.7} />
          <span>
            {["Run review approved", by && `by ${by}`].filter(Boolean).join(" ")}
            {mine?.decided_at ? ` · ${dayWords(mine.decided_at, zone)}` : ""}
          </span>
        </p>
        <h2 className="simple-h2 mt-2">Next stop: approve the PRD</h2>
        <p className="simple-small">Approving makes version {n} the PRD everyone builds from. To change it first, use Start a review meeting above.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="simple-button simple-button-primary" disabled={saving} onClick={() => void approvePrd()}>
            Approve the PRD
          </button>
        </div>
        {errorLine}
      </section>
    );
  }

  const deciding = r.status === "pending" && r.can_decide && can("decide_checkpoint", r.can_decide);
  if (!deciding) return null;
  return (
    <section className={BOX} aria-label="The run's PRD review" data-testid="run-review-step">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-[260px] flex-1">
          <b className="font-[650]">
            {name} waits for your review of version {n}.
          </b>
          <span className="simple-meta block">Approving lets the run go on. Approving the PRD comes right after, as its own step.</span>
        </p>
        <button type="button" className="simple-button" onClick={() => setBox("send")} aria-expanded={box === "send"}>
          Send back
        </button>
        <button type="button" className="simple-button simple-button-primary" onClick={() => setBox("approve")} aria-expanded={box === "approve"}>
          Approve
        </button>
      </div>
      {box && (
        <div className="mt-3 rounded-[12px] border border-line-strong bg-surface2 p-3" role="dialog" aria-label={box === "approve" ? "Approve the review" : "Send back the review"}>
          <label className="simple-small block font-[650]" htmlFor="run-review-note">
            {box === "approve" ? "Note for the run (optional)" : "What should change"}
          </label>
          <textarea id="run-review-note" className="mt-1 w-full rounded-lg border border-line-strong bg-surface p-2 text-[15px]" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="simple-small mt-2">
            {box === "approve" ? "This approves the run's review. Next you are asked to approve the PRD." : "The run's agents get your note and write the PRD again."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="simple-button simple-button-primary"
              disabled={saving || (box === "send" && !note.trim())}
              onClick={() => void decide(box === "approve" ? "approved" : "changes_requested")}
            >
              {box === "approve" ? "Approve review" : "Send back"}
            </button>
            <button
              type="button"
              className="simple-button simple-button-quiet"
              onClick={() => {
                setBox(null);
                setNote("");
              }}
            >
              Cancel
            </button>
          </div>
          {errorLine}
        </div>
      )}
    </section>
  );
}

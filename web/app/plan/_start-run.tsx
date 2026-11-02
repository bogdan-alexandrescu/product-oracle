"use client";

/*
 * Starting a paid run (QD2 a, confirm in a dialog): every button that starts a roadmap run
 * (Draft roadmap from this track, Re-plan on a plan item) ends in "…" and opens this dialog. It
 * drafts the run, prices it with the same estimate the run page shows, and says what it does;
 * Start for $N starts it. Over the approval limit an owner approves it as they start it.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Dialog } from "@/components/ds";
import { InlineError } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { EstimateSummary, usd, type EstimateOut } from "@/app/runs/_lib";

type Ready = { runId: string; estimate: EstimateOut };

/** Every button that starts a roadmap run (Draft roadmap on a track, Re-plan on a plan item) names itself here. */
export type RunAction = { title: string; intro: (prd: string) => string };
export const DRAFT_ROADMAP: RunAction = { title: "Draft a roadmap from this track", intro: (prd) => `Oracle drafts a roadmap from ${prd}.` };
export const REPLAN: RunAction = { title: "Re-plan this track", intro: (prd) => `Oracle drafts the roadmap for ${prd} again, from its new dates.` };

async function draftAndEstimate(trackId: string): Promise<Ready> {
  const run = await unwrap(api.POST("/v1/tracks/{track_id}/roadmap-run", { params: { path: { track_id: trackId } } }));
  const estimate = await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
  return { runId: run.id, estimate };
}

function startLabel(e: EstimateOut, owner: boolean) {
  if (!e.needs_approval) return `Start for ${usd(e.total_usd)}`;
  return owner ? `Approve ${usd(e.total_usd)} and start` : "Ask an owner to approve";
}

function useStart(onStarted: (runId: string) => void, ownerApproves: (e: EstimateOut) => boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(r: Ready) {
    setBusy(true);
    setError(null);
    try {
      const path = { params: { path: { run_id: r.runId } } };
      await unwrap(api.POST("/v1/runs/{run_id}/start", path));
      // Over the limit an owner approves the cost as they start it, as New run does (#259).
      if (ownerApproves(r.estimate)) await unwrap(api.POST("/v1/runs/{run_id}/approve", path));
      onStarted(r.runId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, start };
}

/** One dialog for every action that starts a paid run: what it does, its estimate, Start for $X. */
export function StartRunDialog({ trackId, prdTitle, onClose, action = DRAFT_ROADMAP }: { trackId: string; prdTitle: string; onClose: () => void; action?: RunAction }) {
  const router = useRouter();
  const { can } = useMe();
  const [ready, setReady] = useState<Ready | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const owner = can("approve_run");
  const { busy, error, start } = useStart((id) => router.push(`/runs/${id}`), (e) => owner && e.needs_approval);
  useEffect(() => {
    draftAndEstimate(trackId).then(setReady, (e) => setLoadError(errorMessage(e)));
  }, [trackId]);
  return (
    <Dialog
      title={action.title}
      onClose={onClose}
      busy={busy}
      testId="start-run-dialog"
      actions={
        <Button variant="primary" disabled={!ready || busy} onClick={() => ready && void start(ready)}>
          {ready ? startLabel(ready.estimate, owner) : "Estimating…"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-[15px]">
        <p>
          {action.intro(prdTitle)} It runs on its own{ready ? `, in ${ready.estimate.segments.length === 2 ? "two" : ready.estimate.segments.length} parts priced below,` : ""} and stops for your review before anything is saved.
        </p>
        {ready ? <EstimateSummary estimate={ready.estimate} /> : !loadError && <p className="text-sm text-text2">Working out the cost…</p>}
        <p className="text-sm text-text2">Nothing is charged until you start it. You can cancel it while it runs.</p>
        {(loadError || error) && <InlineError>{loadError || error}</InlineError>}
      </div>
    </Dialog>
  );
}

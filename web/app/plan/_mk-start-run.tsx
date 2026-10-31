"use client"; // MOCK-HOOK

/*
 * MOCK-HOOK (whole file): mock-up variants for QD2, how a person starts a paid run with its
 * estimate. ?qd2=a a dialog, b a strip on the card, c starts at once with a Cancel run line.
 * Mock-ups only; this branch is never merged.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Dialog, Notice } from "@/components/ds";
import { InlineError } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { EstimateSummary, usd, type EstimateOut } from "@/app/runs/_lib";

type Ready = { runId: string; estimate: EstimateOut };

/** What the run does, in steps a person reads before paying for it. */
const STEPS = ["Reads the PRD and its sources", "Drafts roadmap items with dates and sizes", "Stops for your review before anything is saved"];

async function draftAndEstimate(trackId: string): Promise<Ready> {
  const run = await unwrap(api.POST("/v1/tracks/{track_id}/roadmap-run", { params: { path: { track_id: trackId } } }));
  const estimate = await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
  return { runId: run.id, estimate };
}

function startLabel(e: EstimateOut, owner: boolean) {
  if (!e.needs_approval) return `Start for ${usd(e.total_usd)}`;
  return owner ? `Approve ${usd(e.total_usd)} and start` : "Ask an owner to approve";
}

function useStart(onStarted: (runId: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(r: Ready) {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: r.runId } } }));
      onStarted(r.runId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, start };
}

/** a: one dialog for every action that starts a paid run: what it does, its estimate, Start for $X. */
export function StartRunDialog({ trackId, prdTitle, onClose }: { trackId: string; prdTitle: string; onClose: () => void }) {
  const router = useRouter();
  const { can } = useMe();
  const [ready, setReady] = useState<Ready | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, start } = useStart((id) => router.push(`/runs/${id}`));
  useEffect(() => {
    draftAndEstimate(trackId).then(setReady, (e) => setLoadError(errorMessage(e)));
  }, [trackId]);
  return (
    <Dialog
      title="Draft a roadmap from this track"
      onClose={onClose}
      busy={busy}
      testId="start-run-dialog"
      actions={
        <Button variant="primary" disabled={!ready || busy} onClick={() => ready && void start(ready)}>
          {ready ? startLabel(ready.estimate, can("approve_run")) : "Estimating…"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-[15px]">
        <p>
          Oracle drafts a roadmap from <b>{prdTitle}</b>. It runs on its own and takes about 10 minutes.
        </p>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-text2">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {ready ? <EstimateSummary estimate={ready.estimate} /> : !loadError && <p className="text-sm text-text2">Working out the cost…</p>}
        <p className="text-sm text-text2">Nothing is charged until you start it. You can cancel it while it runs.</p>
        {(loadError || error) && <InlineError>{loadError || error}</InlineError>}
      </div>
    </Dialog>
  );
}

/** b: the button opens a strip on the card itself: the estimate in one line, Start and Cancel. */
export function StartRunStrip({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const router = useRouter();
  const { can } = useMe();
  const [ready, setReady] = useState<Ready | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, start } = useStart((id) => router.push(`/runs/${id}`));
  useEffect(() => {
    draftAndEstimate(trackId).then(setReady, (e) => setLoadError(errorMessage(e)));
  }, [trackId]);
  const e = ready?.estimate;
  return (
    <div data-testid="start-run-strip" className="flex basis-full flex-col gap-2 rounded-panel border border-accent bg-accent-soft px-3 py-2.5">
      <p className="text-[15px] font-semibold">Draft a roadmap from this track?</p>
      <p className="text-sm text-text2">
        {e
          ? `About ${usd(e.total_usd)} · about 10 minutes · it stops for your review before anything is saved.${e.needs_approval ? " Over the $50 limit: an owner approves it." : ""}`
          : "Working out the cost…"}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => ready && void start(ready)}>
          {e ? startLabel(e, can("approve_run")) : "Estimating…"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {(loadError || error) && <InlineError>{loadError || error}</InlineError>}
    </div>
  );
}

/** c: starts at once, as now, then says what it costs, with Cancel run for the first minute. */
export function StartRunAtOnce({ trackId, onDone }: { trackId: string; onDone: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<{ ready: Ready; held: boolean } | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const ready = await draftAndEstimate(trackId);
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: ready.runId } } }));
      setState({ ready, held: ready.estimate.needs_approval });
    })().catch((e) => setError(errorMessage(e)));
  }, [trackId]);
  if (error) return <InlineError>{error}</InlineError>;
  if (!state) return <p className="basis-full text-sm text-text2">Starting the run…</p>;
  const total = usd(state.ready.estimate.total_usd);
  if (cancelled)
    return (
      <div className="basis-full">
        <Notice tone="info">Run cancelled. Nothing was charged.</Notice>
      </div>
    );
  return (
    <div className="basis-full" data-testid="start-run-now">
      <Notice tone={state.held ? "warn" : "pass"}>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {state.held ? `Roadmap run waits for an owner: ${total} is over the $50 limit.` : `Roadmap run started · about ${total}.`} Free to cancel in the first minute.
          </span>
          <Button
            variant="ghost"
            onClick={async () => {
              await unwrap(api.POST("/v1/runs/{run_id}/cancel", { params: { path: { run_id: state.ready.runId } } }));
              setCancelled(true);
              onDone();
            }}
          >
            Cancel run
          </Button>
          <Button variant="ghost" onClick={() => router.push(`/runs/${state.ready.runId}`)}>
            Open run
          </Button>
        </span>
      </Notice>
    </div>
  );
}

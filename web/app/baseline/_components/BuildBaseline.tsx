"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { usd, type EstimateOut } from "@/app/runs/_lib";
import { Button, Chip, Icon, Notice, SegmentedControl } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type RunSummary = Schemas["RunSummary"];
type Depth = Schemas["KnobsIn"]["depth"];

/** A Build the baseline run in these states is under way: another is refused (B1). */
const UNDER_WAY: RunSummary["status"][] = ["awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun"];
/** A failed build shows on the Baseline page for a week. */
const FAILED_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

const DEPTHS: { value: Depth; label: string; title: string }[] = [
  { value: "quick", label: "Quick", title: "Strongest few sources per claim" },
  { value: "standard", label: "Standard", title: "Every goal and feature with its best evidence" },
  { value: "deep", label: "Deep", title: "Looks for contradicting evidence on every claim" },
];

/** The latest Build the baseline run worth showing: one under way, else one that failed this week. */
export function currentBuild(runs: RunSummary[] | undefined, now?: number): RunSummary | null {
  const builds = (runs ?? []).filter((r) => r.flow === "baseline" && r.status !== "draft");
  const live = builds.find((r) => UNDER_WAY.includes(r.status));
  if (live) return live;
  const latest = [...builds].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (latest?.status === "failed" && (now ?? Date.now()) - Date.parse(latest.finished_at ?? latest.created_at) < FAILED_SHOWN_MS) return latest;
  return null;
}

/** The header's chip while a build is under way (it stands where Build baseline was). */
export function BuildChip({ build }: { build: RunSummary }) {
  const ready = build.status === "awaiting_checkpoint";
  return (
    <Chip kind={ready ? "warn" : "acc"} data-testid="baseline-build-chip">
      {ready ? "Ready to review" : "Building"}
    </Chip>
  );
}

/** Above the tabs, for everyone: the build under way, ready to review, or failed this week. */
export function BuildBanner({ build }: { build: RunSummary }) {
  const href = `/runs/${build.id}`;
  const link = (label: string) => (
    <Link href={href} className="font-semibold underline underline-offset-2">
      {label}
    </Link>
  );
  if (build.status === "awaiting_checkpoint") {
    return (
      <Notice tone="warn" testId="baseline-build-banner">
        Ready to review · {link("Review")}
      </Notice>
    );
  }
  if (build.status === "failed") {
    return (
      <Notice tone="error" testId="baseline-build-banner">
        Baseline build failed · {link("Open run")}
      </Notice>
    );
  }
  const started = build.started_at ?? build.created_at;
  return (
    <Notice testId="baseline-build-banner">
      Baseline being built · started {formatDateTime(started)} · {link("Open run")}. You&apos;ll get an Inbox item when
      it&apos;s ready to review.
    </Notice>
  );
}

/** "$50" for a whole-dollar line, else "$50.50". */
const line = (usd_: number) => (Number.isInteger(usd_) ? `$${usd_}` : usd(usd_));

/**
 * What the build costs and who approves it (qa-onboarding-27): "$7.00 estimated · below the
 * $50 approval line · starts at once"; above the line an owner approves before it starts.
 */
export function estimateLine(e: EstimateOut): string {
  return e.needs_approval
    ? `${usd(e.total_usd)} estimated · above the ${line(e.approval_threshold_usd)} approval line · an owner approves it before it starts`
    : `${usd(e.total_usd)} estimated · below the ${line(e.approval_threshold_usd)} approval line · starts at once`;
}

type Drafted = { runId: string; estimate: EstimateOut };

/** The draft run for these choices (made, or the existing draft changed) and its estimate. */
async function draftAndEstimate(next: { depth: Depth; review: boolean }, draft: string | null): Promise<Drafted> {
  const knobs = { depth: next.depth, roles: {}, checkpoints: { baseline_confirm: next.review } };
  const run = draft
    ? await unwrap(api.PATCH("/v1/runs/{run_id}", { params: { path: { run_id: draft } }, body: { knobs } }))
    : await unwrap(api.POST("/v1/runs", { body: { flow: "baseline", knobs } }));
  const estimate = await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
  return { runId: run.id, estimate };
}

/** The run a 409 names: "A baseline build is already under way (run <id>)". */
function underWay(message: string): string | null {
  return /already under way \(run ([0-9a-f-]+)\)/.exec(message)?.[1] ?? null;
}

/**
 * The start sheet (B1): depth, Stop for my review, the estimate, Start. Opening it makes
 * the draft run the estimate is for; a change of depth or review re-estimates it.
 */
export function BuildBaselineSheet({ onClose, onStarted }: { onClose: () => void; onStarted: (runId: string) => void }) {
  const id = useId();
  const [depth, setDepth] = useState<Depth>("standard");
  const [review, setReview] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<EstimateOut | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The latest choice wins when estimates cross.
  const asked = useRef(0);
  // Sources with nothing in them give the build nothing to read: say so before Start
  // (qa-onboarding-11). A failed list says nothing.
  const sources = useQuery("sources", () => unwrap(api.GET("/v1/sources")));
  const nothingToRead = !!sources.data && sources.data.every((s) => s.item_count === 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Applies an estimate's answer unless a later choice asked again.
  const answer = useCallback((ask: number, pending: Promise<Drafted>) => {
    pending.then(
      (out) => {
        if (ask !== asked.current) return;
        setRunId(out.runId);
        setEstimate(out.estimate);
        setBusy(false);
      },
      (e) => {
        if (ask !== asked.current) return;
        setError(errorMessage(e));
        setBusy(false);
      },
    );
  }, []);

  useEffect(() => {
    answer(++asked.current, draftAndEstimate({ depth: "standard", review: true }, null));
  }, [answer]);

  const choose = (next: { depth: Depth; review: boolean }) => {
    setDepth(next.depth);
    setReview(next.review);
    setBusy(true);
    setError(null);
    setEstimate(null);
    answer(++asked.current, draftAndEstimate(next, runId));
  };

  async function start() {
    if (!runId || !estimate) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: runId } } }));
      onStarted(runId);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const first = error ? underWay(error) : null;
  const legendCls = "mb-1.5 block text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:p-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="flex w-full max-w-lg min-w-0 flex-col rounded-inspector border border-line bg-surface text-text shadow-tip max-[600px]:min-h-dvh max-[600px]:rounded-none max-[600px]:border-0"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 font-display text-xl font-bold tracking-heading">
            Build the baseline
          </h2>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="flex-1 space-y-5 px-5 py-4 text-[15px] max-[600px]:px-4">
          <p className="text-text2">
            Oracle reads your connected sources and proposes goals, products, features, constraints and evidence. Nothing
            is confirmed until you review it.
          </p>
          <div>
            <span id={`${id}-depth`} className={legendCls}>
              Depth
            </span>
            <SegmentedControl
              label="Depth"
              value={depth}
              onChange={(d) => choose({ depth: d, review })}
              items={DEPTHS.map((d) => ({ value: d.value, label: d.label, title: d.title, disabled: busy && !error }))}
            />
          </div>
          <label className="flex min-h-11 items-center gap-2.5">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={review}
              disabled={busy && !error}
              onChange={(e) => choose({ depth, review: e.target.checked })}
            />
            <span className="font-semibold">Stop for my review</span>
          </label>
          <p className="tnum text-sm text-text2" data-testid="build-estimate" aria-live="polite">
            {estimate ? estimateLine(estimate) : busy ? "Estimating…" : ""}
          </p>
          {nothingToRead && (
            <Notice tone="warn" testId="build-no-items">
              {sources.data!.length === 0 ? "You have no sources yet" : "Your sources have no items yet"}, so the build has
              nothing to read.{" "}
              <Link href="/settings/sources" className="font-semibold underline underline-offset-2">
                Add files or sync a source
              </Link>{" "}
              first.
            </Notice>
          )}
          {estimate?.needs_approval && (
            <Notice tone="warn">
              Over {usd(estimate.approval_threshold_usd)}: an owner approves the cost before the build starts.
            </Notice>
          )}
          {error &&
            (first ? (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-crit-bg px-3 py-2 text-sm font-medium text-crit">
                <Icon name="alert" size={16} />
                <span className="min-w-0 flex-1">A baseline build is already under way.</span>
                <Link href={`/runs/${first}`} className="font-semibold underline underline-offset-2">
                  Open the build under way
                </Link>
              </div>
            ) : (
              <Notice tone="error">{error}</Notice>
            ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:sticky max-[600px]:bottom-0 max-[600px]:bg-surface max-[600px]:px-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} disabled={busy || !estimate || !!first}>
            {estimate?.needs_approval ? "Ask an owner to approve" : "Start"}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { DeleteMenu } from "@/components/ArtifactMenu";
import { SourceLink } from "@/components/BuildRoadmap";
import {
  Button,
  Chip,
  CodeText,
  confirmInPage,
  LinkButton,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Notice,
  Page,
  PageHeader,
  Panel,
  Sheet,
  Split,
  type ChipKind,
} from "@/components/ds";
import { DiscussionThread } from "@/components/discuss/DiscussionThread";
import { DiscussSubject } from "@/components/discuss/StartDiscussion";
import { VagueGoalsLine } from "@/components/discuss/VagueGoalsLine";
import { RawFileSheet } from "@/components/review/RawFileSheet";
import { StagingBar } from "@/components/staging/StagingBar";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { displayZone, formatInZone } from "@/lib/dates";
import { formatDateTime, formatDay } from "@/lib/format";
import { useMe, type Operation } from "@/lib/me";

import { NewRunDialog, type RunStart } from "./_new-run-dialog";
import { useScreenSubject } from "@/lib/screen-subject";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import {
  briefsCheck,
  CANCEL_AGAIN_CONFIRM,
  CHECKPOINT_LABEL,
  FINAL_STATUSES,
  orderHref,
  RETRY_CONFIRM,
  reviewHref,
  runStatusLabel,
  RunStatusBadge,
  STOP_CANCELLING_CONFIRM,
  RunsWhere,
  SEGMENT_STATUS_KIND,
  SEGMENT_STATUS_LABEL,
  SENT_BACK_STATE,
  RunCost,
  deliveryText,
  shortId,
  usd,
  type CheckpointChoice,
  type CheckpointOut,
  type ConsoleAnswer,
  type RunOut,
  type SegmentOut,
} from "./_lib";

const POLL_MS = 5000;
// D8: a pending checkpoint's shared draft is read again this often while the page shows.
const DRAFT_POLL_MS = 10_000;
// The note to the agents is saved this long after the last keystroke.
const NOTE_SAVE_MS = 800;

type CheckpointReview = Schemas["CheckpointReview"];
type WaitInfo = Schemas["WaitInfo"];
type ActionIn = Schemas["ActionIn"];

/** A run still at work cannot go to Trash: cancel it first (#482). */
const WORKING = new Set<string>(["awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun"]);

/** `revision`: the shared draft's the decider saw (D8); `onChanged` hears it changed since. */
type Decide = (
  cp: CheckpointOut,
  decision: CheckpointChoice,
  note: string,
  revision?: number | null,
  onChanged?: (message: string) => void,
) => void;

/**
 * D1: a Roadmap items stop is decided on its review screen; the run page shows its summary.
 * A console answer keeps its panel and Confirm here (W5), held to the same gate (D3).
 */
const decidedOnScreen = (cp: CheckpointOut) => cp.kind === "roadmap_items" && !cp.console;

/** The decision panel (#decide): scrolled to and focused, so the keyboard continues from it. */
function toDecision() {
  const panel = document.getElementById("decide");
  if (!panel) return;
  window.history.replaceState(window.history.state, "", "#decide");
  panel.scrollIntoView({ block: "start" });
  panel.focus({ preventScroll: true });
}

/**
 * G5: a discussion link (`?discussion=<id>`, what the run's agents are given) opens its thread
 * in a sheet; the thread says "This discussion is private" to someone not in a private one.
 */
function LinkedDiscussion() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const id = params.get("discussion");
  if (!id) return null;
  const close = () => {
    const rest = new URLSearchParams(params.toString());
    rest.delete("discussion");
    router.replace(rest.size ? `${path}?${rest}` : path, { scroll: false });
  };
  return (
    <Sheet open title="Discussion" onClose={close} testId="run-discussion-sheet">
      <div className="p-4">
        <DiscussionThread key={id} id={id} />
      </div>
    </Sheet>
  );
}

export function RunDetail({ id }: { id: string }) {
  const q = useQuery(`run|${id}`, () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: id } } })));
  const { me, can } = useMe();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #258: what the last "Check agents now" checked, said once it answers.
  const [checked, setChecked] = useState<string | null>(null);
  const run = q.data;
  const { reload } = q;
  // G7 3.3: the panel is about the waiting checkpoint, else the run's page.
  const pendingCp = run?.checkpoints.find((c) => c.status === "pending") ?? null;
  useScreenSubject(
    run && pendingCp ? { kind: "checkpoint", subject: { run_id: run.id, checkpoint_id: pendingCp.id } } : null,
    run && pendingCp ? `${run.flow_title} · ${CHECKPOINT_LABEL[pendingCp.kind as keyof typeof CHECKPOINT_LABEL] ?? pendingCp.kind}` : null,
  );

  // Agents work in the background: re-read while the run is moving, and while a recorded
  // decision is still being delivered to it (Oracle sends it again on every tick).
  const moving = run?.status === "running" || !!run?.checkpoints.some((c) => c.delivery);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [moving, reload]);

  // Arrived at #decide (the Inbox's Decide): to the decision once it shows, once.
  const arrived = useRef(false);
  const ready = !!run;
  useEffect(() => {
    if (!ready || arrived.current) return;
    arrived.current = true;
    if (window.location.hash === "#decide") toDecision();
  }, [ready]);

  /** `recover`: for a call that may have changed the run though it failed; it re-reads the run
   * and says whether the page now shows what happened (then no error is shown). */
  async function act(call: () => Promise<RunOut | unknown>, recover?: (e: unknown) => Promise<boolean>) {
    setBusy(true);
    setError(null);
    try {
      const out = await call();
      if (out && typeof out === "object" && "segments" in out) q.setData(() => out as RunOut);
      else await q.reload();
    } catch (e) {
      if (!(recover && (await recover(e)))) setError(errorMessage(e));
    } finally {
      // What waits on me may have changed (a review decided, a run approved): the rail re-reads it.
      invalidateWaiting();
      waitingChanged();
      setBusy(false);
    }
  }

  const path = { params: { path: { run_id: id } } };
  // #370: the handlers let an owner manage any run, an approver only a run they created.
  const mayManage = (op: Operation) => can(op, run?.created_by === me?.user_id);
  const back = (
    <Link href="/runs" className="inline-flex items-center gap-1 hover:text-text hover:underline">
      <Icon name="back" size={16} />
      Runs
    </Link>
  );

  if (!run) {
    return (
      <Page>
        <PageHeader back={back} title="Run" />
        {q.error ? <ErrorNote>{q.error}</ErrorNote> : <Loading />}
      </Page>
    );
  }

  // A decision is recorded before SwarmCloud is told: a failed decide re-reads the run. A 503
  // left it recorded and delivering, which the review now says; a 409 (decided meanwhile,
  // say) keeps its message.
  // D8: sent with the shared draft's revision the decider saw; a draft that changed since is
  // refused (409 review_changed) and said at the decision, with Reload.
  const decide: Decide = (cp, decision, note, revision, onChanged) =>
    act(
      () =>
        unwrap(
          api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
            params: { path: { run_id: id, checkpoint_id: cp.id } },
            body: { decision, note: note || null, expected_revision: revision ?? null },
          }),
        ),
      async (e) => {
        const after = await unwrap(api.GET("/v1/runs/{run_id}", path)).catch(() => null);
        if (after) q.setData(() => after);
        if (e instanceof ApiError && e.code === "review_changed" && onChanged) {
          onChanged(e.message);
          return true;
        }
        return e instanceof ApiError && e.status === 503 && !!after?.checkpoints.some((c) => c.id === cp.id && c.delivery);
      },
    );
  // Imports a segment's refused draft again (the review still waits for a person).
  const retryImport = (seq: number) =>
    act(() => unwrap(api.POST("/v1/runs/{run_id}/segments/{seq}/retry-draft-import", { params: { path: { run_id: id, seq } } })));
  const done = run.segments.filter((s) => s.status === "succeeded").length;
  const decideCp = run.checkpoints.find((c) => c.status === "pending" && c.can_decide);
  const deciding = !!decideCp;
  // D1: Decide opens the Roadmap items review screen.
  const decideHref = decideCp && decidedOnScreen(decideCp) ? reviewHref({ ...decideCp, run_id: run.id }) : null;
  const open = !FINAL_STATUSES.includes(run.status) && run.status !== "draft";

  return (
    <Page>
      <LinkedDiscussion />
      <PageHeader
        back={back}
        title={run.flow_title}
        status={
          <>
            <RunStatusBadge run={run} />
            {run.document_slug &&
              (run.document_id ? (
                <Link href={`/documents/${run.document_slug}`} className="font-mono text-sm text-accent-ink hover:underline">
                  {run.document_slug}
                </Link>
              ) : (
                <span className="font-mono text-sm text-text2">{run.document_slug} (new)</span>
              ))}
            {run.source && (
              <span className="text-sm text-text2">
                <SourceLink source={run.source} />
              </span>
            )}
            {run.template && (
              <Chip kind="line">
                template {run.template}
                {run.theme && `, theme ${run.theme}`}
              </Chip>
            )}
            {/* #260: the goals a PRD run serves. */}
            {!!run.knobs.goals?.length && (
              <Chip kind="line" wrap data-testid="run-goals">
                Serves {run.knobs.goals.map((g) => g.title).join(", ")}
              </Chip>
            )}
            {/* H1: the stops this run had approved or sent back, in the decision log. */}
            <Link href={`/company/decisions?run=${run.id}`} data-testid="run-decision-log" className="text-sm font-medium text-accent-ink hover:underline">
              Decisions in this run
            </Link>
          </>
        }
        action={
          <>
            {can("approve_run") && run.status === "awaiting_approval" && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/approve", path)))}>
                Approve {usd(run.estimate_usd)} and start
              </Button>
            )}
            {deciding &&
              (decideHref ? (
                <LinkButton href={decideHref} variant="primary" icon="flag">
                  Decide
                </LinkButton>
              ) : (
                // The run waits on a checkpoint this member decides: scroll to its decision and focus it.
                <Button variant="primary" icon="flag" onClick={toDecision}>
                  Decide
                </Button>
              ))}
            {can("resume_run") && run.status === "paused_overrun" && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/resume", path)))}>
                Resume
              </Button>
            )}
            {/* #482: a run alone goes to Trash (its document stays). */}
            <DeleteMenu
              op="delete_run"
              title={run.flow_title}
              dependents={async () => ({ root: { type: "run", id: run.id, slug: null, title: run.flow_title, kind: run.flow }, items: [], published: false, working_runs: WORKING.has(run.status) ? [run.id] : [] })}
              remove={(query) => unwrap(api.DELETE("/v1/runs/{run_id}", { params: { path: { run_id: run.id }, query: { reason: query.reason } } }))}
              onDeleted={() => router.push("/runs")}
            />
          </>
        }
      />
      <Split inspector={<RunInspector run={run} />}>
        {error && <ErrorNote>{error}</ErrorNote>}
        {run.error && <ErrorNote>{run.error}</ErrorNote>}
        {run.stuck && (
          <Notice
            testId="run-stuck"
            action={
              <>
                {run.can_retry && mayManage("retry_run") && (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmInPage({ action: "Retry", message: RETRY_CONFIRM })) {
                        void act(() => unwrap(api.POST("/v1/runs/{run_id}/retry", path)));
                      }
                    }}
                  >
                    Retry
                  </Button>
                )}
                {run.can_stop_cancelling && mayManage("stop_cancelling_run") && (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmInPage({ destructive: true, action: "Stop cancelling", message: STOP_CANCELLING_CONFIRM })) {
                        void act(() => unwrap(api.POST("/v1/runs/{run_id}/stop-cancelling", path)));
                      }
                    }}
                  >
                    Stop cancelling
                  </Button>
                )}
                {run.can_retry_lookup && mayManage("retry_lookup_run") && (
                  <Button disabled={busy} onClick={() => void act(() => unwrap(api.POST("/v1/runs/{run_id}/retry-lookup", path)))}>
                    Retry lookup
                  </Button>
                )}
                {mayManage("cancel_again_run") && (run.cancel_again ?? []).map((wid, _, all) => (
                  <Button
                    key={wid}
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmInPage({ destructive: true, action: "Cancel again", message: CANCEL_AGAIN_CONFIRM })) {
                        void act(() => unwrap(api.POST("/v1/runs/{run_id}/cancel-again", { ...path, body: { workflow_id: wid } })));
                      }
                    }}
                  >
                    {all.length > 1 ? `Cancel again ${wid}` : "Cancel again"}
                  </Button>
                ))}
                {run.can_dismiss_overrun && mayManage("dismiss_overrun_run") && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => unwrap(api.POST("/v1/runs/{run_id}/dismiss-overrun", path)))}
                  >
                    Dismiss
                  </Button>
                )}
              </>
            }
          >
            {run.stuck}
          </Notice>
        )}
        {run.import_failed && (
          <Notice
            tone="error"
            testId="run-import-failed"
            action={
              can("retry_import_run") &&
              run.can_retry_import && (
                <Button disabled={busy} onClick={() => void act(() => unwrap(api.POST("/v1/runs/{run_id}/retry-import", path)))}>
                  Retry
                </Button>
              )
            }
          >
            {run.import_failed}
          </Notice>
        )}
        {run.searching && <Notice testId="run-searching">{run.searching}</Notice>}
        {run.token_read_only && (
          <Notice testId="run-token-read-only">
            <span className="inline-flex items-center gap-2">
              Agents may read Oracle, not write to it
              <InfoTip label="read-only agents" align="start" side="bottom">
                A checkpoint wait is open in SwarmCloud (or its answer is not read or does not count yet, or a lost submission
                is unresolved), so the run&apos;s agents may read Oracle but their writes are refused.
              </InfoTip>
            </span>
          </Notice>
        )}
        {checked && <Notice testId="tick-result">{checked}</Notice>}
        <Panel
          title={
            <>
              Run <span className="tnum font-mono text-base font-semibold">{shortId(run.id)}</span>
            </>
          }
          tools={
            <>
              <span className="tnum text-sm font-semibold text-text2">
                {done}/{run.segments.length} segments
              </span>
              {can("tick") && open && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setChecked(null);
                    void act(async () => {
                      const out = await unwrap(api.POST("/v1/internal/tick"));
                      setChecked(tickResult(out));
                      return out;
                    });
                  }}
                >
                  Check agents now
                </Button>
              )}
              {mayManage("cancel_run") && !FINAL_STATUSES.includes(run.status) && (
                <Button
                  disabled={busy}
                  data-testid="run-cancel"
                  onClick={async () => {
                    if (await confirmInPage({ destructive: true, action: "Cancel run", message: "Cancel this run? Agents still working are stopped." })) {
                      void act(() => unwrap(api.POST("/v1/runs/{run_id}/cancel", path)));
                    }
                  }}
                >
                  Cancel run
                </Button>
              )}
            </>
          }
        >
          <div
            aria-hidden
            className="grid h-9 grid-cols-[40px_minmax(0,1fr)_minmax(0,170px)_120px_minmax(0,240px)] items-center gap-2 bg-surface2 px-4 text-[13px] font-semibold text-text2 max-[600px]:grid-cols-[28px_minmax(0,1fr)_auto] max-[600px]:px-3"
          >
            <span>#</span>
            <span>Segment</span>
            <span className="max-[600px]:hidden">Roles</span>
            <span>State</span>
            <span className="max-[600px]:hidden">Checkpoint</span>
          </div>
          <ol data-testid="segment-timeline">
            {run.segments.map((s) => (
              <SegmentItem
                key={s.id}
                run={run}
                segment={s}
                checkpoints={run.checkpoints.filter((c) => c.segment_seq === s.seq)}
                busy={busy}
                onDecide={decide}
                onRetryImport={retryImport}
                onDraftChanged={() => void reload()}
              />
            ))}
          </ol>
        </Panel>
      </Split>
    </Page>
  );
}

/** #258: what "Check agents now" checked: "Checked 1 active run at 9:24 AM: 1 segment finished." */
function tickResult(out: Schemas["TickOut"]): string {
  const at = formatInZone(new Date().toISOString(), displayZone(), { hour: "numeric", minute: "2-digit" });
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (out.runs_checked === 0 && out.errors.length === 0) return `Checked at ${at}: no run is active.`;
  const parts = [out.segments_finished ? `${plural(out.segments_finished, "segment")} finished` : "no segment finished yet"];
  if (out.runs_paused) parts.push(`${plural(out.runs_paused, "run")} paused over budget`);
  if (out.errors.length) parts.push(`${plural(out.errors.length, "run")} could not be checked`);
  return `Checked ${plural(out.runs_checked, "active run")} at ${at}: ${parts.join(", ")}.`;
}

/**
 * The run in the inspector: what it waits on, then its details. P3d Cost prominence: the cost is
 * one small Details line; a Cost section comes forward only on a cost approval or an overrun.
 */
function RunInspector({ run }: { run: RunOut }) {
  const current =
    run.segments.find((s) => s.status === "running") ??
    run.segments.find((s) => run.checkpoints.some((c) => c.segment_seq === s.seq && c.status === "pending")) ??
    [...run.segments].reverse().find((s) => s.status !== "pending") ??
    run.segments[0];
  const waiting = run.waiting_on;
  const approval = run.status === "awaiting_approval";
  const overrun = run.status === "paused_overrun";
  return (
    <Inspector
      label="Run"
      eyebrow={waiting ? "Checkpoint · waiting" : `Run · ${runStatusLabel(run).toLowerCase()}`}
      title={waiting ? CHECKPOINT_LABEL[waiting] : (run.document_slug ?? run.flow_title)}
      chips={
        <>
          {current && (
            <Chip hero>
              Segment {current.seq} of {run.segments.length}
            </Chip>
          )}
          {current?.roles.map((r) => (
            <Chip hero key={r}>
              {r}
            </Chip>
          ))}
        </>
      }
    >
      {(approval || overrun) && (
        <InspectorSection
          testId="run-cost-section"
          label={approval ? "Cost approval" : "Overrun"}
          tools={
            <InfoTip label="cost" side="bottom">
              {approval && <span className="block">The estimate is over $50, so an owner approves the cost before any agent starts.</span>}
              {overrun && (
                <span className="block">
                  Spend passed {usd(run.overrun_ceiling_usd)} (1.5× the estimate). An owner resumes the run or cancels it.
                </span>
              )}
              {run.overrun_ceiling_usd != null && <span className="block">Pauses above {usd(run.overrun_ceiling_usd)}.</span>}
              {run.knobs.budget_usd != null && <span className="block">Budget {usd(run.knobs.budget_usd)}.</span>}
            </InfoTip>
          }
        >
          <RunCost run={run} />
        </InspectorSection>
      )}
      <InspectorSection label="Details" testId="run-details">
        <InspectorRow
          value={
            // CostFigure's small look, with the spent value marked.
            <span data-testid="run-cost" data-cost="small" className="tnum font-mono text-[13px] leading-none font-medium whitespace-nowrap text-text2">
              <span data-testid="run-spent">{usd(run.spent_usd)}</span> of {usd(run.estimate_usd)} est.
            </span>
          }
        >
          Cost
        </InspectorRow>
        <InspectorRow value={<span className="capitalize">{run.knobs.depth}</span>}>Depth</InspectorRow>
        <InspectorRow value={formatDateTime(run.created_at)}>Created</InspectorRow>
        <ProposalsRow run={run} />
        {run.snapshot_as_of && <InspectorRow value={formatDateTime(run.snapshot_as_of)}>Sources as of</InspectorRow>}
        <InspectorRow
          value={
            <span className="inline-flex items-center gap-2">
              {run.runtime === "fake" ? "Local" : "SwarmCloud"}
              <InfoTip label="the runtime" side="top">
                <RunsWhere runtime={run.runtime} />
                {run.notes.length > 0 && (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4" data-testid="run-notes">
                    {run.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </InfoTip>
            </span>
          }
        >
          Runtime
        </InspectorRow>
      </InspectorSection>
      <RunDecisions run={run} />
    </Inspector>
  );
}

/** "Baseline proposals: 2 open · Review": what the run proposed that still waits for a person. */
function ProposalsRow({ run }: { run: RunOut }) {
  const open = run.open_proposals ?? 0;
  // RunOut counts open proposals only: a run that has started says "none open" once all were decided.
  if (open === 0 && !run.started_at) return null;
  return (
    <div data-testid="run-proposals-row">
      <InspectorRow
        value={
          <span data-testid="run-proposals">
            {open > 0 ? (
              <>
                {open} open ·{" "}
                <Link href={`/baseline?tab=proposals&run=${run.id}`} className="text-accent-ink hover:underline">
                  Review
                </Link>
              </>
            ) : (
              "none open"
            )}
          </span>
        }
      >
        Baseline proposals
      </InspectorRow>
    </div>
  );
}

/** D11: what people decided at the run's checkpoints, in the words its agents read. */
function RunDecisions({ run }: { run: RunOut }) {
  // Read again whenever a checkpoint of the run is decided or delivered.
  const states = run.checkpoints.map((c) => `${c.id}:${c.status}:${c.delivery ? 1 : 0}`).join(",");
  const q = useQuery(
    `run-decisions|${run.id}|${states}`,
    () => unwrap(api.GET("/v1/runs/{run_id}/decisions", { params: { path: { run_id: run.id } } })),
    { keepPrevious: true },
  );
  return (
    <InspectorSection
      label="Decisions"
      testId="run-decisions"
      tools={
        <InfoTip label="decisions" side="bottom">
          What people decided at this run&apos;s checkpoints. The run&apos;s agents read the same list before they start, so an
          approval note reaches the segments that follow it.
        </InfoTip>
      }
    >
      {q.error ? (
        <ErrorNote>{q.error}</ErrorNote>
      ) : !q.data ? (
        <Loading />
      ) : q.data.length === 0 ? (
        <p className="text-sm text-text2">No decisions yet.</p>
      ) : (
        <ol className="space-y-1.5 text-[13px] leading-5 text-text">
          {q.data.map((d) => (
            <li key={d.checkpoint_id} data-testid="run-decision" className="break-words">
              {d.summary}
            </li>
          ))}
        </ol>
      )}
    </InspectorSection>
  );
}

const CP_KIND: Record<CheckpointOut["status"], ChipKind> = {
  pending: "warn",
  approved: "pass",
  changes_requested: "warn",
  skipped: "na",
};
/** A checkpoint name in full: it wraps to a second line rather than truncating. */
const WRAP_CHIP = "h-auto! min-h-[26px] py-1 leading-4! whitespace-normal! text-left max-[600px]:max-w-[9.5rem]";
/** "45s", "12m", "1h 05m": a duration for a running agent. */
function duration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** #258: a running segment's agents as Oracle last read them, and what it has spent so far. */
function SegmentProgress({ segment: s }: { segment: SegmentOut }) {
  // The elapsed times count on between reads.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const since = (at: string) => duration(now - new Date(at).getTime());
  return (
    <div data-testid="segment-progress" className="space-y-1 text-text2">
      <p className="tnum">
        {usd(s.cost_usd)} spent so far ·{" "}
        {s.checked_at ? `checked ${since(s.checked_at)} ago` : "Not checked yet: Oracle reads the agents on each check"}
      </p>
      {s.checked_at &&
        (s.agents.length > 0 ? (
          <ul className="space-y-0.5">
            {s.agents.map((a, i) => (
              <li key={i} data-testid="segment-agent" className="tnum">
                <span data-testid="agent-role" className="font-medium text-text">
                  {a.role ?? "Agent"}
                </span>{" "}
                · {a.state.charAt(0).toUpperCase() + a.state.slice(1)} ·{" "}
                <span data-testid="agent-elapsed">{a.started_at ? `${since(a.started_at)} elapsed` : "start not read"}</span> ·{" "}
                <span data-testid="agent-heartbeat">{a.heartbeat_at ? `last heartbeat ${since(a.heartbeat_at)} ago` : "no heartbeat yet"}</span>
                {a.cost_usd != null && <> · {usd(a.cost_usd)}</>}
              </li>
            ))}
          </ul>
        ) : (
          <p>No agent is working yet: they wait their turn.</p>
        ))}
    </div>
  );
}

const CP_LABEL = { pending: "Waiting", approved: "Approved", changes_requested: "Changes requested", skipped: "Skipped" } as const;

function SegmentItem({
  run,
  segment: s,
  checkpoints,
  busy,
  onDecide,
  onRetryImport,
  onDraftChanged,
}: {
  run: RunOut;
  segment: SegmentOut;
  checkpoints: CheckpointOut[];
  busy: boolean;
  onDecide: Decide;
  onRetryImport: (seq: number) => void;
  /** D7: the shared draft changed, so the checkpoint's Approve words may have (the run re-read). */
  onDraftChanged: () => void;
}) {
  const kind = s.checkpoint;
  const { me, can } = useMe();
  // B6: once the baseline is approved, Oracle offers a goals interview on the goals still vague.
  const vague = can("start_goal_interview")
    ? (checkpoints.find((c) => c.kind === "baseline_confirm" && c.status === "approved") as { vague_goals?: number | null } | undefined)?.vague_goals ?? 0
    : 0;
  // D8: the waiting checkpoint's shared draft, for every member who can see the run.
  const waitingCp = checkpoints.find((c) => c.status === "pending") ?? null;
  const draft = useDraft(run.id, waitingCp?.id ?? null);
  const shared = draft.review && draft.review.checkpoint_id === waitingCp?.id ? draft.review : null;
  const [draftError, setDraftError] = useState<string | null>(null);
  // D7: Approve's words and what needs the agents are the checkpoint's: re-read the run when
  // the draft moves on from the revision first read (a staged edit, another reviewer's).
  const seenRevision = useRef<string | null>(null);
  const revisionKey = shared ? `${shared.checkpoint_id}|${shared.revision}` : null;
  useEffect(() => {
    if (!revisionKey) return;
    const before = seenRevision.current;
    seenRevision.current = revisionKey;
    if (before && before !== revisionKey) onDraftChanged();
    // onDraftChanged is a new function on every render: the revision decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionKey]);
  // F4: a stop with its own review screen (the Engineering check) is opened from a line here.
  const screened = checkpoints.find((c) => c.status === "pending" && briefsCheck(c)) ?? null;
  // The Waiting chip counts every stop waiting for me, the screened one included.
  const mine = checkpoints.filter((c) => c.status === "pending" && c.can_decide);
  const deciding = mine.filter((c) => c !== screened);
  // The screened stop is said once, on its line: never again as a chip.
  const compact = checkpoints.filter((c) => c !== screened && !(c.status === "pending" && c.can_decide));
  const waiting = checkpoints.some((c) => c.status === "pending");
  // Decided, not delivered to the run yet: said under the segment, with why it waits.
  const delivering = checkpoints.filter((c) => c.delivery && !s.sent_back);
  // D4: the structured reviews sent back from this segment's checkpoints.
  const sentReviews = checkpoints.filter((c) => c.status === "changes_requested" && c.review);
  // D7: approved with the reviewer's edits applied by Oracle; the agents' file is kept.
  const editedBy = checkpoints.filter((c) => c.status === "approved" && c.review?.kind === "edits");
  const details =
    sentReviews.length > 0 ||
    editedBy.length > 0 ||
    s.error ||
    s.autonomy_note ||
    s.items_check ||
    s.feature_set_check ||
    s.draft_import ||
    s.artifacts.length > 0 ||
    deciding.length > 0 ||
    !!screened ||
    delivering.length > 0 ||
    s.status === "running" ||
    vague > 0 ||
    !!shared;
  const rejected = !!s.draft_import?.error;
  // Each open decision's note, here so Send back to writer can fill it in.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const noteFields = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // The shared note as last read: a new one (another approver's, a reload) replaces what
  // the field shows unless I changed it since (my edit is being saved).
  const serverNote = shared?.note ?? "";
  const [synced, setSynced] = useState<{ cp: string | null; note: string }>({ cp: null, note: "" });
  if (shared && (synced.cp !== shared.checkpoint_id || synced.note !== serverNote)) {
    const had = synced.cp === shared.checkpoint_id ? synced.note : "";
    setSynced({ cp: shared.checkpoint_id, note: serverNote });
    if ((notes[shared.checkpoint_id] ?? "") === had) setNotes({ ...notes, [shared.checkpoint_id]: serverNote });
  }
  const draftPath = (cpId: string) => ({ params: { path: { run_id: run.id, checkpoint_id: cpId } } });
  async function write(call: () => Promise<CheckpointReview>) {
    setDraftError(null);
    try {
      draft.accept(await call());
    } catch (e) {
      setDraftError(errorMessage(e));
    }
  }
  const draftActs: DraftActs | undefined = shared
    ? {
        review: shared,
        meId: me?.user_id ?? null,
        error: draftError,
        act: (body) => write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", { ...draftPath(shared.checkpoint_id), body }))),
        stage: (actionId) =>
          write(() =>
            unwrap(
              api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage", {
                params: { path: { run_id: run.id, checkpoint_id: shared.checkpoint_id, action_id: actionId } },
              }),
            ),
          ),
        undo: (actionId) =>
          write(() =>
            unwrap(
              api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", {
                params: { path: { run_id: run.id, checkpoint_id: shared.checkpoint_id, action_id: actionId } },
              }),
            ),
          ),
      }
    : undefined;
  const saveNote = async (cpId: string, text: string) => {
    draft.accept(await unwrap(api.PUT("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note", { ...draftPath(cpId), body: { note: text || null } })));
  };
  // Send back to writer: the Request changes flow of this segment's review, its note the
  // summary of what Oracle refused (kept with anything already written), to edit and send.
  const review = deciding.find((cp) => cp.console?.needs !== "redo_or_continue");
  const sendBack =
    rejected && review
      ? () => {
          const imp = s.draft_import!;
          const text = imp.summary ?? `Draft not imported: ${imp.error}`;
          const had = (notes[review.id] ?? "").trim();
          const note = !had ? text : had.includes(text) ? had : `${text}\n\n${had}`;
          flushSync(() => setNotes((n) => ({ ...n, [review.id]: note })));
          const field = noteFields.current[review.id];
          if (!field) return;
          field.scrollIntoView({ block: "center" });
          field.focus({ preventScroll: true });
          field.setSelectionRange(note.length, note.length);
        }
      : undefined;
  return (
    <li
      className={`border-t border-line ${waiting ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)]" : ""}`}
      data-testid={`segment-${s.name}`}
    >
      <div className="grid min-h-12 grid-cols-[40px_minmax(0,1fr)_minmax(0,170px)_120px_minmax(0,240px)] items-center gap-2 px-4 py-1.5 max-[600px]:grid-cols-[28px_minmax(0,1fr)_auto] max-[600px]:px-3">
        <span className="tnum font-semibold">{s.seq}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium max-[600px]:whitespace-normal" title={s.title}>
            {s.title}
          </span>
          {s.attempts.length > 1 && <Chip kind="na">attempt {s.attempts.length}</Chip>}
        </span>
        <span className="flex min-w-0 gap-1.5 overflow-hidden max-[600px]:hidden">
          {s.roles.map((r) => (
            // On the tinted waiting row an accent chip would vanish into the tint.
            <Chip key={r} kind={waiting ? "line" : "acc"}>
              {r}
            </Chip>
          ))}
        </span>
        <span>
          {s.sent_back ? (
            // Oracle refused the draft and sent it back to the writer itself: revising, with
            // nothing for a person to decide yet. Not "Draft rejected".
            <Chip kind="acc" className={WRAP_CHIP}>
              <span data-testid="segment-state">{SENT_BACK_STATE}</span>
            </Chip>
          ) : rejected ? (
            // The segment ran, but Oracle refused the draft it left: not "Succeeded".
            <Chip kind="crit">
              <span data-testid="segment-state">Draft rejected</span>
            </Chip>
          ) : s.reused ? (
            // C4 (B1 "Reuse base"): the run used the current baseline; this segment ran no step.
            <Chip kind="na" className={WRAP_CHIP}>
              <span data-testid="segment-state">
                Reused (approved {formatDay(s.reused.approved_at)})
              </span>
            </Chip>
          ) : (
            <Chip kind={SEGMENT_STATUS_KIND[s.status]}>
              {s.status === "succeeded" && <Icon name="check" size={16} />}
              <span data-testid="segment-state">{SEGMENT_STATUS_LABEL[s.status]}</span>
            </Chip>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap gap-1.5 max-[600px]:col-span-full max-[600px]:col-start-2">
          {checkpoints.length === 0 &&
            kind &&
            (s.checkpoint_on ? (
              <Chip kind="line" title={`Stops for ${CHECKPOINT_LABEL[kind].toLowerCase()}`} className={WRAP_CHIP} data-testid="segment-checkpoint">
                <span className="sr-only">Stops for </span>
                {CHECKPOINT_LABEL[kind]}
              </Chip>
            ) : (
              <Chip kind="na" title={`${CHECKPOINT_LABEL[kind]}: off`} className={WRAP_CHIP} data-testid="segment-checkpoint">
                {CHECKPOINT_LABEL[kind]}: off
              </Chip>
            ))}
          {mine.length > 0 && (
            // The decision panel below and the inspector name the checkpoint; the row shows its state.
            <a
              href="#decide"
              data-testid="checkpoint-waiting"
              className="inline-flex max-w-full rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Chip kind="warn" title={`Waiting: ${mine.map((cp) => CHECKPOINT_LABEL[cp.kind]).join(", ")}`}>
                <Icon name="clock" size={16} />
                Waiting
                <span className="sr-only">: {mine.map((cp) => CHECKPOINT_LABEL[cp.kind]).join(", ")}</span>
              </Chip>
            </a>
          )}
          {compact.map((cp) => (
            <span key={cp.id} data-testid={`checkpoint-${cp.kind}`} className="inline-flex max-w-full">
              <Chip
                kind={CP_KIND[cp.status]}
                title={[CHECKPOINT_LABEL[cp.kind], cp.decided_at && formatDateTime(cp.decided_at), cp.note].filter(Boolean).join(" · ")}
              >
                <span className="sr-only">{CHECKPOINT_LABEL[cp.kind]}: </span>
                {cp.status === "approved" && !cp.delivery && <Icon name="check" size={16} />}
                {(cp.status === "pending" || cp.delivery) && <Icon name="clock" size={16} />}
                {CP_LABEL[cp.status]}
                {cp.status === "pending" && <span className="sr-only"> for an {cp.approver_role} or above</span>}
                {cp.delivery && <span className="sr-only">, not delivered to the run yet</span>}
              </Chip>
              {cp.console && (
                // Answered in SwarmCloud's console; who answered and what Oracle still needs, on hover.
                <Chip
                  kind="warn"
                  className="ml-1.5"
                  data-testid="console-answer"
                  title={`Answered in SwarmCloud by ${cp.console.answered_by ?? "someone"}: ${CONSOLE_NEEDS[cp.console.needs]}`}
                >
                  SwarmCloud answer
                </Chip>
              )}
            </span>
          ))}
        </span>
      </div>
      {details && (
        <div className="space-y-2.5 pr-4 pb-3 pl-[56px] text-[15px] max-[600px]:pr-3 max-[600px]:pl-[44px]">
          {s.error && <p className="text-crit">{s.error}</p>}
          {s.status === "running" && <SegmentProgress segment={s} />}
          {s.autonomy_note && (
            // H11: the baseline's level changed this segment's merge.
            <p data-testid="autonomy-note" className="text-text2">
              {s.autonomy_note}.{" "}
              <Link href="/settings/autonomy" className="font-medium text-accent-ink hover:underline">
                Settings, Autonomy
              </Link>
            </p>
          )}
          {s.items_check &&
            (waitingCp && decidedOnScreen(waitingCp) ? (
              // D1 (#542): the items are decided on the review screen; here, the counts only.
              <ItemsCheckLine check={s.items_check} summary />
            ) : (
              <ItemsCheckLine check={s.items_check} draft={draftActs} />
            ))}
          {/* G4: everything staged at the waiting checkpoint, from rows and discussions. */}
          {waitingCp && shared && <StagingBar runId={run.id} checkpointId={waitingCp.id} revision={shared.revision} />}
          {shared && deciding.length === 0 && <SharedDraftLine review={shared} />}
          {sentReviews.map((cp) => (
            <SentReviewLine key={cp.id} runId={run.id} cp={cp} />
          ))}
          {editedBy.map((cp) => (
            <AppliedEditsLine key={cp.id} cp={cp} />
          ))}
          {s.feature_set_check && <FeatureSetCheckLine check={s.feature_set_check} />}
          {waitingCp?.kind === "roadmap_items" && reviewHref(waitingCp) && (
            <ItemsReviewLine
              run={run}
              cp={waitingCp}
              needYou={shared ? shared.tally.need_you : new Set(s.items_check?.reasons.map((x) => x.item)).size}
              blocking={shared?.tally.blocking_open ?? s.items_check?.blocking ?? 0}
              anchor={deciding.includes(waitingCp) && decidedOnScreen(waitingCp)}
            />
          )}
          {waitingCp?.kind === "feature_set" && reviewHref(waitingCp) && !deciding.includes(waitingCp) && (
            // C7: commenters suggest and viewers read on the review screen too.
            <p className="mt-2" data-testid="review-link">
              <LinkButton href={reviewHref(waitingCp)!} icon="flag">
                Review feature set
              </LinkButton>
            </p>
          )}
          {s.draft_import && (
            <DraftImportLine
              imp={s.draft_import}
              busy={busy}
              sentBack={s.sent_back}
              onRetry={s.can_retry_draft_import ? () => onRetryImport(s.seq) : undefined}
              onSendBack={sendBack}
              retryRefused={s.draft_retry_refused}
              newRun={can("create_run", true) && run.document_slug ? { flow: run.flow, document: run.document_slug, title: "Start a new run" } : undefined}
            />
          )}
          {(s.artifacts.length > 0 || s.previous_attempt) && (
            <Artifacts
              runId={run.id}
              seq={s.seq}
              names={s.artifacts}
              previous={s.previous_attempt ?? null}
              edited={editedBy.map((cp) => editedFile(cp)).filter((n) => s.artifacts.includes(n))}
            />
          )}
          {delivering.map((cp) => (
            <DeliveryLine key={cp.id} cp={cp} />
          ))}
          <VagueGoalsLine count={vague} href={`/baseline?tab=proposals&run=${run.id}&interview=vague`} />
          {screened && <ReviewScreenLine run={run} cp={screened} />}
          {deciding.filter((cp) => !decidedOnScreen(cp)).map((cp, i) =>
            // D10: a PRD or roadmap review with its draft imported is decided in the version;
            // a refused draft and a console answer stay here.
            cp.review_link && !cp.console && !cp.cannot_approve ? (
              <RunReviewSummary key={cp.id} cp={cp} anchor={i === 0} />
            ) : (
            <CheckpointRow
              key={cp.id}
              cp={cp}
              run={run}
              busy={busy}
              onDecide={onDecide}
              anchor={i === 0}
              note={notes[cp.id] ?? ""}
              onNote={(text) => setNotes((n) => ({ ...n, [cp.id]: text }))}
              review={shared?.checkpoint_id === cp.id ? shared : null}
              onSaveNote={(text) => saveNote(cp.id, text)}
              onReload={draft.reload}
              onWaive={shared?.checkpoint_id === cp.id ? draftActs?.act : undefined}
              noteRef={(el) => {
                noteFields.current[cp.id] = el;
              }}
            />
            ),
          )}
        </div>
      )}
    </li>
  );
}

/**
 * D1: the Roadmap items stop on the run page: "{n} need you · {b} blocking" (the items still
 * needing a person), Review items (the review screen, where it is decided) and the Raw file.
 */
function ItemsReviewLine({ run, cp, needYou, blocking, anchor }: { run: RunOut; cp: CheckpointOut; needYou: number; blocking: number; anchor: boolean }) {
  const [raw, setRaw] = useState(false);
  return (
    <div
      id={anchor ? "decide" : undefined}
      tabIndex={anchor ? -1 : undefined}
      className="mt-2 flex flex-wrap items-center gap-2"
      data-testid="items-review-line"
    >
      <span className="font-semibold">
        {needYou} need you · {blocking} blocking
      </span>
      <LinkButton href={reviewHref({ ...cp, run_id: run.id })!} icon="flag" variant={cp.can_decide ? "primary" : "secondary"}>
        Review items
      </LinkButton>
      <Button icon="doc" onClick={() => setRaw(true)}>
        Raw file
      </Button>
      <RawFileSheet open={raw ? "file" : null} onClose={() => setRaw(false)} runId={run.id} seq={cp.segment_seq ?? 1} />
    </div>
  );
}

/** F4: the Engineering check waiting, its counts, and Review (its own screen). */
function ReviewScreenLine({ run, cp }: { run: RunOut; cp: CheckpointOut }) {
  const check = briefsCheck(cp)!;
  const blocking = (cp.gate?.left ?? []).filter((x) => x.code === "blocking_question").length;
  return (
    <div id="decide" tabIndex={-1} className="flex flex-wrap items-center gap-2" data-testid="review-screen-line">
      <span className="font-semibold">
        {plural(check.features.length, "feature")}
        {blocking > 0 && ` · ${blocking} blocking`}
      </span>
      <span className="text-text2">{cp.can_decide ? "Waiting for you" : "Waits for the engineering lead"}</span>
      <LinkButton href={reviewHref({ ...cp, run_id: run.id })!} variant={cp.can_decide ? "primary" : "secondary"}>
        {cp.can_decide ? "Review" : "View"}
      </LinkButton>
    </div>
  );
}

/** D10: a run review decided in its version: how far the review got, and a link to it. */
function RunReviewSummary({ cp, anchor }: { cp: CheckpointOut; anchor?: boolean }) {
  const imp = (cp.payload as { import?: { slug?: string; version?: number } }).import ?? {};
  const doc = imp.slug ?? "";
  const n = imp.version ?? 0;
  const q = useQuery(`run-review|${doc}|${n}|${cp.id}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/run-review", { params: { path: { doc, n } } })),
  );
  const sections = q.data?.sections;
  return (
    <div
      id={anchor ? "decide" : undefined}
      tabIndex={anchor ? -1 : undefined}
      role="group"
      aria-label={`Decide: ${CHECKPOINT_LABEL[cp.kind]}`}
      className="flex scroll-mt-24 flex-wrap items-center gap-2 rounded-button border border-line bg-surface p-3"
      data-testid={`checkpoint-${cp.kind}`}
    >
      <Icon name="flag" size={16} className="text-accent-ink" />
      <span className="font-semibold">{CHECKPOINT_LABEL[cp.kind]}</span>
      <span className="min-w-0 flex-1 text-text2" data-testid="run-review-summary">
        Waiting for review of v{n}
        {sections && (
          <>
            {" "}
            · {sections.reviewed}/{sections.total} sections reviewed
          </>
        )}
      </span>
      <LinkButton href={cp.review_link!} icon="arrow">
        Open review
      </LinkButton>
    </div>
  );
}

/** A decision recorded in Oracle that SwarmCloud has not taken yet (owner, 2026-10-20). */
function DeliveryLine({ cp }: { cp: CheckpointOut }) {
  return (
    <p className="flex items-start gap-2 text-text" data-testid="checkpoint-delivering">
      <Icon name="clock" size={16} className="mt-1 flex-none text-warn" />
      <span className="min-w-0 break-words">
        {deliveryText(cp)}{" "}
        <InfoTip label="delivering the decision" align="start">
          The decision is recorded and final: nobody needs to decide again. SwarmCloud has not taken it yet, so Oracle sends it
          again on every tick until it does.
        </InfoTip>
      </span>
    </p>
  );
}

function DraftImportLine({
  imp,
  busy,
  sentBack = false,
  onRetry,
  onSendBack,
  retryRefused,
  newRun,
}: {
  imp: NonNullable<SegmentOut["draft_import"]>;
  /** A finished run imported a version already: why this draft stays refused (owner, 2026-10-25). */
  retryRefused?: string | null;
  /** Where Start a new run opens the New run dialog, for those who may start one. */
  newRun?: RunStart;
  busy: boolean;
  /** The import was refused and Oracle sent the draft back to the writer itself: revising. */
  sentBack?: boolean;
  /** The import was refused and its review is open: Retry import (owners and approvers). */
  onRetry?: () => void;
  /** The import was refused and this member decides its review: Send back to writer. */
  onSendBack?: () => void;
}) {
  if (imp.error)
    return <DraftRejected imp={imp} busy={busy} sentBack={sentBack} onRetry={onRetry} onSendBack={onSendBack} retryRefused={retryRefused} newRun={newRun} />;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text">
      <span>
        Imported as{" "}
        <Link href={`/documents/${imp.slug}/v/${imp.version}`} className="font-medium text-accent-ink underline-offset-2 hover:underline">
          {imp.slug} v{imp.version}
        </Link>
      </span>
      {imp.created === false && <Chip kind="na">Same content</Chip>}
      {imp.warnings.length > 0 && <Chip kind="warn" title={imp.warnings.join(", ")}>{imp.warnings.length} warning{imp.warnings.length === 1 ? "" : "s"}</Chip>}
      {imp.prd_links && (
        <span data-testid="prd-links" className="inline-flex flex-wrap items-center gap-2">
          <Chip kind="acc">
            {imp.prd_links.resolved} link{imp.prd_links.resolved === 1 ? "" : "s"} to PRD sections
          </Chip>
          {imp.prd_links.unresolved.length > 0 && (
            <Chip kind="warn" title={imp.prd_links.unresolved.join(", ")}>
              {imp.prd_links.unresolved.length} not found: {imp.prd_links.unresolved.join(", ")}
            </Chip>
          )}
        </span>
      )}
    </p>
  );
}

/**
 * A draft Oracle refused: one line grouped by cause (the API's summary), every problem behind a
 * disclosure. `sentBack`: Oracle sent it back to the writer itself and the revision runs, so it
 * reads as what the writer is fixing, not as a refusal waiting on a person.
 */
function DraftRejected({
  imp,
  busy,
  sentBack = false,
  onRetry,
  onSendBack,
  retryRefused,
  newRun,
}: {
  imp: NonNullable<SegmentOut["draft_import"]>;
  busy: boolean;
  sentBack?: boolean;
  onRetry?: () => void;
  onSendBack?: () => void;
  retryRefused?: string | null;
  newRun?: RunStart;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // Imports refused before the problems were kept carry the error alone.
  const problems = imp.problems ?? [];
  const n = problems.length;
  const listId = useId();
  const testId = sentBack ? "draft-sent-back" : "draft-rejected";
  return (
    <div className="flex flex-col items-start gap-2" data-testid={testId}>
      <p className={sentBack ? "text-text" : "text-crit"} data-testid={`${testId}-summary`}>
        {imp.summary ?? `Draft not imported: ${imp.error}`}
      </p>
      {sentBack && (
        <p className="text-text2">
          Oracle sent the draft back to the writer to fix this. Nothing needs you yet: the revision is imported when the writer is done, and only a draft
          still refused comes to the Inbox.
        </p>
      )}
      {n > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {open ? "Hide the problems" : `Show all ${n} problem${n === 1 ? "" : "s"}`}
          </button>
          {open && (
            <ul
              id={listId}
              data-testid="draft-problems"
              className="max-h-80 w-full space-y-0.5 overflow-auto rounded-button border border-line bg-surface2 px-3 py-2 font-mono text-[13px] text-text"
            >
              {problems.map((p, i) => (
                <li key={i} className="break-words">
                  {p.line != null && `Line ${p.line}: `}
                  {p.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {retryRefused && (
        <p className="text-text2" data-testid="draft-retry-refused">
          {retryRefused}
        </p>
      )}
      {retryRefused && newRun && (
        <Button disabled={busy} icon="plus" onClick={() => setStarting(true)}>
          Start a new run
        </Button>
      )}
      {starting && newRun && <NewRunDialog onClose={() => setStarting(false)} start={newRun} />}
      {(onRetry || onSendBack) && (
        <div className="flex flex-wrap gap-2">
          {onSendBack && (
            <Button disabled={busy} onClick={onSendBack}>
              Send back to writer
            </Button>
          )}
          {onRetry && (
            <Button disabled={busy} onClick={onRetry}>
              Retry import
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** O4b: the check of roadmap_items.yaml, counts by horizon and every problem found. */
type ItemsCheck = NonNullable<SegmentOut["items_check"]>;
type ItemReason = ItemsCheck["reasons"][number];

/** A reason's fixes as plain words, until the items review makes them buttons: "Fix: Remove date or Record basis". */
function fixText(reason: ItemReason): string | null {
  const labels = reason.fixes.map((f) => f.label);
  if (labels.length === 0) return null;
  const last = labels.pop()!;
  return `Fix: ${labels.length ? `${labels.join(", ")} or ${last}` : last}`;
}

/** Reasons per item, in the order given (item position, blocking first). */
function byItem(reasons: ItemReason[]): { item: string; title: string; reasons: ItemReason[] }[] {
  const out: { item: string; title: string; reasons: ItemReason[] }[] = [];
  for (const r of reasons) {
    let group = out.find((g) => g.item === r.item);
    if (!group) {
      group = { item: r.item, title: r.item_title || r.item, reasons: [] };
      out.push(group);
    }
    group.reasons.push(r);
  }
  return out;
}

type Resolution = NonNullable<ItemsCheck["resolution"]>;
type ResolutionEntry = Resolution["entries"][number];

/** D6: "Attempt 2: 3 of 5 entries done · 1 declined · 1 not applied · 1 unrequested change". */
function resolutionSummary(r: Resolution): string {
  const c = r.counts;
  const parts = [
    `${c.done} of ${r.entries.length} entr${r.entries.length === 1 ? "y" : "ies"} done`,
    c.declined > 0 && `${c.declined} declined`,
    c.not_applied > 0 && `${c.not_applied} not applied`,
    c.unrequested > 0 && `${c.unrequested} unrequested change${c.unrequested === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `${r.attempt ? `Attempt ${r.attempt}: ` : ""}${parts.join(" · ")}`;
}

/** D6: how the attempt answered the item's review entry, as a chip (a decline with its note in full). */
function ResolutionChip({ entry }: { entry: ResolutionEntry }) {
  if (entry.outcome === "declined") {
    return (
      <Chip kind="warn" className={REASON_CHIP} data-testid="resolution-chip">
        Declined: {entry.note}
      </Chip>
    );
  }
  if (entry.outcome === "not_applied") {
    return (
      <Chip kind="crit" className={REASON_CHIP} data-testid="resolution-chip">
        Not applied
      </Chip>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Chip kind="pass" className={REASON_CHIP} data-testid="resolution-chip">
        Done
      </Chip>
      {entry.note && <span className="text-sm text-text2 break-words">{entry.note}</span>}
    </span>
  );
}

// Reason chips wrap instead of cutting their label short (a phone is 390 px wide).
const REASON_CHIP = "h-auto! min-h-[26px] py-1 leading-4! whitespace-normal! text-left";

/** D8: the waiting checkpoint's shared draft as the items check uses it. */
interface DraftActs {
  review: CheckpointReview;
  meId: string | null;
  error: string | null;
  act: (body: ActionIn) => Promise<void>;
  stage: (actionId: string) => Promise<void>;
  undo: (actionId: string) => Promise<void>;
}
type DraftAction = CheckpointReview["items"][number]["actions"][number];
type FixAction = ItemReason["fixes"][number]["action"];

// Fixes that need a person's input (a section, a title) wait for the items review (D1).
const NEEDS_INPUT = ["horizon", "title", "outcome", "milestone_name", "prd_section"];
const complete = (a: FixAction) => !(a.kind === "edit" && NEEDS_INPUT.includes(a.field ?? "") && a.value == null);
const sameSlot = (a: { item_key: string; kind: string; field?: string | null }, b: FixAction) =>
  a.item_key === b.item && a.kind === b.kind && (a.field ?? null) === (b.field ?? null);

const ACTION_WORDS: Record<string, string> = {
  accept: "Accept",
  drop: "Drop",
  restore: "Keep",
  split: "Split",
  merge: "Merge",
  waive: "Waive",
  question: "Ask",
  look_again: "Look again",
  add: "Add",
};

/** An action in the words of the fix it applies, else of its kind. */
function actionLabel(a: DraftAction, reasons: ItemReason[]): string {
  const same = (f: FixAction) => sameSlot(a, f) && JSON.stringify(f.value ?? null) === JSON.stringify(a.value ?? null);
  const fix = reasons.flatMap((r) => r.fixes).find((f) => same(f.action));
  if (fix) return fix.label;
  if (a.kind === "edit") return `Edit ${(a.field ?? "").replace("clear:", "clear ").replace("_", " ")}`;
  return ACTION_WORDS[a.kind] ?? a.kind;
}

/** `summary`: the counts without the per-item reasons (a Roadmap items stop decided on its review screen). */
function ItemsCheckLine({ check, draft, summary = false }: { check: ItemsCheck; draft?: DraftActs; summary?: boolean }) {
  const horizons = Object.entries(check.by_horizon).map(([h, n]) => `${n} ${h}`);
  const reasons = check.reasons ?? [];
  // An item's problems read as its blocking reasons; the box keeps the file's own problems
  // (or every problem, for a check stored before reasons).
  const boxed = reasons.length > 0 ? check.problems.filter((p) => !p.item) : check.problems;
  const resolution = check.resolution ?? null;
  const counts = [
    check.blocking > 0 && `${check.blocking} blocking`,
    check.to_confirm > 0 && `${check.to_confirm} to confirm`,
  ].filter(Boolean);
  return (
    <div data-testid="items-check">
      <p className="flex flex-wrap items-center gap-2">
        <span className="tnum" data-testid="items-check-summary">
          {check.items} roadmap item{check.items === 1 ? "" : "s"}
          {horizons.length > 0 && `: ${horizons.join(", ")}`}
          {counts.map((c) => ` · ${c}`).join("")}
        </span>
        {check.problems.length === 0 && reasons.length === 0 ? (
          <Chip kind="pass">no problems</Chip>
        ) : (
          boxed.length > 0 && (
            <Chip kind="warn">
              {boxed.length} problem{boxed.length === 1 ? "" : "s"}
            </Chip>
          )
        )}
      </p>
      {resolution && (
        <p className="mt-1 tnum" data-testid="resolution-summary">
          {resolutionSummary(resolution)}
        </p>
      )}
      {check.reasons_partial && !summary && (
        <p className="mt-1 text-sm text-text2">Only the rule problems are listed: Oracle could not load what the other reasons read.</p>
      )}
      {reasons.length > 0 && !summary && (
        <ul className="mt-1.5 space-y-2" data-testid="items-reasons">
          {byItem(reasons).map((g) => (
            <li key={g.item} data-testid="item-reasons" data-item={g.item} className="min-w-0">
              <p className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium break-words">{g.title}</span>
                {resolution?.entries
                  .filter((e) => e.id === g.item)
                  .map((e, i) => <ResolutionChip key={`${e.action}-${i}`} entry={e} />)}
              </p>
              <ul className="mt-1 space-y-1.5">
                {g.reasons.map((r, i) => (
                  <li key={`${r.code}-${i}`} className="flex min-w-0 flex-col items-start gap-0.5 text-sm" data-testid="item-reason" data-code={r.code}>
                    <Chip kind={r.severity === "blocking" ? "crit" : "warn"} className={REASON_CHIP} data-testid="reason-chip">
                      {r.label}
                    </Chip>
                    <span className="break-words" data-testid="reason-text">
                      {r.text}
                    </span>
                    {fixText(r) && (
                      <span className="break-words text-text2" data-testid="reason-fixes">
                        {fixText(r)}
                      </span>
                    )}
                    {draft?.review.can_suggest && r.fixes.some((f) => complete(f.action)) && (
                      // D8: an approver stages a fix, a commenter suggests it (an approver stages it later).
                      <span className="flex flex-wrap gap-1.5" data-testid="reason-fix-buttons">
                        {r.fixes
                          .filter((f) => complete(f.action))
                          .map((f) => (
                            <Button
                              key={f.label}
                              className="h-8 px-2.5 text-sm"
                              title={`${draft.review.can_stage ? "Stage" : "Suggest"}: ${f.label}`}
                              onClick={() => {
                                const had = allActions(draft.review).find((a) => sameSlot(a, f.action));
                                const answers = f.action.item === r.item ? [r.code] : [];
                                void draft.act({
                                  item_key: f.action.item,
                                  kind: f.action.kind,
                                  field: f.action.field ?? null,
                                  value: f.action.value ?? null,
                                  answers: [...new Set([...(had?.answers ?? []), ...answers])],
                                });
                              }}
                            >
                              {f.label}
                            </Button>
                          ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {draft && <DraftActions draft={draft} item={g.item} reasons={reasons} />}
            </li>
          ))}
        </ul>
      )}
      {draft?.error && (
        <p className="mt-1.5 text-sm text-crit" role="alert">
          {draft.error}
        </p>
      )}
      {boxed.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 rounded-button bg-warn-bg px-3 py-1.5 text-sm text-warn" data-testid="items-check-problems">
          {boxed.map((p, i) => (
            <li key={i} className="break-words">
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const allActions = (review: CheckpointReview) => review.items.flatMap((i) => i.actions);

/** D8: what people staged or suggested on one item, who, and Stage / Undo for those who may. */
function DraftActions({ draft, item, reasons }: { draft: DraftActs; item: string; reasons: ItemReason[] }) {
  const actions = draft.review.items.find((i) => i.key === item)?.actions ?? [];
  if (actions.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1" data-testid="draft-actions">
      {actions.map((a) => {
        const who = a.created_by?.name ?? "someone";
        const mine = !!draft.meId && a.created_by?.id === draft.meId;
        return (
          <li key={a.id} data-testid="draft-action" data-state={a.state} className="flex flex-wrap items-center gap-2 text-sm">
            <Chip kind={a.state === "staged" ? "acc" : "line"} className={REASON_CHIP}>
              {actionLabel(a, reasons)} · {a.state === "staged" ? "Staged" : "Suggested"} by {who}
            </Chip>
            {a.state === "suggested" && draft.review.can_stage && (
              <Button className="h-8 px-2.5 text-sm" onClick={() => void draft.stage(a.id)}>
                Stage
              </Button>
            )}
            {(draft.review.can_stage || (mine && draft.review.can_suggest)) && (
              <Button className="h-8 px-2.5 text-sm" onClick={() => void draft.undo(a.id)}>
                Undo
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** D8: the waiting checkpoint's time left, in the decision's header. */
function WaitChip({ wait, forYou, role }: { wait: WaitInfo; forYou: boolean; role: string }) {
  if (wait.state === "none") return null;
  if (wait.state === "ended") {
    return (
      <Chip kind="na" className={REASON_CHIP} data-testid="wait-chip">
        Wait ended · deciding continues the run as a new workflow
      </Chip>
    );
  }
  const lead = forYou ? "Waiting for you" : `Waiting for an ${role} or above`;
  const s = wait.seconds_left;
  if (s == null) {
    return (
      <Chip kind="line" data-testid="wait-chip">
        {lead}
      </Chip>
    );
  }
  const left = s >= 3600 ? `${Math.floor(s / 3600)} h left` : `${Math.max(1, Math.floor(s / 60))} min left`;
  return (
    <Chip kind={s < 600 ? "crit" : s < 3600 ? "warn" : "line"} className={REASON_CHIP} data-testid="wait-chip">
      <Icon name="clock" size={16} />
      {lead} · {left}
    </Chip>
  );
}

/** D8: the shared draft as someone who does not decide it reads it: time left and the note. */
function SharedDraftLine({ review }: { review: CheckpointReview }) {
  return (
    <div data-testid="shared-draft" className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{CHECKPOINT_LABEL[review.kind]}: shared decision</span>
        <WaitChip wait={review.wait} forYou={false} role={review.approver_role} />
      </p>
      <p className="break-words text-text2" data-testid="shared-note">
        {review.note ? `Note for the agents: ${review.note}` : "No note for the agents yet."}
      </p>
    </div>
  );
}

/**
 * D8: a pending checkpoint's shared draft, read on mount and every 10 s while the page is
 * visible (paused while hidden, read at once when shown again). `accept` takes a write's
 * answer; an answer older than the one shown is ignored.
 */
function useDraft(runId: string, cpId: string | null) {
  const q = useQuery(`draft|${runId}|${cpId ?? ""}`, () =>
    cpId
      ? unwrap(api.GET("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review", { params: { path: { run_id: runId, checkpoint_id: cpId } } }))
      : Promise.resolve(null),
  );
  const { reload, setData } = q;
  const accept = useCallback(
    (out: CheckpointReview) =>
      setData((prev) => (!prev || prev.checkpoint_id !== out.checkpoint_id || out.revision >= prev.revision || out.status !== prev.status ? out : prev)),
    [setData],
  );
  useEffect(() => {
    if (!cpId) return;
    const read = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const t = setInterval(read, DRAFT_POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", read);
    };
  }, [cpId, reload]);
  return { review: q.data ?? null, accept, reload };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const FEATURE_FLAG_LABEL: Record<string, string> = {
  serves_no_goal: "serves no goal",
  low_confidence: "low confidence",
  linked_blocker: "linked blocker",
  new_feature: "new feature",
  duplicate_of_existing: "duplicate of existing",
};

/** C6: the check of feature_set.yaml, counts on one line; every problem in full and the flags per feature behind it. */
function FeatureSetCheckLine({ check }: { check: NonNullable<SegmentOut["feature_set_check"]> }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const n = check.problems.length;
  const counts = `Feature set: ${plural(check.features, "feature")}, ${plural(check.requirements, "requirement")}, ${check.excluded} left out`;
  const problems = n === 0 ? "no problems" : plural(n, "problem");
  const flagged = Object.entries(check.flags ?? {}).filter(([, f]) => f.length > 0);
  return (
    <div data-testid="feature-set-check">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${counts} · ${problems}`}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full flex-wrap items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="tnum">{counts}</span>
        <Chip kind={n === 0 ? "pass" : "warn"}>{problems}</Chip>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} className="text-text2" />
      </button>
      {open && (
        <div id={listId}>
          {n > 0 && (
            <ul data-testid="feature-set-problems" className="mt-1.5 space-y-0.5 rounded-button bg-warn-bg px-3 py-1.5 text-sm text-warn">
              {check.problems.map((p, i) => (
                <li key={i} className="break-words">
                  {p.message}
                </li>
              ))}
            </ul>
          )}
          {flagged.length > 0 && (
            <ul data-testid="feature-set-flags" className="mt-1.5 space-y-0.5 text-sm text-text2">
              {flagged.map(([key, flags]) => (
                <li key={key} className="break-words">
                  <span className="font-mono text-[13px] text-text">{key}</span>: {flags.map((f) => FEATURE_FLAG_LABEL[f] ?? f.replaceAll("_", " ")).join(", ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** B2: "Review in Baseline · 3 need you", the run's rows in the Baseline (the files stay below). */
function FromRunLink({ runId }: { runId: string }) {
  const q = useQuery(`baseline-from-run:${runId}`, () => unwrap(api.GET("/v1/baseline/from-run/{run_id}", { params: { path: { run_id: runId } } })));
  return (
    <p className="mt-2">
      <LinkButton href={`/baseline?run=${runId}`} icon="baseline">
        Review in Baseline{q.data ? ` · ${q.data.summary.need_you} need you` : ""}
      </LinkButton>
    </p>
  );
}

/** D7: the file an approval with edits changed (the API's review names it; roadmap items' otherwise). */
const editedFile = (cp: CheckpointOut) => (typeof cp.review?.file === "string" ? cp.review.file : "roadmap_items.yaml");

/** D7: "Approved with 3 edits · View": what Oracle applied to the agents' file, opened in place. */
function AppliedEditsLine({ cp }: { cp: CheckpointOut }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const applied = Array.isArray(cp.review?.applied) ? (cp.review.applied as { id?: string; text?: string }[]) : [];
  const n = typeof cp.review?.edits === "number" ? cp.review.edits : applied.length;
  return (
    <div data-testid="approved-edits">
      <p className="text-text2">
        Approved with {plural(n, "edit")} ·{" "}
        <button
          type="button"
          className="font-medium text-accent-ink hover:underline"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          View
        </button>
      </p>
      {open && (
        <ul id={listId} className="mt-1 list-disc space-y-0.5 pl-5 text-sm" data-testid="applied-edits">
          {applied.map((a, i) => (
            <li key={i} className="break-words">
              {a.text ?? a.id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** D4: "Sent back · 3 entries · View review": the review.yaml the agents got, opened in place. */
function SentReviewLine({ runId, cp }: { runId: string; cp: CheckpointOut }) {
  const [text, setText] = useState<string | null>(null);
  const entries = Array.isArray(cp.review?.items) ? cp.review.items.length : 0;
  async function toggle() {
    if (text != null) return setText(null);
    setText("Loading…");
    const { data, response } = await api.GET("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review.yaml", {
      params: { path: { run_id: runId, checkpoint_id: cp.id } },
      parseAs: "text",
    });
    setText(response.ok ? (data as string) : `Could not load the review (${response.status}).`);
  }
  return (
    <div data-testid="sent-review">
      {cp.kind === "baseline_confirm" && cp.note && (
        // B2: the structured note the agents got (3.1 (7)).
        <pre className="mb-1.5 font-sans whitespace-pre-wrap text-text2" data-testid="sent-back-note">
          {cp.note}
        </pre>
      )}
      <p className="text-text2">
        Sent back · {entries} {entries === 1 ? "entry" : "entries"} ·{" "}
        <button type="button" className="font-medium text-accent-ink hover:underline" aria-expanded={text != null} onClick={() => void toggle()}>
          View review
        </button>
      </p>
      {text != null && (
        <pre className="mt-1.5 max-h-96 overflow-auto rounded-button border border-line bg-surface2 p-2.5 font-mono text-[13px] whitespace-pre-wrap" data-testid="sent-review-yaml">
          {text}
        </pre>
      )}
    </div>
  );
}

function Artifacts({
  runId,
  seq,
  names,
  previous,
  edited = [],
}: {
  runId: string;
  seq: number;
  names: string[];
  previous: { attempt: number; artifacts: string[] } | null;
  /** D7: files an approver's edits changed; the agents' original of each is offered too. */
  edited?: string[];
}) {
  // The open file: its name and, for the previous attempt's files, that attempt's number; or
  // the agents' original of an edited file.
  const [open, setOpen] = useState<{ name: string; attempt: number | null; agents?: boolean } | null>(null);
  const [content, setContent] = useState<string>("");
  const isOpen = (name: string, attempt: number | null, agents = false) => open?.name === name && open.attempt === attempt && !!open.agents === agents;
  async function show(name: string, attempt: number | null, agents = false) {
    if (isOpen(name, attempt, agents)) return setOpen(null);
    setOpen({ name, attempt, agents });
    setContent("Loading…");
    const query = agents ? { agents: true } : attempt == null ? {} : { attempt };
    const { data, response } = await api.GET("/v1/runs/{run_id}/segments/{seq}/artifacts/{name}", {
      params: { path: { run_id: runId, seq, name }, query },
      parseAs: "text",
    });
    setContent(response.ok ? (data as string) : `Could not load ${name} (${response.status}).`);
  }
  const file = (name: string, attempt: number | null) => {
    const on = isOpen(name, attempt);
    return (
      <button
        key={name}
        type="button"
        onClick={() => void show(name, attempt)}
        aria-expanded={on}
        className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 font-mono text-[13px] ${
          on ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-surface text-text hover:bg-surface2"
        }`}
      >
        <Icon name="doc" size={16} />
        {name}
      </button>
    );
  };
  return (
    <div>
      {names.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="artifacts-current">
          {names.map((n) => file(n, null))}
          {edited.map((n) => (
            // D7: an approver's edits changed this file; the agents' original is kept.
            <button
              key={`agents-${n}`}
              type="button"
              onClick={() => void show(n, null, true)}
              aria-expanded={isOpen(n, null, true)}
              title={`${n} as the agents wrote it, before the approver's edits`}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[13px] ${
                isOpen(n, null, true) ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-surface text-text hover:bg-surface2"
              }`}
            >
              <Icon name="doc" size={16} />
              Agents&apos; file
            </button>
          ))}
        </div>
      )}
      {previous && previous.artifacts.length > 0 && (
        // A person sent the segment back: what the attempt before this one wrote, kept to compare.
        <div
          role="group"
          aria-label={`Previous attempt (attempt ${previous.attempt})`}
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="artifacts-previous"
        >
          <span className="text-[13px] text-text2">Previous attempt (attempt {previous.attempt}):</span>
          {previous.artifacts.map((n) => file(n, previous.attempt))}
        </div>
      )}
      {open && (
        <pre
          className="mt-2 max-h-80 overflow-auto rounded-button border border-line bg-surface2 p-3 font-mono text-[13px] whitespace-pre-wrap text-text"
          data-testid="artifact-content"
        >
          {content}
        </pre>
      )}
    </div>
  );
}

function CheckpointRow({
  cp,
  run,
  busy,
  onDecide,
  anchor,
  note,
  onNote: setNote,
  noteRef,
  review,
  onSaveNote,
  onReload,
  onWaive,
}: {
  cp: CheckpointOut;
  run: RunOut;
  busy: boolean;
  onDecide: Decide;
  anchor?: boolean;
  note: string;
  onNote: (note: string) => void;
  noteRef: (el: HTMLTextAreaElement | null) => void;
  /** D8: the checkpoint's shared draft, once read. */
  review: CheckpointReview | null;
  onSaveNote: (note: string) => Promise<void>;
  onReload: () => Promise<void>;
  /** D3: stage a waiver in the shared draft (the approver role or above). */
  onWaive?: (body: ActionIn) => Promise<void>;
}) {
  // D8: the note is saved to the shared draft as I type; the line under it says how it went.
  const saved = review?.note ?? "";
  const canSave = !!review?.can_stage;
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const saveNow = useCallback(() => {
    setSave("saving");
    onSaveNote(note).then(
      () => setSave("saved"),
      () => setSave("failed"),
    );
  }, [note, onSaveNote]);
  useEffect(() => {
    if (!canSave || note === saved) return;
    const t = setTimeout(saveNow, NOTE_SAVE_MS);
    return () => clearTimeout(t);
    // onSaveNote is a new function on every render: the note and what is saved decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, saved, canSave]);
  const status = save === "failed" ? "failed" : note !== saved ? (save === "saving" ? "saving" : null) : save === "saved" ? "saved" : null;
  // The draft changed since I loaded it: my decision was refused (nothing decided).
  const [changed, setChanged] = useState<string | null>(null);
  const decideWith = (decision: CheckpointChoice) => onDecide(cp, decision, note, review?.revision ?? null, setChanged);
  const answer = cp.console;
  // A counted console change request the workflow went on past: Redo or Continue only.
  const redoOrContinue = answer?.needs === "redo_or_continue";
  // D4: a send-back carries the staged actions as a structured review; with none, the note.
  const staged = !!review?.items.some((i) => i.actions.some((a) => a.state === "staged"));
  // Redo carries the console's findings, else the note: the API refuses it without either.
  const redoBlocked = !answer?.can_redo && !note.trim();
  // D3: the approve gate, the draft's read first (it moves as soon as a waiver is staged).
  const gate = review?.gate ?? cp.gate ?? null;
  const closed = gate && !gate.open ? gate : null;
  const left = closed ? closed.blocking_open + closed.file_problems : 0;
  // Any other refusal (the draft was not imported, the feature set's problems) as the API says it.
  const other = cp.cannot_approve && cp.cannot_approve !== gateMessage(cp.gate) ? cp.cannot_approve : null;
  // D7: with edits staged, Approve applies them and re-checks the file, so the gate is Oracle's
  // to read again then; a split, merge or open question needs the agents, so Approve waits.
  const label = cp.approve_label ?? "Approve";
  const withEdits = label !== "Approve";
  const agentsOnly = needsAgentsText(cp.needs_agents ?? []);
  const refusal = other ?? (closed && !withEdits ? gateMessage(closed) : null);
  const approveBlocked = refusal ? `${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}.` : agentsOnly;
  const confirmBlocked = other ? approveBlocked : closed ? `${plural(left, "blocking problem")} left` : null;
  // G1: talk the checkpoint through with the team before deciding, in a sheet.
  const [discussing, setDiscussing] = useState(false);
  return (
    <div
      id={anchor ? "decide" : undefined}
      // Decide in the header focuses it; the keyboard continues from here.
      tabIndex={anchor ? -1 : undefined}
      role="group"
      aria-label={`Decide: ${CHECKPOINT_LABEL[cp.kind]}`}
      className="scroll-mt-24 rounded-button border border-line bg-surface p-3 focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      data-testid={`checkpoint-${cp.kind}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="flag" size={16} className="text-accent-ink" />
        <span className="font-semibold">{CHECKPOINT_LABEL[cp.kind]}</span>
        <Chip kind={CP_KIND[cp.status]}>
          <Icon name="clock" size={16} />
          {CP_LABEL[cp.status]}
        </Chip>
        <Chip kind="line" title={`Needs an ${cp.approver_role} or above`}>
          <Icon name="user" size={16} />
          {cp.approver_role}+
        </Chip>
        {review && <WaitChip wait={review.wait} forYou role={cp.approver_role} />}
      </div>
      {cp.kind === "baseline_confirm" && <FromRunLink runId={run.id} />}
      {cp.note && (
        <p className="mt-1.5 text-text2">
          <CodeText text={cp.note} />
        </p>
      )}
      {answer && <ConsolePanel answer={answer} held={answer.needs === "confirm" && answer.verdict === "MERGE" && !!closed} />}
      {other && (
        <p className="mt-2 text-sm text-warn" data-testid="cannot-approve">
          {approveBlocked}
        </p>
      )}
      {!other && agentsOnly && (
        <p className="mt-2 text-sm text-warn" data-testid="needs-agents">
          {agentsOnly}
        </p>
      )}
      {cp.kind === "feature_set" && reviewHref(cp) && cp.status === "pending" && (
        // C7: the feature set is reviewed row by row on its own screen; the raw files stay below.
        <p className="mt-2">
          <LinkButton href={reviewHref(cp)!} variant="solid" icon="flag">
            Review feature set
          </LinkButton>
        </p>
      )}
      {orderHref(cp) && (
        // C8: the run's order next to Oracle's live ranking, where it can also be decided.
        <p className="mt-2">
          <LinkButton href={orderHref(cp)!} icon="priorities">
            Review the order
          </LinkButton>
        </p>
      )}
      <textarea
        ref={noteRef}
        aria-label="Note for the agents"
        placeholder={redoOrContinue ? "Note (optional, added to the findings)" : staged ? "Note (optional with staged changes)" : "Note (required to request changes)"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className={`${INPUT} mt-2.5 placeholder:text-text2`}
      />
      {status && (
        <p className={`mt-1 text-sm ${status === "failed" ? "text-crit" : "text-text2"}`} data-testid="note-status" aria-live="polite">
          {status === "saved" && "Saved"}
          {status === "saving" && "Saving…"}
          {status === "failed" && (
            <>
              Not saved:{" "}
              <button type="button" className="font-medium underline" onClick={saveNow}>
                retry
              </button>
            </>
          )}
        </p>
      )}
      {changed && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="review-changed" role="alert">
          <span className="min-w-0 flex-1 break-words">{changed}</span>
          <Button className="h-8 px-2.5 text-sm" onClick={() => void onReload().then(() => setChanged(null))}>
            Reload
          </Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {redoOrContinue ? (
          <>
            <Button
              variant="solid"
              icon="check"
              disabled={busy || !!approveBlocked}
              title={approveBlocked ?? undefined}
              onClick={() => decideWith("continue")}
            >
              Continue
            </Button>
            <Button
              disabled={busy || redoBlocked}
              title={redoBlocked ? "No findings were recorded: write a note to redo" : undefined}
              onClick={() => decideWith("redo")}
            >
              Redo from {answer.redo_segment} (+{usd(answer.redo_cost_usd)}, one more segment)
            </Button>
          </>
        ) : (
          <>
            {answer?.needs === "confirm" && (
              <Button
                variant="solid"
                icon="check"
                disabled={busy || (answer.verdict === "MERGE" && !!confirmBlocked)}
                title={answer.verdict === "MERGE" ? (confirmBlocked ?? undefined) : undefined}
                onClick={() => decideWith("confirm")}
              >
                Confirm {answer.verdict === "MERGE" ? "approval" : "change request"}
              </Button>
            )}
            <Button
              variant={answer?.needs === "confirm" ? "secondary" : "solid"}
              icon={answer?.needs === "confirm" ? undefined : "check"}
              disabled={busy || !!approveBlocked}
              title={approveBlocked ?? undefined}
              onClick={() => decideWith("approved")}
            >
              {withEdits ? label : "Approve and continue"}
            </Button>
            <Button
              disabled={busy || (!note.trim() && !staged)}
              title={!note.trim() && !staged ? "Stage a change, ask a question, or write a note to send back." : undefined}
              onClick={() => decideWith("changes_requested")}
            >
              Request changes
            </Button>
            {(answer?.needs === "unreadable" || answer?.needs === "unread") && (
              <Button disabled={busy || redoBlocked} onClick={() => decideWith("redo")}>
                Redo from {answer.redo_segment} (+{usd(answer.redo_cost_usd)})
              </Button>
            )}
          </>
        )}
        <Button variant="ghost" icon="comment" onClick={() => setDiscussing(true)}>
          Discuss
        </Button>
      </div>
      {closed && (
        <GateList
          gate={closed}
          message={
            withEdits && !other
              ? `${plural(left, "blocking problem")} open before your edits: Oracle checks the file again once it applies them.`
              : approveBlocked!
          }
          onWaive={review?.can_stage ? onWaive : undefined}
        />
      )}
      <Sheet open={discussing} title={`Discuss: ${CHECKPOINT_LABEL[cp.kind]}`} onClose={() => setDiscussing(false)} testId="sheet-discuss">
        <div className="px-4 py-3">
          <DiscussSubject
            subjectKey={`checkpoint:${run.id}:${cp.kind}`}
            subject={{
              kind: "checkpoint",
              subject: { run_id: run.id, checkpoint_id: cp.id },
              label: `${run.flow_title} · ${CHECKPOINT_LABEL[cp.kind]}`,
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

const CONSOLE_NEEDS: Record<ConsoleAnswer["needs"], string> = {
  confirm:
    "It does not count on its own: an approver confirms it or decides otherwise. Until then the run's agents may read Oracle but not write to it.",
  redo_or_continue:
    "The workflow had no revision step here and went on regardless. Redo runs this segment again as a new workflow with the findings; Continue keeps what ran.",
  unreadable: "Oracle could not read the recorded verdict. Approving follows the workflow; Redo runs the segment again.",
  unread:
    "Oracle has not read the answer yet and reads it again each minute. Until then the run's agents may read Oracle but not write to it.",
};

/** D7: what needs the agents, one sentence each ("Split on budget-caps needs the agents: …"). */
function needsAgentsText(list: NonNullable<CheckpointOut["needs_agents"]>): string | null {
  if (list.length === 0) return null;
  return list.map((x) => `${x.kind.charAt(0).toUpperCase()}${x.kind.slice(1)} on ${x.item} needs the agents: send back, or remove it to approve.`).join(" ");
}

/** As oracle.runs.gate.message: why Approve is refused while the gate is closed (D3). */
function gateMessage(gate: CheckpointOut["gate"] | undefined): string | null {
  if (!gate || gate.open) return null;
  return `${plural(gate.blocking_open + gate.file_problems, "blocking problem")} left: fix or waive them, or send back to the agents`;
}

/** D3: the blocking reasons still open under the decision, each waivable one with Waive…. */
function GateList({ gate, message, onWaive }: { gate: NonNullable<CheckpointOut["gate"]>; message: string; onWaive?: (body: ActionIn) => Promise<void> }) {
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const key = (x: { item: string; code: string }) => `${x.item}|${x.code}`;
  return (
    <div className="mt-2 text-sm" data-testid="approve-gate">
      <p className="text-warn">{message}</p>
      <ul className="mt-1 space-y-1">
        {gate.left.map((x) => (
          <li key={key(x)} data-testid="gate-reason">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{x.item_title ?? x.item}</span>
              <Chip kind="crit" className={REASON_CHIP}>
                {x.label}
              </Chip>
              {x.waivable && onWaive && waiving !== key(x) && (
                <button
                  type="button"
                  className="font-medium text-accent-ink underline"
                  onClick={() => {
                    setWaiving(key(x));
                    setReason("");
                  }}
                >
                  Waive…
                </button>
              )}
            </div>
            {waiving === key(x) && onWaive && (
              <form
                className="mt-1 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setBusy(true);
                  void onWaive({ item_key: x.item, kind: "waive", answers: [x.code], value: { reason: reason.trim() } }).finally(() => {
                    setBusy(false);
                    // Another reason's form may have opened meanwhile: only this one closes.
                    setWaiving((open) => (open === key(x) ? null : open));
                  });
                }}
              >
                <input
                  aria-label={`Reason to waive: ${x.label}`}
                  placeholder="Why this is fine for now"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={`${INPUT} h-8 min-w-0 flex-1`}
                />
                <Button type="submit" className="h-8 px-2.5 text-sm" disabled={busy || !reason.trim()}>
                  Waive
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who answered in SwarmCloud's console and what Oracle still needs; the why sits in the (i). */
function ConsolePanel({ answer: c, held = false }: { answer: ConsoleAnswer; held?: boolean }) {
  return (
    <div className="mt-2 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="console-answer">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        <span>
          Answered in SwarmCloud by <span className="font-semibold">{c.answered_by ?? "someone"}</span>
          {c.via && ` via ${c.via}`}
          {c.verdict && (
            <>
              : <span className="font-semibold">{c.verdict === "MERGE" ? "approved" : "changes requested"}</span>
            </>
          )}
        </span>
        {c.answered_at && <span className="tnum">{formatDateTime(c.answered_at)}</span>}
        <InfoTip label="the SwarmCloud answer" align="start" side="bottom">
          {CONSOLE_NEEDS[c.needs]}
        </InfoTip>
      </div>
      {c.findings.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {c.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {c.reason && c.counted === false && <p className="mt-1">Not counted: {c.reason}.</p>}
      {held && <p className="mt-1">Blocking problems are open: fix or waive them, then confirm</p>}
    </div>
  );
}

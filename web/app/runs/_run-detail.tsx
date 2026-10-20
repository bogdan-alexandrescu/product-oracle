"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SourceLink } from "@/components/BuildRoadmap";
import {
  Button,
  Chip,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  Split,
  type ChipKind,
} from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import {
  CANCEL_AGAIN_CONFIRM,
  CHECKPOINT_LABEL,
  FINAL_STATUSES,
  RETRY_CONFIRM,
  RUN_STATUS_LABEL,
  RunStatusBadge,
  STOP_CANCELLING_CONFIRM,
  RunsWhere,
  SEGMENT_STATUS_KIND,
  SEGMENT_STATUS_LABEL,
  SpendBar,
  shortId,
  usd,
  type CheckpointChoice,
  type CheckpointOut,
  type ConsoleAnswer,
  type RunOut,
  type SegmentOut,
} from "./_lib";

const POLL_MS = 5000;

type Decide = (cp: CheckpointOut, decision: CheckpointChoice, note: string) => void;

export function RunDetail({ id }: { id: string }) {
  const q = useQuery(`run|${id}`, () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: id } } })));
  const { me, role } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = q.data;
  const { reload } = q;

  // Agents work in the background: re-read while the run is moving.
  const moving = run?.status === "running";
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [moving, reload]);

  async function act(call: () => Promise<RunOut | unknown>) {
    setBusy(true);
    setError(null);
    try {
      const out = await call();
      if (out && typeof out === "object" && "segments" in out) q.setData(() => out as RunOut);
      else await q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const path = { params: { path: { run_id: id } } };
  const owner = role === "owner";
  const mayManage = owner || (hasRole(role, "approver") && run?.created_by === me?.user_id);
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

  const decide: Decide = (cp, decision, note) =>
    act(() =>
      unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          params: { path: { run_id: id, checkpoint_id: cp.id } },
          body: { decision, note: note || null },
        }),
      ),
    );
  const done = run.segments.filter((s) => s.status === "succeeded").length;
  const deciding = run.checkpoints.some((c) => c.status === "pending" && c.can_decide);
  const open = !FINAL_STATUSES.includes(run.status) && run.status !== "draft";

  return (
    <Page>
      <PageHeader
        back={back}
        title={run.flow_title}
        status={
          <>
            <RunStatusBadge status={run.status} />
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
          </>
        }
        action={
          <>
            {owner && run.status === "awaiting_approval" && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/approve", path)))}>
                Approve {usd(run.estimate_usd)} and start
              </Button>
            )}
            {deciding && (
              // The run waits on a checkpoint this member decides: jump to its decision.
              <LinkButton variant="primary" href="#decide" icon="flag">
                Decide
              </LinkButton>
            )}
            {owner && run.status === "paused_overrun" && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/resume", path)))}>
                Resume
              </Button>
            )}
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
              mayManage && (
                <>
                  {run.can_retry && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(RETRY_CONFIRM)) {
                          void act(() => unwrap(api.POST("/v1/runs/{run_id}/retry", path)));
                        }
                      }}
                    >
                      Retry
                    </Button>
                  )}
                  {run.can_stop_cancelling && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(STOP_CANCELLING_CONFIRM)) {
                          void act(() => unwrap(api.POST("/v1/runs/{run_id}/stop-cancelling", path)));
                        }
                      }}
                    >
                      Stop cancelling
                    </Button>
                  )}
                  {run.can_retry_lookup && (
                    <Button disabled={busy} onClick={() => void act(() => unwrap(api.POST("/v1/runs/{run_id}/retry-lookup", path)))}>
                      Retry lookup
                    </Button>
                  )}
                  {(run.cancel_again ?? []).map((wid, _, all) => (
                    <Button
                      key={wid}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(CANCEL_AGAIN_CONFIRM)) {
                          void act(() => unwrap(api.POST("/v1/runs/{run_id}/cancel-again", { ...path, body: { workflow_id: wid } })));
                        }
                      }}
                    >
                      {all.length > 1 ? `Cancel again ${wid}` : "Cancel again"}
                    </Button>
                  ))}
                  {run.can_dismiss_overrun && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(() => unwrap(api.POST("/v1/runs/{run_id}/dismiss-overrun", path)))}
                    >
                      Dismiss
                    </Button>
                  )}
                </>
              )
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
              owner &&
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
              {owner && open && (
                <Button variant="ghost" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/internal/tick")))}>
                  Check agents now
                </Button>
              )}
              {mayManage && !FINAL_STATUSES.includes(run.status) && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Cancel this run? Agents still working are stopped.")) {
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
              />
            ))}
          </ol>
        </Panel>
      </Split>
    </Page>
  );
}

/** The run in the inspector: what it waits on, its cost (P3d: small unless approval or overrun), details. */
function RunInspector({ run }: { run: RunOut }) {
  const current =
    run.segments.find((s) => s.status === "running") ??
    run.segments.find((s) => run.checkpoints.some((c) => c.segment_seq === s.seq && c.status === "pending")) ??
    [...run.segments].reverse().find((s) => s.status !== "pending") ??
    run.segments[0];
  const waiting = run.waiting_on;
  const approval = run.status === "awaiting_approval";
  const overrun = run.status === "paused_overrun";
  const prominent = approval ? "bg-warn-bg text-warn" : overrun ? "bg-crit-bg text-crit" : "";
  return (
    <Inspector
      label="Run"
      eyebrow={waiting ? "Checkpoint · waiting" : `Run · ${RUN_STATUS_LABEL[run.status].toLowerCase()}`}
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
      <InspectorSection
        label={approval ? "Cost approval" : overrun ? "Overrun" : "Cost"}
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
            {run.segments.map((s) => (
              <span key={s.id} className="block">
                {s.seq}. {s.title}: {usd(s.cost_usd)} / {usd(s.estimate_usd)}
              </span>
            ))}
          </InfoTip>
        }
      >
        <div className="mb-2.5 flex items-center">
          <span
            className={`tnum inline-flex items-center gap-1 font-mono font-medium whitespace-nowrap ${
              prominent ? `h-7 rounded-lg px-2 text-[15px] ${prominent}` : "text-[13px] text-text2"
            }`}
          >
            <span data-testid="run-spent">{usd(run.spent_usd)}</span>
            <span>/ {usd(run.estimate_usd)} est.</span>
          </span>
        </div>
        <SpendBar spent={run.spent_usd} estimate={run.estimate_usd ?? null} ceiling={run.overrun_ceiling_usd ?? null} />
      </InspectorSection>
      <InspectorSection label="Details">
        <InspectorRow value={<span className="capitalize">{run.knobs.depth}</span>}>Depth</InspectorRow>
        <InspectorRow value={formatDateTime(run.created_at)}>Created</InspectorRow>
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
    </Inspector>
  );
}

const CP_KIND: Record<CheckpointOut["status"], ChipKind> = {
  pending: "warn",
  approved: "pass",
  changes_requested: "warn",
  skipped: "na",
};
/** A checkpoint name in full: it wraps to a second line rather than truncating. */
const WRAP_CHIP = "h-auto min-h-[26px] py-1 leading-4 whitespace-normal";
const CP_LABEL = { pending: "Waiting", approved: "Approved", changes_requested: "Changes requested", skipped: "Skipped" } as const;

function SegmentItem({
  run,
  segment: s,
  checkpoints,
  busy,
  onDecide,
}: {
  run: RunOut;
  segment: SegmentOut;
  checkpoints: CheckpointOut[];
  busy: boolean;
  onDecide: Decide;
}) {
  const kind = s.checkpoint;
  const deciding = checkpoints.filter((c) => c.status === "pending" && c.can_decide);
  const compact = checkpoints.filter((c) => !(c.status === "pending" && c.can_decide));
  const waiting = checkpoints.some((c) => c.status === "pending");
  const details = s.error || s.items_check || s.draft_import || s.artifacts.length > 0 || deciding.length > 0;
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
          <Chip kind={SEGMENT_STATUS_KIND[s.status]}>
            {s.status === "succeeded" && <Icon name="check" size={16} />}
            {SEGMENT_STATUS_LABEL[s.status]}
          </Chip>
        </span>
        <span className="flex min-w-0 flex-wrap gap-1.5 max-[600px]:col-span-full max-[600px]:col-start-2">
          {checkpoints.length === 0 &&
            (s.checkpoint_on ? (
              <Chip kind="line" title={`Stops for ${CHECKPOINT_LABEL[kind].toLowerCase()}`} className={WRAP_CHIP}>
                <span className="sr-only">Stops for </span>
                {CHECKPOINT_LABEL[kind]}
              </Chip>
            ) : (
              <Chip kind="na" title={`${CHECKPOINT_LABEL[kind]}: off`} className={WRAP_CHIP}>
                {CHECKPOINT_LABEL[kind]}: off
              </Chip>
            ))}
          {deciding.length > 0 && (
            // The decision panel below and the inspector name the checkpoint; the row shows its state.
            <a
              href="#decide"
              data-testid="checkpoint-waiting"
              className="inline-flex max-w-full rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Chip kind="warn" title={`Waiting: ${deciding.map((cp) => CHECKPOINT_LABEL[cp.kind]).join(", ")}`}>
                <Icon name="clock" size={16} />
                Waiting
                <span className="sr-only">: {deciding.map((cp) => CHECKPOINT_LABEL[cp.kind]).join(", ")}</span>
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
                {cp.status === "approved" && <Icon name="check" size={16} />}
                {cp.status === "pending" && <Icon name="clock" size={16} />}
                {CP_LABEL[cp.status]}
                {cp.status === "pending" && <span className="sr-only"> for an {cp.approver_role} or above</span>}
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
          {s.items_check && <ItemsCheckLine check={s.items_check} />}
          {s.draft_import && <DraftImportLine imp={s.draft_import} />}
          {s.artifacts.length > 0 && <Artifacts runId={run.id} seq={s.seq} names={s.artifacts} />}
          {deciding.map((cp, i) => (
            <CheckpointRow key={cp.id} cp={cp} busy={busy} onDecide={onDecide} anchor={i === 0} />
          ))}
        </div>
      )}
    </li>
  );
}

function DraftImportLine({ imp }: { imp: NonNullable<SegmentOut["draft_import"]> }) {
  if (imp.error) return <p className="text-crit">Draft not imported: {imp.error}</p>;
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

/** O4b: the check of roadmap_items.yaml, counts by horizon and every problem found. */
function ItemsCheckLine({ check }: { check: NonNullable<SegmentOut["items_check"]> }) {
  const horizons = Object.entries(check.by_horizon).map(([h, n]) => `${n} ${h}`);
  return (
    <div data-testid="items-check">
      <p className="flex flex-wrap items-center gap-2">
        <span className="tnum">
          {check.items} roadmap item{check.items === 1 ? "" : "s"}
          {horizons.length > 0 && `: ${horizons.join(", ")}`}
        </span>
        {check.problems.length === 0 ? (
          <Chip kind="pass">no problems</Chip>
        ) : (
          <Chip kind="warn">
            {check.problems.length} problem{check.problems.length === 1 ? "" : "s"}
          </Chip>
        )}
      </p>
      {check.problems.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 rounded-button bg-warn-bg px-3 py-1.5 text-sm text-warn">
          {check.problems.map((p, i) => (
            <li key={i} className="truncate" title={p.message}>
              {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Artifacts({ runId, seq, names }: { runId: string; seq: number; names: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  async function show(name: string) {
    if (open === name) return setOpen(null);
    setOpen(name);
    setContent("Loading…");
    const { data, response } = await api.GET("/v1/runs/{run_id}/segments/{seq}/artifacts/{name}", {
      params: { path: { run_id: runId, seq, name } },
      parseAs: "text",
    });
    setContent(response.ok ? (data as string) : `Could not load ${name} (${response.status}).`);
  }
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => void show(n)}
            aria-expanded={open === n}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 font-mono text-[13px] ${
              open === n ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-surface text-text hover:bg-surface2"
            }`}
          >
            <Icon name="doc" size={16} />
            {n}
          </button>
        ))}
      </div>
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

function CheckpointRow({ cp, busy, onDecide, anchor }: { cp: CheckpointOut; busy: boolean; onDecide: Decide; anchor?: boolean }) {
  const [note, setNote] = useState("");
  const answer = cp.console;
  // A counted console change request the workflow went on past: Redo or Continue only.
  const redoOrContinue = answer?.needs === "redo_or_continue";
  // Redo carries the console's findings, else the note: the API refuses it without either.
  const redoBlocked = !answer?.can_redo && !note.trim();
  return (
    <div
      id={anchor ? "decide" : undefined}
      className="scroll-mt-24 rounded-button border border-line bg-surface p-3"
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
      </div>
      {cp.note && <p className="mt-1.5 text-text2">{cp.note}</p>}
      {answer && <ConsolePanel answer={answer} />}
      <textarea
        aria-label="Note for the agents"
        placeholder={redoOrContinue ? "Note (optional, added to the findings)" : "Note (required to request changes)"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className={`${INPUT} mt-2.5 placeholder:text-text2`}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {redoOrContinue ? (
          <>
            <Button variant="solid" icon="check" disabled={busy} onClick={() => onDecide(cp, "continue", note)}>
              Continue
            </Button>
            <Button
              disabled={busy || redoBlocked}
              title={redoBlocked ? "No findings were recorded: write a note to redo" : undefined}
              onClick={() => onDecide(cp, "redo", note)}
            >
              Redo from {answer.redo_segment} (+{usd(answer.redo_cost_usd)}, one more segment)
            </Button>
          </>
        ) : (
          <>
            {answer?.needs === "confirm" && (
              <Button variant="solid" icon="check" disabled={busy} onClick={() => onDecide(cp, "confirm", note)}>
                Confirm {answer.verdict === "MERGE" ? "approval" : "change request"}
              </Button>
            )}
            <Button
              variant={answer?.needs === "confirm" ? "secondary" : "solid"}
              icon={answer?.needs === "confirm" ? undefined : "check"}
              disabled={busy}
              onClick={() => onDecide(cp, "approved", note)}
            >
              Approve and continue
            </Button>
            <Button disabled={busy || !note.trim()} onClick={() => onDecide(cp, "changes_requested", note)}>
              Request changes
            </Button>
            {(answer?.needs === "unreadable" || answer?.needs === "unread") && (
              <Button disabled={busy || redoBlocked} onClick={() => onDecide(cp, "redo", note)}>
                Redo from {answer.redo_segment} (+{usd(answer.redo_cost_usd)})
              </Button>
            )}
          </>
        )}
      </div>
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

/** Who answered in SwarmCloud's console and what Oracle still needs; the why sits in the (i). */
function ConsolePanel({ answer: c }: { answer: ConsoleAnswer }) {
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
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SourceLink } from "@/components/BuildRoadmap";
import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import {
  CHECKPOINT_LABEL,
  FINAL_STATUSES,
  RETRY_CONFIRM,
  RunStatusBadge,
  STOP_CANCELLING_CONFIRM,
  RunsWhere,
  SEGMENT_STATUS_TONE,
  SpendBar,
  usd,
  type CheckpointChoice,
  type CheckpointOut,
  type ConsoleAnswer,
  type RunOut,
  type SegmentOut,
} from "./_lib";

const POLL_MS = 5000;

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

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/runs" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Runs
        </Link>
      </p>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!run && !q.error && <Loading />}
      {run && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{run.flow_title}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
                <RunStatusBadge status={run.status} />
                {run.document_slug &&
                  (run.document_id ? (
                    <Link href={`/documents/${run.document_slug}`} className="font-mono hover:underline">
                      {run.document_slug}
                    </Link>
                  ) : (
                    <span className="font-mono">{run.document_slug} (new)</span>
                  ))}
                {run.source && (
                  <span>
                    · <SourceLink source={run.source} />
                  </span>
                )}
                {run.template && (
                  <span>
                    · template {run.template}
                    {run.theme && `, theme ${run.theme}`}
                  </span>
                )}
                <span>· depth {run.knobs.depth}</span>
                <span>· created {formatDateTime(run.created_at)}</span>
                {run.snapshot_as_of && <span>· sources as of {formatDateTime(run.snapshot_as_of)}</span>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {owner && !FINAL_STATUSES.includes(run.status) && run.status !== "draft" && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/internal/tick")))}>
                  Check agents now
                </Button>
              )}
              {owner && run.status === "awaiting_approval" && (
                <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/approve", path)))}>
                  Approve {usd(run.estimate_usd)} and start
                </Button>
              )}
              {owner && run.status === "paused_overrun" && (
                <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/runs/{run_id}/resume", path)))}>
                  Resume
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
            </div>
          </div>

          {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
          {run.error && <div className="mt-4"><ErrorNote>{run.error}</ErrorNote></div>}
          {run.stuck && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="run-stuck">
              <span className="min-w-0 flex-1">{run.stuck}</span>
              {mayManage && run.can_retry && (
                <Button
                  size="sm"
                  variant="primary"
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
              {mayManage && run.can_stop_cancelling && (
                <Button
                  size="sm"
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
            </div>
          )}
          {run.searching && (
            <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="run-searching">
              {run.searching}
            </p>
          )}
          {run.token_read_only && (
            <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="run-token-read-only">
              Waiting for approval: a SwarmCloud console answer that does not count (or that Oracle could not read, or has not read yet) waits, so the run&apos;s agents may read Oracle but their writes are refused until it is read and confirmed or decided.
            </p>
          )}
          {run.status === "awaiting_approval" && (
            <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The estimate is over $50, so an owner approves the cost before any agent starts.
            </p>
          )}
          {run.status === "paused_overrun" && (
            <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              Spend passed {usd(run.overrun_ceiling_usd)} (1.5× the estimate). An owner resumes the run or cancels it.
            </p>
          )}
          <div className="mt-4">
            <RunsWhere runtime={run.runtime} />
          </div>
          {run.notes.length > 0 && (
            <ul className="mt-4 space-y-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900" data-testid="run-notes">
              {run.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          <section aria-label="Cost" className="mt-6 rounded-lg border border-neutral-200 bg-white px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                <span className="font-semibold tabular-nums text-neutral-900" data-testid="run-spent">
                  {usd(run.spent_usd)}
                </span>{" "}
                <span className="text-neutral-500">spent of {usd(run.estimate_usd)} estimated</span>
              </span>
              <span className="text-xs text-neutral-500">
                {run.overrun_ceiling_usd != null && <>pauses above {usd(run.overrun_ceiling_usd)}</>}
                {run.knobs.budget_usd != null && <> · budget {usd(run.knobs.budget_usd)}</>}
              </span>
            </div>
            <SpendBar spent={run.spent_usd} estimate={run.estimate_usd ?? null} ceiling={run.overrun_ceiling_usd ?? null} />
          </section>

          <h2 className="mt-8 mb-3 text-sm font-semibold text-neutral-700">Segments</h2>
          <ol className="space-y-3" data-testid="segment-timeline">
            {run.segments.map((s) => (
              <SegmentCard
                key={s.id}
                run={run}
                segment={s}
                checkpoints={run.checkpoints.filter((c) => c.segment_seq === s.seq)}
                busy={busy}
                onDecide={(cp, decision, note) =>
                  act(() =>
                    unwrap(
                      api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
                        params: { path: { run_id: id, checkpoint_id: cp.id } },
                        body: { decision, note: note || null },
                      }),
                    ),
                  )
                }
              />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function SegmentCard({
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
  onDecide: (cp: CheckpointOut, decision: CheckpointChoice, note: string) => void;
}) {
  const kind = s.checkpoint;
  return (
    <li className="rounded-lg border border-neutral-200 bg-white" data-testid={`segment-${s.name}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-700">
          {s.seq}
        </span>
        <span className="font-medium text-neutral-900">{s.title}</span>
        <Badge tone={SEGMENT_STATUS_TONE[s.status]}>{s.status}</Badge>
        {s.attempts.length > 1 && <Badge tone="neutral">attempt {s.attempts.length}</Badge>}
        <span className="text-xs text-neutral-500">{s.roles.join(" → ")}</span>
        <span className="ml-auto text-xs tabular-nums text-neutral-600">
          {usd(s.cost_usd)} <span className="text-neutral-400">/ {usd(s.estimate_usd)}</span>
        </span>
      </div>
      {(s.artifacts.length > 0 || s.draft_import || s.items_check || s.error) && (
        <div className="space-y-2 border-t border-neutral-100 px-4 py-2.5 text-sm">
          {s.error && <p className="text-rose-700">{s.error}</p>}
          {s.items_check && <ItemsCheckLine check={s.items_check} />}
          {s.draft_import && <DraftImportLine imp={s.draft_import} />}
          {s.artifacts.length > 0 && <Artifacts runId={run.id} seq={s.seq} names={s.artifacts} />}
        </div>
      )}
      <div className="border-t border-neutral-100 px-4 py-2.5">
        {checkpoints.length === 0 ? (
          <p className="text-xs text-neutral-500">
            {s.checkpoint_on ? `Stops for ${CHECKPOINT_LABEL[kind].toLowerCase()}` : `${CHECKPOINT_LABEL[kind]}: off`}
          </p>
        ) : (
          <ul className="space-y-2">
            {checkpoints.map((cp) => (
              <CheckpointRow key={cp.id} cp={cp} busy={busy} onDecide={onDecide} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function DraftImportLine({ imp }: { imp: NonNullable<SegmentOut["draft_import"]> }) {
  if (imp.error) return <p className="text-rose-700">Draft not imported: {imp.error}</p>;
  return (
    <p className="text-neutral-700">
      Imported as{" "}
      <Link href={`/documents/${imp.slug}/v/${imp.version}`} className="font-medium underline-offset-2 hover:underline">
        {imp.slug} v{imp.version}
      </Link>
      {imp.created === false && " (same content as an existing version)"}
      {imp.warnings.length > 0 && <span className="text-amber-700"> · {imp.warnings.join(", ")}</span>}
      {imp.prd_links && (
        <span data-testid="prd-links">
          {" "}
          · {imp.prd_links.resolved} link{imp.prd_links.resolved === 1 ? "" : "s"} to PRD sections
          {imp.prd_links.unresolved.length > 0 && (
            <span className="text-amber-700">
              , {imp.prd_links.unresolved.length} not found: {imp.prd_links.unresolved.join(", ")}
            </span>
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
      <p className="text-neutral-700">
        {check.items} roadmap item{check.items === 1 ? "" : "s"}
        {horizons.length > 0 && `: ${horizons.join(", ")}`}
        {check.problems.length === 0 && " · no problems"}
      </p>
      {check.problems.length > 0 && (
        <ul className="mt-1 space-y-0.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-amber-900">
          {check.problems.map((p, i) => (
            <li key={i}>{p.message}</li>
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
            className="rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-xs text-neutral-700 hover:bg-neutral-50"
          >
            {n}
          </button>
        ))}
      </div>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-neutral-50 p-3 text-xs whitespace-pre-wrap text-neutral-800" data-testid="artifact-content">
          {content}
        </pre>
      )}
    </div>
  );
}

const CP_TONE = { pending: "amber", approved: "green", changes_requested: "red", skipped: "neutral" } as const;
const CP_LABEL = { pending: "Waiting", approved: "Approved", changes_requested: "Changes requested", skipped: "Skipped" } as const;

function CheckpointRow({
  cp,
  busy,
  onDecide,
}: {
  cp: CheckpointOut;
  busy: boolean;
  onDecide: (cp: CheckpointOut, decision: CheckpointChoice, note: string) => void;
}) {
  const [note, setNote] = useState("");
  const answer = cp.console;
  // A counted console change request the workflow went on past: Redo or Continue only.
  const redoOrContinue = answer?.needs === "redo_or_continue";
  // Redo carries the console's findings, else the note: the API refuses it without either.
  const redoBlocked = !answer?.can_redo && !note.trim();
  return (
    <li className="text-sm" data-testid={`checkpoint-${cp.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-neutral-800">{CHECKPOINT_LABEL[cp.kind]}</span>
        <Badge tone={CP_TONE[cp.status]}>{CP_LABEL[cp.status]}</Badge>
        {cp.status === "pending" && <span className="text-xs text-neutral-500">needs an {cp.approver_role} or above</span>}
        {cp.decided_at && <span className="text-xs text-neutral-500">{formatDateTime(cp.decided_at)}</span>}
      </div>
      {cp.note && <p className="mt-1 text-neutral-600">{cp.note}</p>}
      {answer && <ConsolePanel answer={answer} />}
      {cp.status === "pending" && cp.can_decide && (
        <div className="mt-2 space-y-2">
          <textarea
            aria-label="Note for the agents"
            placeholder={redoOrContinue ? "Note (optional, added to the findings)" : "Note (required to request changes)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            {redoOrContinue ? (
              <>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide(cp, "continue", note)}>
                  Continue
                </Button>
                <Button
                  size="sm"
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
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide(cp, "confirm", note)}>
                    Confirm {answer.verdict === "MERGE" ? "approval" : "change request"}
                  </Button>
                )}
                <Button
                  variant={answer?.needs === "confirm" ? undefined : "primary"}
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(cp, "approved", note)}
                >
                  Approve and continue
                </Button>
                <Button size="sm" disabled={busy || !note.trim()} onClick={() => onDecide(cp, "changes_requested", note)}>
                  Request changes
                </Button>
                {(answer?.needs === "unreadable" || answer?.needs === "unread") && (
                  <Button size="sm" disabled={busy || redoBlocked} onClick={() => onDecide(cp, "redo", note)}>
                    Redo from {answer.redo_segment} (+{usd(answer.redo_cost_usd)})
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </li>
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

function ConsolePanel({ answer: c }: { answer: ConsoleAnswer }) {
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-neutral-700" data-testid="console-answer">
      <p>
        Answered in SwarmCloud by <span className="font-medium">{c.answered_by ?? "someone"}</span>
        {c.via && ` via ${c.via}`}
        {c.verdict && (
          <>
            : <span className="font-medium">{c.verdict === "MERGE" ? "approved" : "changes requested"}</span>
          </>
        )}
        {c.answered_at && <span className="text-xs text-neutral-500"> · {formatDateTime(c.answered_at)}</span>}
      </p>
      {c.findings.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {c.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {c.reason && c.counted === false && <p className="mt-1 text-xs text-neutral-600">Not counted: {c.reason}.</p>}
      <p className="mt-1 text-xs text-neutral-600">{CONSOLE_NEEDS[c.needs]}</p>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Button, Chip, Panel } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { GraphOut, ProposalOut, Schemas } from "@/lib/api/client";
import { formatDateTime, formatDay } from "@/lib/format";

import { formatValue, titleOf } from "./common";
import { LIMIT_LABEL, suggestedBlocker } from "./PromoteBlocker";

type Payload = { op?: string; kind?: string; fields?: Record<string, unknown>; reason?: string | null; origin?: string };

/** Flattens {title, attrs: {effort}} to [["title", ...], ["attrs.effort", ...]]. */
function flatFields(fields: Record<string, unknown> = {}): [string, unknown][] {
  return Object.entries(fields).flatMap(([k, v]) =>
    k === "attrs" && v && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).map(([ak, av]) => [`attrs.${ak}`, av] as [string, unknown])
      : [[k, v] as [string, unknown]],
  );
}

type ProposalRun = Schemas["ProposalRun"];

/** A run in plain words: "Baseline to PRD · Oct 16". */
export const runLabel = (run: ProposalRun) => `${run.flow_title} · ${formatDay(run.created_at)}`;

/** The From filter: "" (all), "none" (people and intake answers) or a run's id. */
export type FromFilter = string;

/** Open proposals: changes agents (or commenters) suggested, for an approver to accept or reject. */
export function ProposalsTab({
  proposals,
  runs,
  from,
  onFrom,
  graph,
  meId,
  canWrite,
  busy,
  onOpen,
  onDecide,
  onPromote,
  afterReview,
  onMakeMeasurable,
}: {
  proposals: ProposalOut[];
  /** The runs the From select offers: those with open proposals, and the one chosen. */
  runs: ProposalRun[];
  from: FromFilter;
  onFrom: (from: FromFilter) => void;
  graph: GraphOut | undefined;
  /** The signed-in member: their own proposals say "You". */
  meId?: string | null;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDecide: (proposal: ProposalOut, accept: boolean) => void;
  /** Opens a suggested blocker on its Promote to blocker form. */
  onPromote: (id: string) => void;
  /** B6: the run's after-review line ("2 goals are not measurable · Interview"), in its From this run band. */
  afterReview?: ReactNode;
  /** B6: Make measurable on a row of the From this run view whose goal is not (commenters and up). */
  onMakeMeasurable?: (goalId: string) => void;
}) {
  // Accepted intake constraints still marked as suggested blockers (B4).
  const suggested = (graph?.entities ?? []).filter((e) => e.status !== "rejected" && suggestedBlocker(e));
  return (
    <>
      {suggested.length > 0 && (
        <Panel title="Suggested blockers" count={suggested.length}>
          <ul aria-label="Suggested blockers">
            {suggested.map((e) => {
              const mark = suggestedBlocker(e)!;
              const facts = [mark.severity && `${mark.severity} severity`, mark.limit_kind && LIMIT_LABEL[mark.limit_kind]];
              return (
                <li
                  key={e.id}
                  data-testid="suggested-blocker-row"
                  className="flex items-center gap-4 border-t border-line px-4 py-3 first:border-t-0 max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-2.5 max-[600px]:px-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1 max-[600px]:w-full">
                    <div className="flex min-w-0 items-center gap-2">
                      <Chip kind="warn">Suggested blocker</Chip>
                      <button
                        type="button"
                        onClick={() => onOpen(e.id)}
                        className="min-w-0 truncate text-left font-semibold hover:underline"
                      >
                        {e.title}
                      </button>
                    </div>
                    <p className="truncate text-sm text-text2">
                      {["From an intake answer", ...facts.filter(Boolean)].join(" · ")}
                    </p>
                  </div>
                  {canWrite && (
                    <Button className="flex-none" disabled={busy} onClick={() => onPromote(e.id)}>
                      Promote to blocker
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <ProposalList
        proposals={proposals}
        runs={runs}
        from={from}
        onFrom={onFrom}
        graph={graph}
        meId={meId}
        canWrite={canWrite}
        busy={busy}
        onOpen={onOpen}
        onDecide={onDecide}
        afterReview={afterReview}
        onMakeMeasurable={onMakeMeasurable}
      />
    </>
  );
}

/** The From select: all proposals, those of no run, or one run's. */
function FromSelect({ runs, from, onFrom }: { runs: ProposalRun[]; from: FromFilter; onFrom: (from: FromFilter) => void }) {
  const id = useId();
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 max-[600px]:ml-0 max-[600px]:w-full">
      <label htmlFor={id} className="text-[13px] font-semibold text-text2">
        From
      </label>
      <select
        id={id}
        className={`${INPUT} min-w-0 max-w-64 max-[600px]:max-w-none max-[600px]:flex-1`}
        value={from}
        onChange={(e) => onFrom(e.target.value)}
      >
        <option value="">All</option>
        <option value="none">People and intake answers</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Who made it and when: the run that made it, as a link; else the person (You), token or Oracle. */
function Source({ p, meId }: { p: ProposalOut; meId?: string | null }) {
  const line = "tnum truncate text-[13px] text-text2";
  if (p.run)
    return (
      <p className={line} data-testid="proposal-by">
        <Link href={`/runs/${p.run.id}`} className="text-accent-ink hover:underline">
          From run · {runLabel(p.run)}
        </Link>
      </p>
    );
  // A run that is gone: deleting it nulls run_id, but a run's own merge keeps "run:<id>" as the actor.
  if (p.proposer.kind === "run") return <p className={line} data-testid="proposal-by">From a run (removed)</p>;
  const who = p.proposer.user_id && p.proposer.user_id === meId ? "You" : p.proposer.label;
  // B6 (c6): a version proposed from a discussion reads as the person's suggestion.
  if (p.proposer.kind === "person" && (p.payload as Payload).reason?.startsWith("From discussion "))
    return (
      <p className={line} data-testid="proposal-by" title={p.proposer.email ?? undefined}>
        Suggested by {p.proposer.label} · {formatDateTime(p.created_at)}
      </p>
    );
  return (
    <p className={line} data-testid="proposal-by" title={p.proposer.email ?? undefined}>
      {who} · {formatDateTime(p.created_at)}
    </p>
  );
}

/** A goal the graph says is not measurable yet (B5's goal_check). */
const vagueGoal = (graph: GraphOut | undefined, id: string) => graph?.entities.find((e) => e.id === id && e.type === "goal")?.goal_check?.measurable === false;

/** A proposal whose every field already has its proposed value: the API's sentence says so. */
export const noChange = (p: ProposalOut) => p.summary.startsWith("No change to ");

/** The sentence, with the item it names as a button that opens its drawer. */
function Sentence({ p, graph, onOpen }: { p: ProposalOut; graph: GraphOut | undefined; onOpen: (id: string) => void }) {
  const op = (p.payload as Payload).op;
  const title = p.entity_id && op !== "create" ? titleOf(graph, p.entity_id) : null;
  const at = title ? p.summary.indexOf(title) : -1;
  return (
    <p data-testid="proposal-summary" className="line-clamp-2 min-w-0 font-semibold [overflow-wrap:anywhere]">
      {at < 0 || !title ? (
        p.summary
      ) : (
        <>
          {p.summary.slice(0, at)}
          <button type="button" onClick={() => onOpen(p.entity_id!)} className="inline text-left font-semibold hover:underline">
            {title}
          </button>
          {p.summary.slice(at + title.length)}
        </>
      )}
    </p>
  );
}

function ProposalList({
  proposals,
  runs,
  from,
  onFrom,
  graph,
  meId,
  canWrite,
  busy,
  onOpen,
  onDecide,
  afterReview,
  onMakeMeasurable,
}: {
  proposals: ProposalOut[];
  runs: ProposalRun[];
  from: FromFilter;
  onFrom: (from: FromFilter) => void;
  graph: GraphOut | undefined;
  meId?: string | null;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDecide: (proposal: ProposalOut, accept: boolean) => void;
  afterReview?: ReactNode;
  onMakeMeasurable?: (goalId: string) => void;
}) {
  const byRun = from !== "" && from !== "none";
  const run = byRun ? runs.find((r) => r.id === from) : undefined;
  return (
    <Panel title="Proposals" count={proposals.length} tools={<FromSelect runs={runs} from={from} onFrom={onFrom} />}>
      {byRun && (
        <p data-testid="run-filter-line" className="border-b border-line px-4 py-2 text-sm text-text2">
          Proposals from {run ? runLabel(run) : "this run"} ·{" "}
          <Link href={`/runs/${from}`} className="font-semibold text-accent-ink hover:underline">
            Open run
          </Link>
        </p>
      )}
      {byRun && afterReview && (
        <div data-testid="from-this-run" className="border-b border-line px-4 py-2 text-sm">
          {afterReview}
        </div>
      )}
      {proposals.length === 0 ? (
        <p className="px-4 py-8 text-center text-text2">{byRun ? "No open proposals from this run." : "No open proposals."}</p>
      ) : (
        <ul aria-label="Proposals">
          {proposals.map((p) => {
            const payload = p.payload as Payload;
            const fields = flatFields(payload.fields);
            return (
              <li
                key={p.id}
                data-testid="proposal"
                className="flex items-start gap-4 border-t border-line px-4 py-3 first:border-t-0 max-[600px]:flex-col max-[600px]:gap-2.5 max-[600px]:px-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1 max-[600px]:w-full">
                  {(payload.fields?.attrs as Record<string, unknown> | undefined)?.proposed_blocker != null && (
                    <div>
                      <Chip kind="warn">Suggested blocker</Chip>
                    </div>
                  )}
                  <Sentence p={p} graph={graph} onOpen={onOpen} />
                  <Source p={p} meId={meId} />
                  {payload.reason && (
                    <p className="truncate text-sm text-text2" title={payload.reason}>
                      {payload.reason}
                    </p>
                  )}
                  <details className="text-sm">
                    <summary className="w-fit cursor-pointer text-[13px] font-semibold text-text2 hover:text-text">Details</summary>
                    <p className="mt-1 font-mono text-text2">
                      {payload.op ?? "change"} {payload.kind ?? "entity"}
                    </p>
                    {fields.length > 0 && (
                      <dl className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5" aria-label="Proposed fields">
                        {fields.map(([k, v]) => (
                          <div key={k} className="flex min-w-0 gap-1">
                            <dt className="font-mono text-text2">{k}:</dt>
                            <dd className="truncate font-semibold">{formatValue(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </details>
                </div>
                {byRun && onMakeMeasurable && p.entity_id && vagueGoal(graph, p.entity_id) && (
                  <Button className="flex-none" disabled={busy} onClick={() => onMakeMeasurable(p.entity_id!)}>
                    Make measurable
                  </Button>
                )}
                {canWrite && (
                  <div className="flex flex-none gap-2">
                    {noChange(p) ? (
                      // Nothing to accept: the item already reads so (#262). Dismissing rejects it.
                      <Button disabled={busy} onClick={() => onDecide(p, false)}>
                        Dismiss
                      </Button>
                    ) : (
                      <>
                        <Button disabled={busy} onClick={() => onDecide(p, true)}>
                          Accept
                        </Button>
                        <Button disabled={busy} onClick={() => onDecide(p, false)}>
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

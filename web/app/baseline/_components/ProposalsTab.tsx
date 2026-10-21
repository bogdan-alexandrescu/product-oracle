"use client";

import Link from "next/link";
import { useId } from "react";

import { Button, Chip, Panel } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { GraphOut, ProposalOut, Schemas } from "@/lib/api/client";
import { formatDateTime, formatDay } from "@/lib/format";

import { formatValue, targetTitle } from "./common";
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
  canWrite,
  busy,
  onOpen,
  onDecide,
  onPromote,
}: {
  proposals: ProposalOut[];
  /** The runs the From select offers: those with open proposals, and the one chosen. */
  runs: ProposalRun[];
  from: FromFilter;
  onFrom: (from: FromFilter) => void;
  graph: GraphOut | undefined;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDecide: (proposal: ProposalOut, accept: boolean) => void;
  /** Opens a suggested blocker on its Promote to blocker form. */
  onPromote: (id: string) => void;
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
        canWrite={canWrite}
        busy={busy}
        onOpen={onOpen}
        onDecide={onDecide}
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

/** A row's last line: the run that made it, as a link; else who proposed it and when. */
function Source({ p }: { p: ProposalOut }) {
  const line = "tnum truncate text-[13px] text-text2";
  if (p.run)
    return (
      <p className={line}>
        <Link href={`/runs/${p.run.id}`} className="text-accent-ink hover:underline">
          From run · {runLabel(p.run)}
        </Link>
      </p>
    );
  // A run that is gone: deleting it nulls run_id, but a run's own merge keeps "run:<id>" as the actor.
  if (p.run_id || p.actor?.startsWith("run:")) return <p className={line}>From a run (removed)</p>;
  return (
    <p className={line}>
      {p.actor ?? "unknown"} · {formatDateTime(p.created_at)}
    </p>
  );
}

function ProposalList({
  proposals,
  runs,
  from,
  onFrom,
  graph,
  canWrite,
  busy,
  onOpen,
  onDecide,
}: {
  proposals: ProposalOut[];
  runs: ProposalRun[];
  from: FromFilter;
  onFrom: (from: FromFilter) => void;
  graph: GraphOut | undefined;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDecide: (proposal: ProposalOut, accept: boolean) => void;
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
      {proposals.length === 0 ? (
        <p className="px-4 py-8 text-center text-text2">{byRun ? "No open proposals from this run." : "No open proposals."}</p>
      ) : (
        <ul aria-label="Proposals">
          {proposals.map((p) => {
            const payload = p.payload as Payload;
            const fields = flatFields(payload.fields);
            const target =
              payload.op === "create" ? String(payload.fields?.title ?? "New item") : targetTitle(graph, p.entity_id, p.edge_id);
            return (
              <li
                key={p.id}
                data-testid="proposal"
                className="flex items-start gap-4 border-t border-line px-4 py-3 first:border-t-0 max-[600px]:flex-col max-[600px]:gap-2.5 max-[600px]:px-3"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 max-[600px]:w-full">
                  <div className="flex min-w-0 items-center gap-2">
                    <Chip kind="acc">{payload.op ?? "change"}</Chip>
                    <Chip kind="na">{payload.kind ?? "entity"}</Chip>
                    {(payload.fields?.attrs as Record<string, unknown> | undefined)?.proposed_blocker != null && (
                      <Chip kind="warn">Suggested blocker</Chip>
                    )}
                    {p.entity_id && payload.op !== "create" ? (
                      <button
                        type="button"
                        onClick={() => onOpen(p.entity_id!)}
                        className="min-w-0 truncate text-left font-semibold hover:underline"
                      >
                        {target}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate font-semibold">{target}</span>
                    )}
                  </div>
                  {fields.length > 0 && (
                    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm" aria-label="Proposed fields">
                      {fields.map(([k, v]) => (
                        <div key={k} className="flex min-w-0 gap-1">
                          <dt className="font-mono text-text2">{k}:</dt>
                          <dd className="truncate font-semibold">{formatValue(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {payload.reason && (
                    <p className="truncate text-sm text-text2" title={payload.reason}>
                      {payload.reason}
                    </p>
                  )}
                  <Source p={p} />
                </div>
                {canWrite && (
                  <div className="flex flex-none gap-2">
                    <Button disabled={busy} onClick={() => onDecide(p, true)}>
                      Accept
                    </Button>
                    <Button disabled={busy} onClick={() => onDecide(p, false)}>
                      Reject
                    </Button>
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

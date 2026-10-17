"use client";

import { Badge, Button } from "@/components/ui";
import type { GraphOut, ProposalOut } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import { formatValue, targetTitle } from "./common";

type Payload = { op?: string; kind?: string; fields?: Record<string, unknown>; reason?: string | null; origin?: string };

/** Flattens {title, attrs: {effort}} to [["title", ...], ["attrs.effort", ...]]. */
function flatFields(fields: Record<string, unknown> = {}): [string, unknown][] {
  return Object.entries(fields).flatMap(([k, v]) =>
    k === "attrs" && v && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).map(([ak, av]) => [`attrs.${ak}`, av] as [string, unknown])
      : [[k, v] as [string, unknown]],
  );
}

/** Open proposals: changes agents (or commenters) suggested, for an approver to accept or reject. */
export function ProposalsTab({
  proposals,
  graph,
  canWrite,
  busy,
  onOpen,
  onDecide,
}: {
  proposals: ProposalOut[];
  graph: GraphOut | undefined;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onDecide: (proposal: ProposalOut, accept: boolean) => void;
}) {
  if (proposals.length === 0) return <p className="text-sm text-neutral-500">No open proposals.</p>;

  return (
    <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white" aria-label="Proposals">
      {proposals.map((p) => {
        const payload = p.payload as Payload;
        const fields = flatFields(payload.fields);
        const target =
          payload.op === "create" ? String(payload.fields?.title ?? "New item") : targetTitle(graph, p.entity_id, p.edge_id);
        return (
          <li key={p.id} data-testid="proposal" className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="blue">{payload.op ?? "change"}</Badge>
                <Badge>{payload.kind ?? "entity"}</Badge>
                {p.entity_id && payload.op !== "create" ? (
                  <button type="button" onClick={() => onOpen(p.entity_id!)} className="font-medium text-neutral-900 hover:underline">
                    {target}
                  </button>
                ) : (
                  <span className="font-medium text-neutral-900">{target}</span>
                )}
              </div>
              {fields.length > 0 && (
                <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs" aria-label="Proposed fields">
                  {fields.map(([k, v]) => (
                    <div key={k} className="flex gap-1">
                      <dt className="font-mono text-neutral-500">{k}:</dt>
                      <dd className="text-neutral-900">{formatValue(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {payload.reason && <p className="text-sm text-neutral-600">{payload.reason}</p>}
              <p className="text-xs text-neutral-400">
                {p.actor ?? "unknown"} · {formatDateTime(p.created_at)}
              </p>
            </div>
            {canWrite && (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => onDecide(p, true)}>
                  Accept
                </Button>
                <Button size="sm" disabled={busy} onClick={() => onDecide(p, false)}>
                  Reject
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

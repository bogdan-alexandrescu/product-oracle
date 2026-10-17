"use client";

import { Badge, Button } from "@/components/ui";
import type { ConflictOut, GraphOut } from "@/lib/api/client";
import { formatDate, formatDateTime } from "@/lib/format";

import { ConfidenceBadge, DEFAULT_LOW, fieldLabel, formatValue, sourceKindLabel, targetTitle } from "./common";

type Claim = {
  value?: unknown;
  source_kind?: string | null;
  source_class?: string | null;
  confidence?: number | null;
  observed_at?: string | null;
};

const STATUS_TONE = { open: "amber", resolved: "green", logged: "neutral" } as const;
const STATUS_LABEL = { open: "Open", resolved: "Resolved", logged: "Logged" } as const;

/** Competing claims about one field; open material ones wait for an approver to pick. */
export function ConflictsTab({
  conflicts,
  graph,
  low = DEFAULT_LOW,
  canWrite,
  busy,
  onOpen,
  onPick,
}: {
  conflicts: ConflictOut[];
  graph: GraphOut | undefined;
  low?: number;
  canWrite: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onPick: (conflict: ConflictOut, claim: number) => void;
}) {
  if (conflicts.length === 0) {
    return <p className="text-sm text-neutral-500">No conflicting claims recorded.</p>;
  }
  const order = { open: 0, logged: 1, resolved: 2 };
  const sorted = [...conflicts].sort((a, b) => order[a.status] - order[b.status] || b.created_at.localeCompare(a.created_at));

  return (
    <ul className="space-y-4" aria-label="Conflicts">
      {sorted.map((c) => {
        const res = (c.resolution ?? {}) as { rule?: string; winner?: number | null; value?: unknown; decided_by?: string };
        const title = targetTitle(graph, c.entity_id, c.edge_id);
        return (
          <li
            key={c.id}
            data-testid="conflict"
            className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-4 py-2">
              {c.entity_id ? (
                <button type="button" onClick={() => onOpen(c.entity_id!)} className="font-medium text-neutral-900 hover:underline">
                  {title}
                </button>
              ) : (
                <span className="font-medium text-neutral-900">{title}</span>
              )}
              <span className="text-neutral-400">·</span>
              <span className="font-mono text-xs text-neutral-700" data-testid="conflict-field">
                {fieldLabel(c.field)}
              </span>
              <Badge tone={STATUS_TONE[c.status]}>
                <span data-testid="conflict-status">{STATUS_LABEL[c.status]}</span>
              </Badge>
              {c.material && <Badge tone="red">Material</Badge>}
              <span className="ml-auto text-xs text-neutral-500">{formatDateTime(c.created_at)}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr>
                  <th className="px-4 py-1.5 font-medium">Claim</th>
                  <th className="px-4 py-1.5 font-medium">Source</th>
                  <th className="px-4 py-1.5 font-medium">Confidence</th>
                  <th className="px-4 py-1.5 font-medium">Observed</th>
                  <th className="px-4 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {(c.claims as Claim[]).map((claim, i) => (
                  <tr key={i} data-testid="claim">
                    <td className="px-4 py-2 text-neutral-900">
                      {formatValue(claim.value)}
                      {res.winner === i && (
                        <span className="ml-2">
                          <Badge tone={c.status === "resolved" ? "green" : "blue"}>
                            {c.status === "resolved" ? "Chosen" : "Leading"}
                          </Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {sourceKindLabel(claim.source_kind)}
                      {claim.source_class && <span className="text-neutral-400"> · {claim.source_class}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <ConfidenceBadge value={claim.confidence} low={low} />
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{claim.observed_at ? formatDate(claim.observed_at) : "—"}</td>
                    <td className="px-4 py-2 text-right">
                      {canWrite && c.status === "open" && (
                        <Button size="sm" disabled={busy} onClick={() => onPick(c, i)} aria-label={`Pick ${formatValue(claim.value)}`}>
                          Pick
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-neutral-100 px-4 py-2 text-xs text-neutral-600">
              {res.rule && (
                <p data-testid="conflict-rule">
                  <span className="text-neutral-400">Rule: </span>
                  {res.rule}
                </p>
              )}
              {c.status === "resolved" && (
                <p>
                  Set to <strong>{formatValue(res.value)}</strong>
                  {res.decided_by && ` by ${res.decided_by}`}.
                </p>
              )}
              {c.status === "open" && (
                <p>This changes a status, a goal link or a priority input, so a person decides.</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

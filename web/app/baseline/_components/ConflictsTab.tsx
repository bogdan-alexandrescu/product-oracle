"use client";

import { Button, Chip, Empty, InfoTip, Panel, type ChipKind } from "@/components/ds";
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

const STATUS_KIND: Record<ConflictOut["status"], ChipKind> = { open: "warn", resolved: "pass", logged: "na" };
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
    return (
      <Panel>
        <Empty>No conflicts</Empty>
      </Panel>
    );
  }
  const order = { open: 0, logged: 1, resolved: 2 };
  const sorted = [...conflicts].sort((a, b) => order[a.status] - order[b.status] || b.created_at.localeCompare(a.created_at));
  const th = "h-9 bg-surface2 px-2 text-left text-[13px] leading-4 font-semibold whitespace-nowrap text-text2 first:pl-4 last:pr-4";
  const td = "px-2 py-1.5 first:pl-4 last:pr-4 max-[600px]:first:pl-3 max-[600px]:last:pr-3";

  return (
    <ul className="flex flex-col gap-4" aria-label="Conflicts">
      {sorted.map((c) => {
        const res = (c.resolution ?? {}) as { rule?: string; winner?: number | null; value?: unknown; decided_by?: string };
        const title = targetTitle(graph, c.entity_id, c.edge_id);
        return (
          <li
            key={c.id}
            data-testid="conflict"
            className="min-w-0 overflow-hidden rounded-panel border border-line bg-surface shadow-panel"
          >
            <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line px-4 py-2 max-[600px]:px-3">
              {c.entity_id ? (
                <button
                  type="button"
                  onClick={() => onOpen(c.entity_id!)}
                  className="min-w-0 truncate font-display text-lg font-bold hover:underline"
                >
                  {title}
                </button>
              ) : (
                <span className="min-w-0 truncate font-display text-lg font-bold">{title}</span>
              )}
              <span className="rounded-goal bg-surface2 px-1.5 font-mono text-sm" data-testid="conflict-field">
                {fieldLabel(c.field)}
              </span>
              <Chip kind={STATUS_KIND[c.status]}>
                <span data-testid="conflict-status">{STATUS_LABEL[c.status]}</span>
              </Chip>
              {c.material && <Chip kind="crit">Material</Chip>}
              {c.status === "open" && (
                <InfoTip label="open conflict">
                  This changes a status, a goal link or a priority input, so a person decides.
                </InfoTip>
              )}
              <span className="tnum ml-auto text-sm text-text2">{formatDateTime(c.created_at)}</span>
            </div>
            <table className="w-full table-fixed border-collapse text-[15px] leading-[22px]">
              <colgroup>
                <col />
                <col className="w-[34%] max-[600px]:hidden" />
                <col className="w-[96px]" />
                <col className="w-[110px] max-[600px]:hidden" />
                {canWrite && <col className="w-[84px]" />}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    Claim
                  </th>
                  <th scope="col" className={`${th} max-[600px]:hidden`}>
                    Source
                  </th>
                  <th scope="col" className={th}>
                    Conf.
                  </th>
                  <th scope="col" className={`${th} max-[600px]:hidden`}>
                    Observed
                  </th>
                  {canWrite && (
                    <th scope="col" className={th}>
                      <span className="sr-only">Action</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {(c.claims as Claim[]).map((claim, i) => (
                  <tr key={i} data-testid="claim" className="h-11 border-t border-line">
                    <td className={td}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-medium">{formatValue(claim.value)}</span>
                        {res.winner === i && (
                          <Chip kind={c.status === "resolved" ? "pass" : "acc"}>
                            {c.status === "resolved" ? "Chosen" : "Leading"}
                          </Chip>
                        )}
                      </span>
                    </td>
                    <td className={`${td} truncate max-[600px]:hidden`}>
                      {sourceKindLabel(claim.source_kind)}
                      {claim.source_class && <span className="text-text2"> · {claim.source_class}</span>}
                    </td>
                    <td className={td}>
                      <ConfidenceBadge value={claim.confidence} low={low} />
                    </td>
                    <td className={`${td} tnum text-text2 max-[600px]:hidden`}>
                      {claim.observed_at ? formatDate(claim.observed_at) : "–"}
                    </td>
                    {canWrite && (
                      <td className={`${td} text-right`}>
                        {c.status === "open" && (
                          <Button
                            disabled={busy}
                            onClick={() => onPick(c, i)}
                            aria-label={`Pick ${formatValue(claim.value)}`}
                          >
                            Pick
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {(res.rule || c.status === "resolved") && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 text-sm max-[600px]:px-3">
                {res.rule && (
                  <p data-testid="conflict-rule">
                    <span className="font-semibold text-text2">Rule </span>
                    {res.rule}
                  </p>
                )}
                {c.status === "resolved" && (
                  <p>
                    Set to <strong>{formatValue(res.value)}</strong>
                    {res.decided_by && <span className="text-text2"> · {res.decided_by}</span>}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

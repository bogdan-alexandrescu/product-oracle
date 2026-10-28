"use client";

import { Button, Chip, Empty, InfoTip, Panel, type ChipKind } from "@/components/ds";
import type { ConflictOut, GraphOut } from "@/lib/api/client";
import { formatDate, formatDateTime, formatPercent } from "@/lib/format";

import { capitalize, ConfidenceBadge, DEFAULT_LOW, fieldLabel, sourceKindLabel, targetTitle, valueWords } from "./common";

type Claim = {
  value?: unknown;
  source_kind?: string | null;
  source_class?: string | null;
  confidence?: number | null;
  observed_at?: string | null;
};

const STATUS_KIND: Record<ConflictOut["status"], ChipKind> = { open: "warn", resolved: "pass", logged: "na" };
const STATUS_LABEL = { open: "Open", resolved: "Resolved", logged: "Logged" } as const;

type Resolution = { rule?: string; winner?: number | null; value?: unknown; decided_by?: string };

const pct = (c: Claim | undefined) => (c?.confidence == null ? "no score" : formatPercent(c.confidence));
const source = (c: Claim | undefined) => (c ? sourceKindLabel(c.source_kind) : "an unknown source");

/**
 * Why the leading claim leads, in a sentence (oracle.baseline.conflicts._compare): higher
 * confidence wins unless the two are within the tie margin; then the stronger kind of source
 * wins (code over tracker over docs over chat); then the newer claim; else a person picks.
 * The API's rule names which step decided; the numbers come from the claims.
 */
export function ruleSentence(res: Resolution, claims: Claim[]): string | null {
  const rule = res.rule ?? "";
  if (!rule) return null;
  const win = res.winner != null ? claims[res.winner] : undefined;
  // The runner-up: the best other claim by confidence.
  const others = claims.filter((_, i) => i !== res.winner);
  const lose = [...others].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (!rule.startsWith("confidence tie")) {
    return win
      ? `Higher confidence wins: ${pct(win)} against ${pct(lose)}.`
      : "Higher confidence wins.";
  }
  const close = win && lose ? `Confidence ${pct(win)} and ${pct(lose)} is too close to call` : "The confidences are too close to call";
  if (rule.includes("same precedence and date") || !win)
    return `${close}, and the claims come from the same kind of source on the same day: a person picks.`;
  if (rule.includes("same precedence; newer"))
    return `${close} and both come from the same kind of source, so the newer claim leads (${win.observed_at ? formatDate(win.observed_at) : "undated"} over ${lose?.observed_at ? formatDate(lose.observed_at) : "undated"}).`;
  return `${close}, so the stronger source leads: ${source(win)} (${win.source_class ?? "source"}) outranks ${source(lose)} (${lose?.source_class ?? "source"}).`;
}

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
        const res = (c.resolution ?? {}) as Resolution;
        const title = targetTitle(graph, c.entity_id, c.edge_id);
        const type = c.entity_id ? graph?.entities.find((e) => e.id === c.entity_id)?.type : null;
        const words = (v: unknown) => valueWords(c.field, v, graph);
        // A person's pick replaces the rule's winner: the rule then explains nothing.
        const byPerson = c.status === "resolved" && res.decided_by !== "precedence";
        const rule = byPerson ? null : ruleSentence(res, c.claims as Claim[]);
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
                  className="min-w-0 truncate font-display tracking-heading text-lg font-bold hover:underline"
                >
                  {title}
                </button>
              ) : (
                <span className="min-w-0 truncate font-display tracking-heading text-lg font-bold">{title}</span>
              )}
              <span className="rounded-goal bg-surface2 px-1.5 text-sm" data-testid="conflict-field">
                {capitalize(fieldLabel(c.field, type))}
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
                <col className="w-[112px]" />
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
                    Confidence
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
                        <span className="min-w-0 truncate font-medium" title={words(claim.value)}>
                          {words(claim.value)}
                        </span>
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
                            aria-label={`Pick ${words(claim.value)}`}
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
            {(rule || c.status === "resolved") && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-4 py-2.5 text-sm max-[600px]:px-3">
                {rule && (
                  <p data-testid="conflict-rule">
                    <span className="font-semibold text-text2">{c.status === "resolved" ? "Why: " : "Why it leads: "}</span>
                    {rule}
                  </p>
                )}
                {c.status === "resolved" && (
                  <p>
                    Set to <strong>{words(res.value)}</strong>
                    <span className="text-text2"> · {byPerson ? "picked by a person" : "by Oracle's rule"}</span>
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

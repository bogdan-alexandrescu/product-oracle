"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Chip, Inspector, InspectorSection, SegmentedControl } from "@/components/ds";
import type { ItemRow } from "@/components/roadmap/item-row";
import type { Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

import { HorizonChip } from "./ItemsTable";

type Item = Schemas["RoadmapItemOut"];
type Basis = Schemas["ScheduleBasisOut"];

const REFUSED_TEXT: Record<"now" | "other", string> = {
  now: "Date unverified: no verified estimate, capacity or commitment supports it",
  other: "Not in Now: dated milestones are only in Now",
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** D1: the item's priority when there is no API item to read it from. */
export type ItemPriority = { rank: string | number; explanation?: string | null; score?: string | number | null };

/**
 * The inspector of one roadmap item (E2; D1 adds reason cards and the horizon control, E3
 * What changed and History). Built from the row, plus the API's full item when there is
 * one. Each section shows only when it has content. D1's slots: `reasons` (first, "Needs you
 * because"), `horizonControl`, `outcomeEdit` (replaces the outcome), `milestoneAction`,
 * `dependencyAction` (one per dependency; `removedDependencies` struck), `priority`, `tabs`
 * (beside the Item tab), `eyebrow`.
 */
export function ItemInspector({
  row,
  item,
  total,
  rows,
  bases,
  documentHref,
  freshnessActions,
  children,
  eyebrow,
  reasons,
  horizonControl,
  outcomeEdit,
  milestoneAction,
  dependencyAction,
  removedDependencies = [],
  priority: priorityIn,
  tabs,
}: {
  row: ItemRow;
  item?: Item;
  /** The version's item count ("Item 4 of 9"). */
  total: number;
  /** Every item of the version: dependencies are looked up among them by key. */
  rows: readonly ItemRow[];
  /** The PRD's schedule bases, for the milestone's basis references. */
  bases?: readonly Basis[];
  /** "Open in document": the roadmap section that names the item. */
  documentHref?: string | null;
  /** Under Freshness: Mark under review, Still valid… (approvers and owners). */
  freshnessActions?: ReactNode;
  children?: ReactNode;
  eyebrow?: ReactNode;
  reasons?: ReactNode;
  horizonControl?: ReactNode;
  outcomeEdit?: ReactNode;
  milestoneAction?: ReactNode;
  dependencyAction?: (key: string) => ReactNode;
  removedDependencies?: readonly string[];
  priority?: ItemPriority;
  /** Tabs after "Item" (D1's History): each replaces the item's sections while picked. */
  tabs?: { value: string; label: string; content: ReactNode }[];
}) {
  const [tab, setTab] = useState("item");
  const m = row.milestone;
  const ms = (item?.milestone ?? null) as Record<string, unknown> | null;
  const basisIds = Array.isArray(ms?.basis_ids) ? (ms!.basis_ids as string[]) : [];
  const priority = (priorityIn ?? item?.priority ?? null) as Record<string, unknown> | null;
  const rank = str(priority?.rank);
  const doc = item?.prd.document;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const deliver = [item?.feature, ...(item?.requirements ?? [])].filter((e): e is NonNullable<typeof e> => !!e);
  const gates = (item?.validation_gates ?? []) as Record<string, unknown>[];
  const stale = row.freshness && row.freshness !== "fresh" && row.freshness !== "reconciled";

  return (
    <Inspector
      testId="roadmap-item-inspector"
      label={`Item: ${row.title}`}
      eyebrow={eyebrow ?? `Item ${row.position + 1} of ${total} · selected`}
      title={row.title}
      chips={
        <>
          <HorizonChip horizon={row.horizon} hero />
          {m?.name && <Chip hero>{m.name}</Chip>}
          {rank && <Chip hero>rank {rank}</Chip>}
        </>
      }
    >
      {tabs && tabs.length > 0 && (
        <InspectorSection>
          <SegmentedControl<string>
            label="Inspector tab"
            size="sm"
            value={tab}
            onChange={setTab}
            items={[{ value: "item", label: "Item" }, ...tabs.map((t) => ({ value: t.value, label: t.label }))]}
          />
        </InspectorSection>
      )}
      {tab !== "item" && tabs?.find((t) => t.value === tab)?.content}
      {tab === "item" && (
        <>
          {reasons}

          {horizonControl && (
            <InspectorSection label="Horizon" testId="item-horizon">
              {horizonControl}
            </InspectorSection>
          )}

          {(row.outcome || outcomeEdit) && (
            <InspectorSection label="Outcome" testId="item-outcome">
              {outcomeEdit ?? <p className="text-[15px]">{row.outcome}</p>}
            </InspectorSection>
          )}

          {m && (m.name || m.date || m.refused_date) && (
            <InspectorSection label="Milestone" testId="item-milestone">
              {m.name && <p className="font-medium">{m.name}</p>}
              {m.date && (
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  {m.date_removed ? <s className="tnum text-text2">{formatDate(m.date)}</s> : <span className="tnum font-semibold">{formatDate(m.date)}</span>}
                  {m.verified !== false && !m.date_removed && <Chip kind="pass">verified</Chip>}
                  {milestoneAction}
                </p>
              )}
              {m.date && basisIds.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-1 text-sm text-text2">
                  {basisIds.map((id) => {
                    const b = bases?.find((x) => x.id === id);
                    return (
                      <li key={id}>
                        {b ? (
                          <>
                            <span className="font-mono text-text">{b.reference}</span> · {b.kind}
                          </>
                        ) : (
                          <span className="font-mono">{id}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {m.refused_date && (
                <p className="mt-1 flex flex-col gap-1 text-sm">
                  <s className="tnum text-text2">{formatDate(m.refused_date)}</s>
                  <span className="font-medium text-warn">{REFUSED_TEXT[row.horizon === "now" ? "now" : "other"]}</span>
                </p>
              )}
            </InspectorSection>
          )}

          {row.depends_on.length > 0 && (
            <InspectorSection label="Depends on" testId="item-depends">
              <ul className="flex flex-col gap-1.5">
                {row.depends_on.map((k) => {
                  const dep = byKey.get(k);
                  return (
                    <li key={k} className="flex min-h-8 items-center gap-2">
                      {dep ? (
                        <>
                          <span className={`min-w-0 flex-1 truncate ${removedDependencies.includes(k) ? "text-text2 line-through" : ""}`}>{dep.title}</span>
                          <HorizonChip horizon={dep.horizon} />
                        </>
                      ) : (
                        <span className="font-mono text-sm">{k}</span>
                      )}
                      {!removedDependencies.includes(k) && dependencyAction?.(k)}
                    </li>
                  );
                })}
              </ul>
            </InspectorSection>
          )}

          {rank && (str(priority?.explanation) || str(priority?.score)) && (
            <InspectorSection label={`Why rank ${rank}`} testId="item-rank">
              {str(priority?.explanation) && <p className="text-[15px]">{str(priority?.explanation)}</p>}
              {str(priority?.score) && (
                <p className="mt-1 text-sm text-text2">
                  Score <span className="tnum font-semibold text-text">{str(priority?.score)}</span>
                </p>
              )}
            </InspectorSection>
          )}

          {row.prd && (
            <InspectorSection label="From the PRD" testId="item-prd">
              <Link href={row.prd.href} className="font-medium text-accent-ink underline-offset-2 hover:underline">
                {doc ? `${doc.title} v${doc.version} · ${row.prd.label}` : row.prd.label}
              </Link>
              {item?.prd.reconciled_version != null && (
                <p className="mt-1 text-sm text-text2">Reconciled against v{item.prd.reconciled_version}</p>
              )}
            </InspectorSection>
          )}

          {deliver.length > 0 && (
            <InspectorSection label="Delivers" testId="item-delivers">
              <ul className="flex flex-col gap-1 text-[15px]">
                {deliver.map((e) => (
                  <li key={e.id}>{e.title}</li>
                ))}
              </ul>
            </InspectorSection>
          )}

          {(item?.blockers.length ?? 0) > 0 && (
            <InspectorSection label="Blockers" testId="item-blockers">
              <ul className="flex flex-col gap-1.5">
                {item!.blockers.map((b) => (
                  <li key={b.id} className="flex min-h-8 flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">{b.title}</span>
                    <Chip kind={b.resolved ? "pass" : "na"}>{b.blocker_status}</Chip>
                    {b.critical && <Chip kind="crit">Critical</Chip>}
                  </li>
                ))}
              </ul>
            </InspectorSection>
          )}

          {gates.length > 0 && (
            <InspectorSection label="Validation gates" testId="item-gates">
              <ul className="flex flex-col gap-1.5 text-[15px]">
                {gates.map((g, i) => (
                  <li key={i}>
                    <span className="font-medium">{str(g.name) ?? str(g.kind) ?? "Gate"}</span>
                    {str(g.criterion) && <span className="text-text2"> · {str(g.criterion)}</span>}
                  </li>
                ))}
              </ul>
            </InspectorSection>
          )}

          {(row.engineering?.length ?? 0) > 0 && (
            <InspectorSection label="Engineering" testId="item-engineering">
              <ul className="flex flex-col gap-1 text-sm">
                {row.engineering!.map((e) => {
                  const label = `${e.external_ref} · ${e.state}${e.target_date ? ` · ${e.target_date}` : ""}`;
                  return (
                    <li key={`${e.tracker}-${e.external_ref}`}>
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noreferrer" className="text-accent-ink underline-offset-2 hover:underline">
                          {label}
                        </a>
                      ) : (
                        label
                      )}
                    </li>
                  );
                })}
              </ul>
            </InspectorSection>
          )}

          {stale && (
            <InspectorSection label="Freshness" testId="item-freshness">
              {(row.stale_reasons?.length ?? 0) > 0 && (
                <ul className="list-disc pl-5 text-[15px]">
                  {row.stale_reasons!.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-sm text-text2">
                {row.freshness === "under_review" ? "Under review" : "May be stale"}
                {item?.stale_since ? ` since ${formatDate(item.stale_since)}` : ""}
              </p>
              {freshnessActions}
            </InspectorSection>
          )}

          {children}

          {documentHref && (
            <InspectorSection>
              <Link href={documentHref} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                Open in document
              </Link>
            </InspectorSection>
          )}
        </>
      )}
    </Inspector>
  );
}

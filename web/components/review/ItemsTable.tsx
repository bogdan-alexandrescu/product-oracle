"use client";

import Link from "next/link";
import { useMemo } from "react";

import { Chip, DataTable, Ring, type Column } from "@/components/ds";
import { HORIZONS, horizonLabel, type ItemRow } from "@/components/roadmap/item-row";

/** Below this a 0-1 confidence shows in the warn tone (as the API flags low confidence). */
export const LOW_CONFIDENCE = 0.4;

export type ItemColumn = "position" | "title" | "horizon" | "milestone" | "confidence" | "depends_on" | "prd" | "state";

const HORIZON_ORDER = new Map(HORIZONS.map((h, i) => [h.value, i]));

export function HorizonChip({ horizon, hero = false }: { horizon: string; hero?: boolean }) {
  return (
    <Chip kind={horizon === "now" ? "now" : "line"} hero={hero}>
      {horizonLabel(horizon)}
    </Chip>
  );
}

/** "Date unverified" in Now; "Not in Now" in Next or Later (the API refuses a date outside Now only for that). */
export const refusedLabel = (horizon: string) => (horizon === "now" ? "Date unverified" : "Not in Now");

export function Confidence({ value }: { value: ItemRow["confidence"] }) {
  if (value == null || value === "") return <span className="text-text2">—</span>;
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isNaN(n)) {
    const pct = Math.round(n * 100);
    return <Ring value={pct} size={28} stroke={4} tone={n < LOW_CONFIDENCE ? "warn" : "accent"} label={`Confidence ${pct}%`} />;
  }
  const v = String(value).toLowerCase();
  const kind = v === "high" ? "pass" : v === "low" ? "warn" : "na";
  return <Chip kind={kind}>{v.charAt(0).toUpperCase() + v.slice(1)}</Chip>;
}

export function StateChip({ freshness }: { freshness: ItemRow["freshness"] }) {
  if (freshness === "potentially_stale") return <Chip kind="warn">May be stale</Chip>;
  if (freshness === "under_review") return <Chip kind="na">Under review</Chip>;
  return null;
}

export function MilestoneCell({ row }: { row: ItemRow }) {
  const m = row.milestone;
  if (!m || (!m.name && !m.date && !m.refused_date)) return <span className="text-text2">—</span>;
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      {m.name && <span className="truncate">{m.name}</span>}
      {m.date && <span className="tnum flex-none text-text2">{m.date}</span>}
      {m.refused_date && (
        <>
          <s className="tnum flex-none text-text2">{m.refused_date}</s>
          <Chip kind="warn" title={m.refused ?? undefined}>
            {refusedLabel(row.horizon)}
          </Chip>
        </>
      )}
    </span>
  );
}

/**
 * The one table of roadmap items (E2; D1 Items review, E1 and E3 extend it): one line per
 * item, grouped by horizon (Now, Next, Later) in stored order, each group headed by its name
 * and count. `filter` narrows the rows shown; `hide` drops columns; `extraColumns` add
 * columns before State; `rowDecorations` add attributes to a row.
 */
export function ItemsTable({
  rows,
  selected,
  onSelect,
  filter,
  hide = [],
  extraColumns = [],
  rowDecorations,
  label = "Roadmap items",
}: {
  rows: ItemRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  filter?: (row: ItemRow) => boolean;
  hide?: readonly (ItemColumn | string)[];
  extraColumns?: Column<ItemRow>[];
  rowDecorations?: (row: ItemRow) => Record<string, string | undefined>;
  label?: string;
}) {
  const titles = useMemo(() => new Map(rows.map((r) => [r.key, r.title])), [rows]);
  const shown = useMemo(
    () =>
      rows
        .filter((r) => !filter || filter(r))
        .sort((a, b) => (HORIZON_ORDER.get(a.horizon) ?? 9) - (HORIZON_ORDER.get(b.horizon) ?? 9) || a.position - b.position),
    [rows, filter],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) m.set(r.horizon, (m.get(r.horizon) ?? 0) + 1);
    return m;
  }, [shown]);

  const columns: Column<ItemRow>[] = [
    { key: "position", header: "#", width: "44px", align: "right", phone: "hide", className: "tnum text-text2", cell: (r) => r.position + 1 },
    { key: "title", header: "Item", phone: "title", cell: (r) => <span className="font-medium">{r.title}</span> },
    { key: "horizon", header: "Horizon", width: "92px", phone: "action", cell: (r) => <HorizonChip horizon={r.horizon} /> },
    { key: "milestone", header: "Milestone", width: "236px", phone: "meta", cell: (r) => <MilestoneCell row={r} /> },
    { key: "confidence", header: "Conf.", width: "84px", phone: "meta", phoneLabel: "Conf.", cell: (r) => <Confidence value={r.confidence} /> },
    {
      key: "depends_on",
      header: "Depends on",
      width: "96px",
      phone: "meta",
      phoneLabel: "Depends on",
      cell: (r) =>
        r.depends_on.length ? (
          <span className="tnum" title={r.depends_on.map((k) => titles.get(k) ?? k).join(", ")}>
            {r.depends_on.length}
          </span>
        ) : (
          <span className="text-text2">—</span>
        ),
    },
    {
      key: "prd",
      header: "PRD",
      width: "168px",
      phone: "hide",
      cell: (r) =>
        r.prd ? (
          <Link href={r.prd.href} onClick={(e) => e.stopPropagation()} className="text-accent-ink underline-offset-2 hover:underline" title={r.prd.label}>
            {r.prd.label}
          </Link>
        ) : (
          <span className="text-text2">—</span>
        ),
    },
    ...extraColumns,
    { key: "state", header: "State", width: "128px", phone: "meta", cell: (r) => <StateChip freshness={r.freshness} /> },
  ];

  return (
    <DataTable
      label={label}
      testId="roadmap-items-table"
      columns={columns.filter((c) => !hide.includes(c.key))}
      rows={shown}
      rowKey={(r) => r.key}
      selected={selected}
      onSelect={(k) => onSelect(k)}
      group={(r) => r.horizon}
      groupLabel={(g) => (
        <>
          {horizonLabel(g)} <span className="tnum font-sans text-sm font-semibold text-text2">{counts.get(g) ?? 0}</span>
        </>
      )}
      groupProps={(g) => ({ "data-testid": "roadmap-group", "data-horizon": g })}
      rowProps={(r) => ({ "data-testid": "roadmap-item-row", ...rowDecorations?.(r) })}
      empty="No items match"
    />
  );
}

"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";

import { Chip, DataTable, Ring, type Column } from "@/components/ds";
import { HORIZONS, horizonLabel, type ItemRow } from "@/components/roadmap/item-row";
import { formatDate } from "@/lib/format";

/** Below this a 0-1 confidence shows in the warn tone (as the API flags low confidence). */
export const LOW_CONFIDENCE = 0.4;

export type ItemColumn = "position" | "title" | "horizon" | "milestone" | "confidence" | "depends_on" | "prd" | "state";

const HORIZON_ORDER = new Map(HORIZONS.map((h, i) => [h.value, i]));

export function HorizonChip({ horizon, hero = false, plain = false }: { horizon: string; hero?: boolean; plain?: boolean }) {
  return (
    <Chip kind={horizon === "now" && !plain ? "now" : "line"} hero={hero}>
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
  const unbacked = row.unbacked ?? [];
  if ((!m || (!m.name && !m.date && !m.refused_date)) && unbacked.length === 0) return <span className="text-text2">—</span>;
  // qa4-docs-3: dates month first; a refused date's chip wraps under it, whole, never cut.
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-x-1.5 gap-y-1 ${unbacked.length || m?.refused_date ? "flex-wrap" : ""}`}>
      {m?.name && <span className="truncate">{m.name}</span>}
      {m?.date &&
        (m.date_removed ? (
          <s className="tnum flex-none text-text2" title="Date removed">
            {formatDate(m.date)}
          </s>
        ) : (
          <span className="tnum flex-none text-text2">{formatDate(m.date)}</span>
        ))}
      {m?.refused_date && (
        <>
          <s data-testid="refused-date" className="tnum flex-none text-text2">
            {formatDate(m.refused_date)}
          </s>
          <Chip kind="warn" title={m.refused ?? undefined} className="flex-none">
            {refusedLabel(row.horizon)}
          </Chip>
        </>
      )}
      {/* qa-docs-6: a date the item's text writes that no confirmed schedule backs. */}
      {unbacked.map((u) => (
        <span key={u.date} data-testid="unbacked-date" className="inline-flex flex-none items-center gap-1.5">
          <span className="tnum text-text2">{formatDate(u.date)}</span>
          <Chip kind="warn" title={u.withdrawn ? "Its schedule was withdrawn" : "No confirmed schedule backs it"}>
            Unconfirmed
          </Chip>
        </span>
      ))}
    </span>
  );
}

/**
 * The one table of roadmap items (E2; D1 Items review, E1 and E3 extend it): one line per
 * item, grouped by horizon (Now, Next, Later) in stored order, each group headed by its name
 * and count. `filter` narrows the rows shown; `hide` drops columns; `extraColumns` add
 * columns before State; `rowDecorations` add attributes to a row. D1: `groupBy`/`groupOrder`
 * group by something else (a reason), `groupLabel` heads a group ("Now · 2 of 4 need you"),
 * `detail` opens a form under a row, `empty` says why nothing shows. `onActivate`: Enter on a
 * focused row (D1 asks to confirm the row's first fix).
 */
export function ItemsTable({
  rows,
  selected,
  onSelect,
  onActivate,
  filter,
  hide = [],
  extraColumns = [],
  rowDecorations,
  label = "Roadmap items",
  groupBy,
  groupOrder,
  groupLabel,
  detail,
  empty = "No items match",
  widths,
  plainHorizons = false,
}: {
  rows: ItemRow[];
  selected: string | null;
  onSelect: (key: string) => void;
  onActivate?: (key: string) => void;
  filter?: (row: ItemRow) => boolean;
  hide?: readonly (ItemColumn | string)[];
  extraColumns?: Column<ItemRow>[];
  rowDecorations?: (row: ItemRow) => Record<string, string | undefined>;
  label?: string;
  /** The group of a row (default: its horizon); `groupOrder` orders the groups (default: Now, Next, Later). */
  groupBy?: (row: ItemRow) => string;
  groupOrder?: (group: string) => number;
  /** A group's header (default: its name and count); `rows` are the group's rows shown. */
  groupLabel?: (group: string, rows: ItemRow[]) => ReactNode;
  detail?: (row: ItemRow) => ReactNode;
  empty?: ReactNode;
  /** Narrower or wider columns than E2's (D1 fits two more beside the inspector). */
  widths?: Partial<Record<ItemColumn, string>>;
  /** Every horizon in one chip style (D1's review: Now is not set apart from Next and Later). */
  plainHorizons?: boolean;
}) {
  const titles = useMemo(() => new Map(rows.map((r) => [r.key, r.title])), [rows]);
  const groupOf = groupBy ?? ((r: ItemRow) => r.horizon);
  const orderOf = groupOrder ?? ((g: string) => HORIZON_ORDER.get(g as ItemRow["horizon"]) ?? 9);
  const shown = useMemo(
    () => rows.filter((r) => !filter || filter(r)).sort((a, b) => orderOf(groupOf(a)) - orderOf(groupOf(b)) || a.position - b.position),
    // groupOf and orderOf are the caller's: they change with the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filter, groupBy, groupOrder],
  );
  // qa4-docs-5: a group's items shown, of all it holds when a filter hides some, and the
  // dropped items drawn in it, so the header matches the rows and the summary above.
  const counts = useMemo(() => {
    const tally = (list: ItemRow[], pick: (r: ItemRow) => boolean) => {
      const m = new Map<string, number>();
      for (const r of list) if (pick(r)) m.set(groupOf(r), (m.get(groupOf(r)) ?? 0) + 1);
      return m;
    };
    return { shown: tally(shown, (r) => !r.ghost), all: tally(rows, (r) => !r.ghost), dropped: tally(shown, (r) => !!r.ghost) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, rows, groupBy]);
  const countLabel = (g: string) => {
    const n = counts.shown.get(g) ?? 0;
    const all = counts.all.get(g) ?? 0;
    const dropped = counts.dropped.get(g) ?? 0;
    return `${n}${all !== n ? ` of ${all}` : ""}${dropped ? ` · ${dropped} dropped` : ""}`;
  };

  const columns: Column<ItemRow>[] = [
    { key: "position", header: "#", width: "44px", align: "right", phone: "hide", className: "tnum text-text2", cell: (r) => (r.ghost ? "" : r.position + 1) },
    {
      key: "title",
      header: "Item",
      phone: "title",
      cell: (r) =>
        r.ghost || r.struck ? <s className="text-text2">{r.title}</s> : <span className={`font-medium ${r.muted ? "text-text2" : ""}`}>{r.title}</span>,
    },
    { key: "horizon", header: "Horizon", width: "84px", phone: "action", cell: (r) => (r.horizon ? <HorizonChip horizon={r.horizon} plain={plainHorizons} /> : <span className="text-text2">—</span>) },
    // qa-docs-66: on a phone a row's "—" says what it is.
    { key: "milestone", header: "Milestone", width: "172px", phone: "meta", phoneLabel: "Milestone", wrap: rows.some((r) => r.unbacked?.length || r.milestone?.refused_date), cell: (r) => <MilestoneCell row={r} /> },
    { key: "confidence", header: "Confidence", width: "104px", phone: "meta", phoneLabel: "Confidence", cell: (r) => <Confidence value={r.confidence} /> },
    {
      key: "depends_on",
      header: "Depends on",
      width: "92px",
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
      // qa-docs-61/62: the section's full name (wrapped), and on a phone too.
      width: "160px",
      wrap: true,
      phone: "meta",
      phoneLabel: "PRD",
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
    { key: "state", header: "State", width: "120px", phone: "meta", cell: (r) => <StateChip freshness={r.freshness} /> },
  ];

  return (
    <DataTable
      label={label}
      testId="roadmap-items-table"
      columns={columns.filter((c) => !hide.includes(c.key)).map((c) => (widths?.[c.key as ItemColumn] ? { ...c, width: widths[c.key as ItemColumn] } : c))}
      rows={shown}
      rowKey={(r) => r.key}
      selected={selected}
      onSelect={(k) => onSelect(k)}
      onActivate={onActivate && ((k) => onActivate(k))}
      group={groupOf}
      groupLabel={(g) =>
        groupLabel ? (
          groupLabel(g, shown.filter((r) => groupOf(r) === g))
        ) : (
          <>
            {/* qa-docs-62: a phone's header is a flex row, which drops the space: the gap keeps it. */}
            <span className="inline-flex items-baseline gap-1.5">
              {horizonLabel(g)} <span className="tnum font-sans text-sm font-semibold text-text2">{countLabel(g)}</span>
            </span>
          </>
        )
      }
      groupProps={(g) => ({ "data-testid": "roadmap-group", ...(groupBy ? { "data-group": g } : { "data-horizon": g }) })}
      rowProps={(r) => ({ "data-testid": "roadmap-item-row", ...rowDecorations?.(r) })}
      detail={detail}
      empty={empty}
    />
  );
}

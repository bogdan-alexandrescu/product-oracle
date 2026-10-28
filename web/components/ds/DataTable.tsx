"use client";

import { Fragment, useRef, type KeyboardEvent, type ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** CSS width of the column ("140px", "20%"); columns without one share the rest. */
  width?: string;
  align?: "left" | "right" | "center";
  /** Hidden at phone width (390); the same as `phone: "hide"`. */
  hideOnPhone?: boolean;
  /**
   * Its place in the phone layout (600 px and under), where each row is a stacked block:
   * "title" is line 1 and wraps, never truncated; "action" sits right of the title (below it
   * when there is no room); "meta" cells share line 2 as small text; "hide" drops the cell.
   * Default: the first column is the title, the rest are meta.
   */
  phone?: "title" | "meta" | "action" | "hide";
  /** On a phone, a short label before a meta cell's value ("Age"). */
  phoneLabel?: string;
  /** Lets a long value wrap onto a second line instead of truncating. */
  wrap?: boolean;
  /**
   * "hide" drops the column when the table itself is under 760 px wide above phone width (the
   * docked Ask panel or an inspector beside it), so the other columns keep their room and the
   * last one is never cut off. A container query: the window's width does not tell.
   * "laptop" drops it under 820 px (an inspector docked in a window under about 1400 px);
   * "mid" drops it under 1000 px (a docked drawer); "wide" drops it already under 1320 px, for a wide table's least needed columns.
   */
  narrow?: "hide" | "laptop" | "mid" | "wide";
  /** A sortable column's order, as its header's aria-sort. */
  ariaSort?: "ascending" | "descending" | "none";
  className?: string;
};

type PhoneRole = NonNullable<Column<unknown>["phone"]>;

/** A `narrow: "hide"` column's cells and <col> in a table under 760 px wide; a phone keeps its own layout. */
const NARROW_HIDE = "min-[601px]:@max-[760px]:hidden";
const LAPTOP_HIDE = "min-[601px]:@max-[820px]:hidden";
const MID_HIDE = "min-[601px]:@max-[1000px]:hidden";
const WIDE_HIDE = "min-[601px]:@max-[1320px]:hidden";
const narrowClass = (n: Column<unknown>["narrow"]) =>
  n === "hide" ? NARROW_HIDE : n === "laptop" ? LAPTOP_HIDE : n === "mid" ? MID_HIDE : n === "wide" ? WIDE_HIDE : "";

/** Phone-only classes per role; the row itself becomes a wrapping flex block. */
const PHONE_CELL: Record<PhoneRole, string> = {
  title:
    "max-[600px]:order-1 max-[600px]:min-w-0 max-[600px]:flex-[1_1_11rem] max-[600px]:p-0 max-[600px]:font-medium",
  action: "max-[600px]:order-2 max-[600px]:ml-auto max-[600px]:flex-none max-[600px]:p-0",
  meta: "max-[600px]:order-4 max-[600px]:inline-flex max-[600px]:min-w-0 max-[600px]:max-w-full max-[600px]:items-center max-[600px]:gap-1 max-[600px]:p-0 max-[600px]:text-sm max-[600px]:text-text2",
  hide: "max-[600px]:hidden",
};

/** On a phone nothing in a row truncates: identifying text wraps instead. */
const PHONE_WRAP =
  "max-[600px]:overflow-visible max-[600px]:whitespace-normal max-[600px]:[overflow-wrap:anywhere] max-[600px]:[&_.truncate]:overflow-visible max-[600px]:[&_.truncate]:whitespace-normal max-[600px]:[&_.truncate]:[overflow-wrap:anywhere]";

/**
 * B1's Ledger table: one-line rows, hairlines, sticky header, tabular numbers.
 *
 * With `onSelect`, rows are selectable: click a row, or focus the table and use
 * ArrowUp/ArrowDown (Home/End) to move the selection; Enter calls `onActivate`.
 * The selected row is tinted with an accent bar and carries aria-selected.
 *
 * On a phone (600 px and under) the grid gives way to stacked rows, as in B1's phone
 * frames: the title on line 1, the row's action to its right, the meta below as small
 * text. Each column's `phone` role places it.
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  selected,
  onSelect,
  onActivate,
  loading = false,
  empty = "Nothing yet",
  group,
  groupLabel,
  groupProps,
  groupHeader,
  groupOnly,
  rowProps,
  testId,
  hideHeader = false,
  detail,
}: {
  /** Accessible name of the table. */
  label: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  selected?: string | null;
  onSelect?: (key: string, row: T) => void;
  onActivate?: (key: string, row: T) => void;
  loading?: boolean;
  /** Empty state: a short title, no explanation (rule 1). */
  empty?: ReactNode;
  /** Group header rows: a header is drawn whenever this value changes. */
  group?: (row: T) => string;
  /** What a group header row shows (default: the group value). */
  groupLabel?: (group: string) => ReactNode;
  /** Attributes on a group header row (a test id, a data attribute). */
  groupProps?: (group: string) => Record<string, string | undefined>;
  /** What a group header shows (default: the group's value). */
  groupHeader?: (row: T) => ReactNode;
  /** A row that only stands for its group (a group with nothing in it): its header is drawn, the row is not. */
  groupOnly?: (row: T) => boolean;
  rowProps?: (row: T) => Record<string, string | undefined>;
  testId?: string;
  hideHeader?: boolean;
  /** A row opened in place: drawn under it across every column (the Inbox's answer form). */
  detail?: (row: T) => ReactNode;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const selectable = !!onSelect;
  const list = rows ?? [];
  const selIndex = list.findIndex((r) => rowKey(r) === selected);

  // Rows drawn as rows (not group-only), by index in `list`.
  const drawn = list.map((_, i) => i).filter((i) => !groupOnly?.(list[i]!));

  const focusRow = (i: number) => {
    const el = body.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[drawn.indexOf(i)];
    el?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number) => {
    const at = drawn.indexOf(i);
    let next = -1;
    if (e.key === "ArrowDown") next = drawn[Math.min(drawn.length - 1, at + 1)] ?? -1;
    else if (e.key === "ArrowUp") next = drawn[Math.max(0, at - 1)] ?? -1;
    else if (e.key === "Home") next = drawn[0] ?? -1;
    else if (e.key === "End") next = drawn[drawn.length - 1] ?? -1;
    else if (e.key === "Enter" || e.key === " ") {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      if (e.key === "Enter" && onActivate) onActivate(rowKey(list[i]!), list[i]!);
      else onSelect?.(rowKey(list[i]!), list[i]!);
      return;
    } else return;
    e.preventDefault();
    const row = list[next];
    if (!row) return;
    onSelect?.(rowKey(row), row);
    focusRow(next);
  };

  const align = (c: Column<T>) => (c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left");
  const role = (c: Column<T>, i: number): PhoneRole => (c.hideOnPhone ? "hide" : (c.phone ?? (i === 0 ? "title" : "meta")));
  const phone = (c: Column<T>) =>
    `${c.hideOnPhone || c.phone === "hide" ? "max-[600px]:hidden" : ""} ${narrowClass(c.narrow)}`.trim();
  const visibleCols = columns.length;

  const groups = group ? list.map(group) : [];
  return (
    <div className={`min-w-0 overflow-clip ${columns.some((c) => c.narrow) ? "@container" : ""}`} data-testid={testId}>
      <table
        // Roles are explicit because the phone layout changes the rows' CSS display.
        role={selectable ? "grid" : "table"}
        aria-label={label}
        aria-busy={loading || undefined}
        className="w-full table-fixed border-collapse text-[15px] leading-[22px] max-[600px]:block"
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} className={phone(c)} />
          ))}
        </colgroup>
        {/* On a phone the header is for screen readers only (sr-only: a 1 px clipped box), so
            nothing in it can run off the screen there (qa-work-31). */}
        <thead className={hideHeader ? "sr-only" : "max-[600px]:sr-only"} role="rowgroup">
          <tr role="row">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                role="columnheader"
                aria-sort={c.ariaSort}
                className={`sticky top-0 z-[1] h-9 bg-surface2 px-2 text-[13px] leading-4 font-semibold whitespace-nowrap text-text2 first:pl-4 last:pr-4 max-[600px]:first:pl-3 max-[600px]:last:pr-3 ${align(c)} ${phone(c)}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body} role="rowgroup" className="max-[600px]:block">
          {loading && list.length === 0 &&
            [0, 1, 2].map((i) => (
              <tr key={`l${i}`} aria-hidden className="h-11 border-t border-line max-[600px]:flex max-[600px]:items-center">
                <td colSpan={visibleCols} className="px-4 max-[600px]:block max-[600px]:w-full max-[600px]:px-3">
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
                </td>
              </tr>
            ))}
          {!loading && list.length === 0 && (
            <tr role="row" className="border-t border-line max-[600px]:block">
              <td role="cell" colSpan={visibleCols} className="px-4 py-8 max-[600px]:block text-center text-text2" data-testid="table-empty">
                {empty}
              </td>
            </tr>
          )}
          {list.map((row, i) => {
            const k = rowKey(row);
            const on = selectable && k === selected;
            const g = groups[i];
            const header = !!group && (i === 0 || g !== groups[i - 1]);
            // Roving tabindex: the selected row (or the first) is the table's one tab stop.
            const tabbable = selectable && (selIndex >= 0 ? i === selIndex : i === drawn[0]);
            const only = !!groupOnly?.(row);
            const extra = detail?.(row);
            return (
              <Fragment key={k}>
                {header && (
                  <tr role="row" className="border-t border-line bg-surface2 max-[600px]:block" data-group={g} {...groupProps?.(g)}>
                    <th
                      role="rowheader"
                      colSpan={visibleCols}
                      scope="colgroup"
                      className="h-9 px-4 max-[600px]:flex max-[600px]:items-center max-[600px]:px-3 text-left font-display tracking-heading text-[15px] font-bold"
                    >
                      {groupHeader ? groupHeader(row) : groupLabel ? groupLabel(g) : g}
                    </th>
                  </tr>
                )}
                {!only && (
                  <tr
                    data-row
                    data-key={k}
                    role="row"
                    {...rowProps?.(row)}
                    aria-selected={selectable ? on : undefined}
                    tabIndex={selectable ? (tabbable ? 0 : -1) : undefined}
                    onClick={selectable ? () => onSelect?.(k, row) : undefined}
                    onKeyDown={selectable ? (e) => onKey(e, i) : undefined}
                    className={`h-11 border-t border-line max-[600px]:flex max-[600px]:h-auto max-[600px]:min-h-12 max-[600px]:flex-wrap max-[600px]:items-center max-[600px]:gap-x-3 max-[600px]:gap-y-1 max-[600px]:px-3 max-[600px]:py-2.5 max-[600px]:after:order-3 max-[600px]:after:h-0 max-[600px]:after:basis-full max-[600px]:after:content-[''] ${selectable ? "cursor-pointer outline-offset-[-2px] hover:bg-surface2" : ""} ${
                      on ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)] hover:bg-accent-soft" : ""
                    }`}
                  >
                    {columns.map((c, ci) => {
                      const r = role(c, ci);
                      return (
                        <td
                          key={c.key}
                          role={selectable ? "gridcell" : "cell"}
                          data-phone={r}
                          className={`${c.wrap ? "break-words whitespace-normal" : "truncate"} px-2 py-1.5 first:pl-4 last:pr-4 max-[600px]:first:pl-0 max-[600px]:last:pr-0 ${align(c)} ${PHONE_CELL[r]} ${PHONE_WRAP} ${r === "meta" || r === "title" ? "max-[600px]:text-left" : ""} ${narrowClass(c.narrow)} ${c.className ?? ""}`}
                        >
                          {c.phoneLabel && r === "meta" && (
                            <span className="hidden font-semibold max-[600px]:inline">{c.phoneLabel}</span>
                          )}
                          {c.cell(row)}
                        </td>
                      );
                    })}
                  </tr>
                )}
                {extra != null && extra !== false && (
                  <tr role="row" data-detail={k} className="max-[600px]:block">
                    <td role="cell" colSpan={visibleCols} className="px-4 pt-1 pb-3 max-[600px]:block max-[600px]:px-3">
                      {extra}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { Fragment, useRef, type KeyboardEvent, type ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** CSS width of the column ("140px", "20%"); columns without one share the rest. */
  width?: string;
  align?: "left" | "right" | "center";
  /** Hidden at phone width (390), so a phone never scrolls sideways. */
  hideOnPhone?: boolean;
  className?: string;
};

/**
 * B1's Ledger table: one-line rows, hairlines, sticky header, tabular numbers.
 *
 * With `onSelect`, rows are selectable: click a row, or focus the table and use
 * ArrowUp/ArrowDown (Home/End) to move the selection; Enter calls `onActivate`.
 * The selected row is tinted with an accent bar and carries aria-selected.
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
  rowProps,
  testId,
  hideHeader = false,
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
  rowProps?: (row: T) => Record<string, string | undefined>;
  testId?: string;
  hideHeader?: boolean;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const selectable = !!onSelect;
  const list = rows ?? [];
  const selIndex = list.findIndex((r) => rowKey(r) === selected);

  const focusRow = (i: number) => {
    const el = body.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[i];
    el?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(list.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
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
  const phone = (c: Column<T>) => (c.hideOnPhone ? "max-[600px]:hidden" : "");
  const visibleCols = columns.length;

  const groups = group ? list.map(group) : [];
  return (
    <div className="min-w-0 overflow-clip" data-testid={testId}>
      <table
        role={selectable ? "grid" : undefined}
        aria-label={label}
        aria-busy={loading || undefined}
        className="w-full table-fixed border-collapse text-[15px] leading-[22px]"
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} className={phone(c) ? "max-[600px]:hidden" : ""} />
          ))}
        </colgroup>
        <thead className={hideHeader ? "sr-only" : ""}>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`sticky top-0 z-[1] h-9 bg-surface2 px-2 text-[13px] leading-4 font-semibold whitespace-nowrap text-text2 first:pl-4 last:pr-4 max-[600px]:first:pl-3 max-[600px]:last:pr-3 ${align(c)} ${phone(c)}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {loading && list.length === 0 &&
            [0, 1, 2].map((i) => (
              <tr key={`l${i}`} aria-hidden className="h-11 border-t border-line">
                <td colSpan={visibleCols} className="px-4">
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-surface2" />
                </td>
              </tr>
            ))}
          {!loading && list.length === 0 && (
            <tr className="border-t border-line">
              <td colSpan={visibleCols} className="px-4 py-8 text-center text-text2" data-testid="table-empty">
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
            const tabbable = selectable && (selIndex >= 0 ? i === selIndex : i === 0);
            return (
              <Fragment key={k}>
                {header && (
                  <tr className="border-t border-line bg-surface2" data-group={g}>
                    <th colSpan={visibleCols} scope="colgroup" className="h-9 px-4 text-left font-display text-[15px] font-bold">
                      {g}
                    </th>
                  </tr>
                )}
                <tr
                  data-row
                  data-key={k}
                  {...rowProps?.(row)}
                  aria-selected={selectable ? on : undefined}
                  tabIndex={selectable ? (tabbable ? 0 : -1) : undefined}
                  onClick={selectable ? () => onSelect?.(k, row) : undefined}
                  onKeyDown={selectable ? (e) => onKey(e, i) : undefined}
                  className={`h-11 border-t border-line ${selectable ? "cursor-pointer outline-offset-[-2px] hover:bg-surface2" : ""} ${
                    on ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)] hover:bg-accent-soft" : ""
                  }`}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`truncate px-2 py-1.5 first:pl-4 last:pr-4 max-[600px]:first:pl-3 max-[600px]:last:pr-3 ${align(c)} ${phone(c)} ${c.className ?? ""}`}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

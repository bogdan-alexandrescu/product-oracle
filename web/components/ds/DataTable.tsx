"use client";

import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePickableTable } from "./panel-close";

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
/** The table width under which each kind of narrow column is gone (as the classes above). */
const NARROW_UNDER: Record<NonNullable<Column<unknown>["narrow"]>, number> = { hide: 760, laptop: 820, mid: 1000, wide: 1320 };
/**
 * The table widths between those, each with the class that shows a cell only there: before the
 * table has measured itself (the server's HTML), a line spanning the columns has one cell per
 * band, so CSS alone gives it the span of the columns drawn. The last band's cell is the phone's.
 */
const BANDS = [
  { under: 760, show: "min-[601px]:@max-[760px]:table-cell" },
  { under: 820, show: "min-[601px]:@min-[760px]:@max-[820px]:table-cell" },
  { under: 1000, show: "min-[601px]:@min-[820px]:@max-[1000px]:table-cell" },
  { under: 1320, show: "min-[601px]:@min-[1000px]:@max-[1320px]:table-cell" },
  { under: Infinity, show: "min-[601px]:@min-[1320px]:table-cell max-[600px]:block" },
];

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
  /** Empty state: a short title, no explanation (rule 1); null draws no empty row (a list that failed). */
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
  // In a Split, a table that picks rows lets the Split's panel close (picking a row opens it again).
  usePickableTable(selectable);
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
  // The loading and empty lines span the columns drawn now. The CSS hides a phone's or a narrow
  // table's columns, but a hidden header cell still takes a column slot, which a span of the
  // visible count leaves out and a span of all of them gives the visible columns' room to. So
  // while the table has no rows, the hidden columns (read from their <col>) drop their header
  // cell. Rows keep every cell (their hidden ones line up with the header's), as do the lines
  // among them (a group, a row's detail), which span every column. Until the table has read its
  // <col>s (`hidden` is null: the server's HTML, the first paint), the lines use BANDS instead.
  const wrap = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string> | null>(null);
  const hides = columns.map((c) => `${c.key}:${phone(c)}`).join("|");
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const count = () => {
      const cols = [...el.querySelectorAll(":scope > table > colgroup > col")];
      const keys = columns.filter((_, i) => cols[i] && getComputedStyle(cols[i]).display === "none").map((c) => c.key);
      setHidden((was) => (was && keys.length === was.size && keys.every((k) => was.has(k)) ? was : new Set(keys)));
    };
    count();
    const watch = new ResizeObserver(count);
    watch.observe(el);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `hides` names every column and how it hides
  }, [hides]);
  const bare = list.length === 0;
  const narrow = columns.some((c) => c.narrow);
  /** A line across the table: one cell spanning the columns drawn, or one per band until they are known. */
  const across = (className: string, children: ReactNode, testId?: string) => {
    if (hidden || !narrow)
      return (
        <td role="cell" colSpan={Math.max(1, columns.filter((c) => !hidden?.has(c.key)).length)} className={`${className} max-[600px]:block`} data-testid={testId}>
          {children}
        </td>
      );
    return BANDS.map((b) => (
      <td
        key={b.under}
        role="cell"
        colSpan={Math.max(1, columns.filter((c) => !c.narrow || NARROW_UNDER[c.narrow] < b.under).length)}
        className={`${className} hidden ${b.show}`}
        data-testid={testId}
      >
        {children}
      </td>
    ));
  };

  const groups = group ? list.map(group) : [];
  return (
    <div ref={wrap} className={`min-w-0 overflow-clip ${narrow ? "@container" : ""}`} data-testid={testId}>
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
            nothing in it can run off the screen there (qa-work-31); its row wraps inside that
            box rather than laying its headers out wider than the phone (walk-docs-priorities 6). */}
        <thead className={hideHeader ? "sr-only" : "max-[600px]:sr-only"} role="rowgroup">
          <tr role="row" className={hideHeader ? "flex max-w-full flex-wrap" : "max-[600px]:flex max-[600px]:max-w-full max-[600px]:flex-wrap"}>
            {columns.map((c) =>
              bare && hidden?.has(c.key) ? null : (
                <th
                  key={c.key}
                  scope="col"
                  role="columnheader"
                  aria-sort={c.ariaSort}
                  className={`sticky top-0 z-[1] h-9 bg-surface2 px-2 text-[13px] leading-4 font-semibold whitespace-nowrap text-text2 first:pl-4 last:pr-4 max-[600px]:first:pl-3 max-[600px]:last:pr-3 ${align(c)} ${phone(c)}`}
                >
                  {c.header}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody ref={body} role="rowgroup" className="max-[600px]:block">
          {loading && list.length === 0 &&
            [0, 1, 2].map((i) => (
              <tr key={`l${i}`} aria-hidden className="h-11 border-t border-line max-[600px]:flex max-[600px]:items-center">
                {across(
                  "px-4 max-[600px]:w-full max-[600px]:px-3",
                  // qa4-shell-19: line-strong (3:1 on the card), so a loading list never reads as an empty, finished one.
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-line-strong" />,
                )}
              </tr>
            ))}
          {!loading && list.length === 0 && empty !== null && (
            <tr role="row" className="border-t border-line max-[600px]:block">
              {across("px-4 py-8 text-center text-text2", empty, "table-empty")}
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
                      colSpan={columns.length}
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
                    <td role="cell" colSpan={columns.length} className="px-4 pt-1 pb-3 max-[600px]:block max-[600px]:px-3">
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

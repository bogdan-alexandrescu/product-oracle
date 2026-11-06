"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { InfoTip } from "@/components/ds";
import { MarkFor } from "@/components/current-state/CurrentState";
import { useOpenFeature } from "@/components/simple/OpenFeature";
import { calendarDay } from "@/lib/dates";
import { PLAN_ROWS, type PlanStrip } from "@/lib/simple-home";

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The row grid: a label column beside the bars; on a phone the label sits above its bars
 * (qa-simple-prd-38: a narrow label column cut "Checkout redesi…" and "No milestone…"). */
const GRID = "grid grid-cols-[minmax(10rem,32%)_1fr] gap-x-2 max-[600px]:grid-cols-1";
/** vqa B-14: on a wide screen the one-pager's label column fits a milestone's name and its item
 * count ("M1 · Measure it, make it safe · 3 roadmap items"). */
const WIDE_LABELS = "min-[1280px]:grid-cols-[minmax(10rem,min(26rem,58%))_1fr]";

/** A row's name as read: a bare milestone code says it is a milestone ("Milestone M1"); a
 * named one keeps its name ("M1 · Prove it"). */
const rowName = (r: PlanStrip["rows"][number]) => (r.milestone && /^M\d{1,2}$/i.test(r.name) ? `Milestone ${r.name}` : r.name);

/**
 * vqa B-14: a one-pager row's label on one line ("Milestone M1 · 12 roadmap items"), cut with
 * an ellipsis when the column is too narrow; then an (i) beside it holds the whole label, the
 * item count with it. The words stay in the label for screen readers and the row's link.
 */
function RowLabel({ name, count, testId }: { name: string; count: string; testId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A ResizeObserver reports once when it starts, then on every change of the column's width.
    const ro = new ResizeObserver(() => setCut(el.scrollWidth > el.clientWidth + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [name, count]);
  const whole = `${name} · ${count}`;
  return (
    <span className="flex max-w-full min-w-0 items-center gap-1">
      <span ref={ref} className="min-w-0 truncate font-semibold" data-testid={`${testId}-label`} data-cut={cut ? "true" : undefined}>
        <span>{name} ·</span> <span>{count}</span>
      </span>
      {cut && (
        <span className="pointer-events-auto relative z-10">
          <InfoTip label={whole} align="start" testId={`${testId}-label-tip`}>
            {whole}
          </InfoTip>
        </span>
      )}
    </span>
  );
}

/**
 * The plan strip (the owner's pick after CLD's production walk, 2026-10-27), on Home and the
 * one-pager: a PRD's span by month, one row per milestone ("M1 · 12 items", its date, a
 * diamond on it over its items' span), the items with no milestone summed in one row,
 * today's line and the commitments past the edge; never a bar per item. A row opens the
 * roadmap filtered to the PRD; past PLAN_ROWS rows, "+N more on the roadmap".
 *
 * qa-simple-prd-13: a bar is the accent itself (3:1 or more against the card in both themes),
 * an estimated one the accent's stripes in a dashed accent outline; the diamond keeps a ring of
 * the card round it. qa-simple-prd-39/40: the month axis has no label (the page names the
 * PRD), and the commitments past the edge name the rows they are in, as plain text.
 */
export function PlanByMonth({
  plan,
  prd,
  testId = "plan-strip",
  named = false,
  legend = false,
  items,
  fold = false,
}: {
  plan: PlanStrip;
  prd: { slug: string; title: string };
  testId?: string;
  /** Home (qa-simple-home-17): the rows name their document ("Guided setup · no milestone · 4 items"). */
  named?: boolean;
  /** The one-pager (qa-simple-prd-p3-15): the counts say what the items are ("4 roadmap items"). */
  legend?: boolean;
  /** The one-pager (build-current-state review 2): its roadmap items (OnePagerOut.timeline),
   * listed under their row, one per line, each with its word pill (inside WithFeatureMarks). */
  items?: { id: string; title: string; code?: string | null }[];
  /** The timeline slide (C-8): each row's items fold to its count, their names on hover and on asking. */
  fold?: boolean;
}) {
  const open = useOpenFeature();
  const from = ms(plan.start);
  const span = ms(plan.end) + DAY - from;
  const pct = (day: string) => Math.max(0, Math.min(100, ((ms(day) - from) / span) * 100));
  const href = `/simple/roadmap?prd=${encodeURIComponent(prd.slug)}`;
  const today = plan.today ? pct(plan.today) : null;
  const shown = plan.rows.slice(0, PLAN_ROWS);
  const more = plan.rows.length - shown.length;
  const titles = new Map((items ?? []).map((i) => [i.id, i]));
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // qa-simple-home-12: each month's line runs down through the rows, so a bar reads against the axis above it.
  const grid = plan.months.map((m) => (
    <span key={m} aria-hidden data-testid={`${testId}-gridline`} className="pointer-events-none absolute inset-y-0 w-0 border-l border-line" style={{ left: `${pct(m)}%` }} />
  ));
  // vqa B-14: today's line runs down the rows only, below the month names, never through one
  // ("Nov"); the first row's piece is the one a test finds.
  const line = (first: boolean) =>
    today != null && (
      <span
        aria-hidden
        data-testid={first ? `${testId}-today` : undefined}
        className="pointer-events-none absolute inset-y-0 w-0 border-l-2 border-crit"
        style={{ left: `${today}%` }}
      />
    );
  // Which rows hold the commitments past the edge (the strip counts them; a row ending past
  // the edge with a committed item holds them): "1 commitment with no milestone ends after Jan".
  const after = `after ${calendarDay(plan.end, { month: "short" })}`;
  const holderRows = plan.rows.filter((r) => !r.estimated && r.end > plan.end);
  const holders = holderRows.map((r) => (r.milestone ? `in ${rowName(r)}` : "with no milestone"));
  const holderText = holders.length > 1 ? `${holders.slice(0, -1).join(", ")} and ${holders.at(-1)}` : (holders[0] ?? "");
  // qa4-simple-prd-15: the one-pager counts "roadmap items" in its rows, so its footnote does too.
  const rowGrid = named ? GRID : `${GRID} ${WIDE_LABELS}`;
  const edgeWord = legend ? ["roadmap item", "roadmap items"] : ["commitment", "commitments"];
  const ends = plan.past_edge === 1 ? "ends" : "end";
  // vqa B-14: on the one-pager, when one row holds every item past the edge and only some of
  // its items end there, the footnote and that row count the row's own items, as its label
  // does: "No milestone · 2 roadmap items", "1 of 2 ends after Jan", and "1 of the 2 roadmap
  // items with no milestone ends after Jan", never a bare "1 roadmap item" beside "2".
  const some = legend && holderRows.length === 1 && plan.past_edge > 0 && plan.past_edge < holderRows[0].items ? holderRows[0] : null;
  const edgeLine = some
    ? `${plan.past_edge} of the ${some.items} roadmap items ${holderText} ${ends} ${after}`
    : `${plan.past_edge} ${plan.past_edge === 1 ? edgeWord[0] : edgeWord[1]}${holderText ? ` ${holderText}` : ""} ${ends} ${after}`;
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className={`${rowGrid} items-end`}>
        <span aria-hidden className="max-[600px]:hidden" />
        <div className="relative h-6 text-[13px] text-text2">
          {plan.months.map((m) => (
            <span key={m} data-testid={`${testId}-month`} className="absolute top-0 truncate border-l border-line pl-1" style={{ left: `${pct(m)}%` }}>
              {calendarDay(m, { month: "short" })}
            </span>
          ))}
        </div>
      </div>
      <ul className="flex flex-col">
        {shown.map((r, k) => {
          const left = pct(r.start);
          const width = Math.max(1.5, pct(r.end) - left);
          // qa-simple-prd-p3-15: the one-pager names what the items are.
          const n = `${r.items} ${legend ? "roadmap " : ""}${r.items === 1 ? "item" : "items"}`;
          const label = named ? `${prd.title} · ${r.milestone ? rowName(r) : "no milestone"} · ${n}` : `${rowName(r)} · ${n}`;
          const when = r.date ? calendarDay(r.date, { month: "short", day: "numeric" }) : null;
          const rowLabel = `${label}${when ? ` · ${when}` : ""}: open the roadmap filtered to ${prd.title}`;
          const words = (
            <span className={`flex min-w-0 flex-col leading-tight max-[600px]:flex-row max-[600px]:flex-wrap max-[600px]:items-baseline max-[600px]:gap-x-2 ${named ? "" : "pointer-events-none relative"}`}>
              {/* qa4-simple-home-7 (Home, named): one line, an ellipsis when it does not fit, the whole label in its
                  tooltip; vqa B-14 (the one-pager): one line too, the whole label behind an (i) when cut. */}
              {named ? (
                <span className="max-w-full min-w-0 truncate font-semibold" title={label} data-testid={`${testId}-label`}>
                  {label}
                </span>
              ) : (
                <RowLabel name={rowName(r)} count={n} testId={testId} />
              )}
              {when && <span className="simple-small tnum">{when}{r.past_edge ? `, after ${calendarDay(plan.end, { month: "short" })}` : ""}</span>}
              {/* qa4-simple-prd-15: a row with no milestone date that runs past the edge says when it ends;
                  vqa B-14: how many of its items, when only some do (as the footnote counts them). */}
              {!when && legend && !r.estimated && r.end > plan.end && (
                <span className="simple-small" data-testid={`${testId}-ends`}>
                  {some === r ? `${plan.past_edge} of ${r.items} ${ends} ${after}` : `ends ${after}`}
                </span>
              )}
            </span>
          );
          const bars = (
            <span className={`relative h-7 ${named ? "" : "pointer-events-none"}`}>
              {grid}
              <span
                aria-hidden
                data-estimated={r.estimated ? "true" : undefined}
                data-testid={`${testId}-span`}
                className={`absolute top-2 h-3 rounded ${r.estimated ? "border border-dashed border-accent" : "bg-accent"}`}
                style={{
                  left: `${left}%`,
                  width: `${Math.min(width, 100 - left)}%`,
                  ...(r.estimated ? { backgroundImage: "repeating-linear-gradient(135deg, var(--accent) 0 4px, transparent 4px 9px)" } : {}),
                }}
              />
              {r.date && !r.past_edge && (
                <span aria-hidden data-testid={`${testId}-diamond`} className="absolute top-[5px] size-[18px] -translate-x-1/2 rotate-45 border-[3px] border-surface bg-accent-ink" style={{ left: `${pct(r.date)}%` }} />
              )}
              {line(k === 0)}
            </span>
          );
          const rowKey = `${r.name}|${r.date ?? ""}`;
          return (
            <li key={rowKey}>
              {named ? (
                <Link
                  href={href}
                  data-testid={`${testId}-row`}
                  data-milestone={r.milestone ? "true" : undefined}
                  aria-label={rowLabel}
                  className={`${rowGrid} items-center rounded-md py-1 hover:bg-surface2`}
                >
                  {words}
                  {bars}
                </Link>
              ) : (
                // vqa B-14: the whole row opens the roadmap (a link laid over it), and the label's (i)
                // sits above that link, never a button inside a link.
                <div
                  data-testid={`${testId}-row`}
                  data-milestone={r.milestone ? "true" : undefined}
                  className={`${rowGrid} relative items-center rounded-md py-1 hover:bg-surface2`}
                >
                  <Link href={href} aria-label={rowLabel} className="absolute inset-0 rounded-md" />
                  {words}
                  {bars}
                </div>
              )}
              {fold && (r.item_ids ?? []).some((id) => titles.has(id)) && (
                <button
                  type="button"
                  data-testid={`${testId}-names`}
                  aria-expanded={unfolded.has(rowKey)}
                  aria-label={`${unfolded.has(rowKey) ? "Hide" : "Show"} the names in ${rowName(r)}`}
                  title={(r.item_ids ?? []).flatMap((id) => { const it = titles.get(id); return it ? [it.code ? `${it.code} ${it.title}` : it.title] : []; }).join("\n")}
                  onClick={() => setUnfolded((s) => { const x = new Set(s); if (!x.delete(rowKey)) x.add(rowKey); return x; })}
                  className="simple-small ml-3 font-semibold text-accent-ink underline"
                >
                  {unfolded.has(rowKey) ? "Hide names" : "Show names"}
                </button>
              )}
              {items && (!fold || unfolded.has(rowKey)) && (r.item_ids ?? []).some((id) => titles.has(id)) && (
                // The row's items, one per line: the name wraps whole, its pill says what it is.
                <ul data-testid={`${testId}-items`} aria-label={`${rowName(r)}: its roadmap items`} className="simple-small flex flex-col gap-1 pb-2 pl-3 pt-0.5">
                  {(r.item_ids ?? []).flatMap((id) => {
                    const it = titles.get(id);
                    // one-feature-panel: the name (its code first) opens the feature's panel.
                    const name = (
                      <>
                        {it?.code && <span className="simple-code mr-1.5">{it.code}</span>}
                        {it?.title}
                      </>
                    );
                    return it ? [(
                      <li key={id} data-testid={`${testId}-item`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {open ? (
                          <button type="button" data-testid={`${testId}-item-open`} onClick={() => open({ id, code: it.code ?? "", name: it.title })} className="min-w-0 break-words text-left text-text hover:underline">
                            {name}
                          </button>
                        ) : (
                          <span className="min-w-0 break-words text-text">{name}</span>
                        )}
                        <MarkFor itemId={id} />
                      </li>
                    )] : [];
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {/* qa-simple-prd-p3-15: the one-pager's strip says what its marks are, as the plan timeline's legend does. */}
      {legend && (
        <p data-testid={`${testId}-legend`} className="simple-small flex flex-wrap gap-x-4 gap-y-1">
          {plan.today && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <i aria-hidden className="inline-block h-3.5 w-0.5 flex-none bg-crit" />
              Today {calendarDay(plan.today, { month: "short", day: "numeric" })}
            </span>
          )}
          {plan.rows.some((r) => r.estimated) && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-sm border border-dashed border-accent" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--accent) 0 4px, transparent 4px 9px)" }} />
              hatched = not confirmed
            </span>
          )}
          {plan.rows.some((r) => r.date) && (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <i aria-hidden className="inline-block size-2.5 flex-none rotate-45 bg-accent-ink" />
              milestone end
            </span>
          )}
        </p>
      )}
      {(more > 0 || plan.past_edge > 0) && (
        <p className="simple-small flex flex-wrap justify-between gap-2">
          {more > 0 ? (
            <Link href="/simple/roadmap" data-testid={`${testId}-more`} className="font-semibold text-accent-ink hover:underline">
              +{more} more on the roadmap
            </Link>
          ) : (
            <span />
          )}
          {plan.past_edge > 0 && (
            <span data-testid={`${testId}-edge`}>
              {edgeLine}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

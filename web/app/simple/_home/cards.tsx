"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/ds/Icon";

/**
 * The parts of Simple's Home (#723 S1, "Brief as cards"): a section card with its header row
 * (icon, title, count chip, "All ->" named for its card), the rows that share one layout with their actions in
 * one right-hand column, and a block's loading and failed states.
 */

/** A link's target: at least 24 px tall, 44 px on a phone (qa-simple-home-27). */
const TARGET = "inline-flex min-h-6 items-center max-[600px]:min-h-11";

/** A section card: header row, then its rows (or its state). */
export function HomeCard({
  id,
  icon,
  title,
  count,
  all,
  allLabel,
  extra,
  badge,
  children,
}: {
  id: string;
  icon: IconName;
  /** In the icon's place (Set up's progress ring). */
  badge?: ReactNode;
  title: string;
  count?: number | null;
  /** Beside the count ("1 late"). */
  extra?: ReactNode;
  all?: string;
  /** "All ->"'s name for a screen reader, from the card ("All decisions"); else "All: <title>". */
  allLabel?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} data-testid={`home-${id}`} className="simple-card scroll-mt-6">
      <header className="flex items-center gap-3">
        {badge ?? (
          <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
            <Icon name={icon} size={20} />
          </span>
        )}
        <h2 className="simple-h2 min-w-0 flex-1">{title}</h2>
        {count != null && count > 0 && (
          <span data-testid={`home-${id}-count`} className="simple-count tnum">
            {count}
          </span>
        )}
        {extra}
        {all && (
          <Link href={all} aria-label={allLabel ?? `All: ${title}`} data-testid={`home-${id}-all`} className={`simple-link whitespace-nowrap ${TARGET}`}>
            All -&gt;
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

/** A block's data: its rows, or skeleton rows while it loads, or a failure with Retry (the rest of Home stays). */
export function Block<T>({
  q,
  testId,
  skeleton,
  children,
}: {
  q: { data: T | undefined; error: string | null; reload: () => unknown };
  testId: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (q.error)
    return (
      <div role="alert" data-testid={`${testId}-failed`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface2 px-4 py-3">
        <span className="simple-small">Oracle could not load this part. {q.error}</span>
        <button type="button" onClick={() => void q.reload()} className="simple-button">
          Retry
        </button>
      </div>
    );
  if (q.data === undefined) return skeleton ?? <SkeletonRows />;
  return <>{children(q.data)}</>;
}

/** A grey bar the size of the text it stands for. */
export function Bar({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-[1em] animate-pulse rounded bg-surface2 align-middle ${className}`} />;
}

/** A block still loading (#723 production walk: Home paints at once): rows the height of real rows. */
export function SkeletonRows({ n = 2 }: { n?: number }) {
  return (
    <div role="status" data-testid="home-skeleton-rows" className="flex flex-col">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} aria-hidden className="simple-row">
          <span className="block size-9 flex-none animate-pulse rounded-full bg-surface2" />
          <div className="flex min-w-0 flex-col gap-1">
            <Bar className="w-2/3" />
            <Bar className="w-1/3 text-[length:var(--simple-small)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A card before the person's permissions are known: the header row and rows the size of a real
 * card's, but no title, since which card lands here depends on what the person may do.
 */
export function HomeCardSkeleton({ n = 2 }: { n?: number }) {
  return (
    <section data-testid="home-card-skeleton" className="simple-card">
      <header aria-hidden className="flex items-center gap-3">
        <span className="size-9 flex-none animate-pulse rounded-full bg-surface2" />
        <span className="simple-h2 min-w-0 flex-1">
          <Bar className="w-48 max-w-full" />
        </span>
      </header>
      <SkeletonRows n={n} />
    </section>
  );
}

/** The goal band while the goals load: three tiles the size of real ones. */
export function GoalBandSkeleton() {
  return (
    <div role="status" data-testid="home-goals-skeleton">
      <span className="sr-only">Loading…</span>
      <ul aria-hidden className="simple-goal-band">
        {[0, 1, 2].map((i) => (
          <li key={i} className="simple-goal">
            <Bar className="w-12" />
            <Bar className="w-3/4" />
            <Bar className="mt-auto w-20" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rows share one layout: lead (avatar or icon) · title · meta · before/after · thumbnail, then the actions column. */
export function HomeRow({
  lead,
  title,
  meta,
  change,
  thumb,
  actions,
  inlineActions = false,
  testId = "home-row",
}: {
  lead: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  change?: { before: string; after: string } | null;
  thumb?: boolean;
  actions?: ReactNode;
  /** The actions in a row (the primary first, the others beside it, wrapping), so the row hugs its text. */
  inlineActions?: boolean;
  testId?: string;
}) {
  const [wide, setWide] = useState(false);
  return (
    <li data-testid={testId} className="simple-row" data-wide={wide ? "true" : undefined}>
      <span className="flex-none">{lead}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold break-words">{title}</span>
        {meta && <span className="simple-small">{meta}</span>}
        {change && (
          <span className="simple-small flex flex-wrap items-center gap-2" data-testid="home-row-change">
            <del className="rounded bg-crit-bg px-1.5 text-crit">{change.before}</del>
            <span aria-hidden>→</span>
            <ins className="rounded bg-pass-bg px-1.5 text-pass no-underline">{change.after}</ins>
          </span>
        )}
        {thumb && (
          <button
            type="button"
            aria-expanded={wide}
            data-testid="home-flow-thumb"
            onClick={() => setWide((w) => !w)}
            className="mt-1 flex h-14 w-24 items-center justify-center rounded-lg border border-dashed border-line-strong text-[13px] text-text2 hover:bg-surface2"
          >
            Flow
          </button>
        )}
        {wide && (
          <div data-testid="home-flow-wide" className="mt-2 rounded-xl border border-line p-4">
            <p className="simple-small">No flow yet. Oracle draws the user flow and a wireframe of the screen it touches when it drafts one.</p>
          </div>
        )}
      </div>
      {actions && (
        <div
          data-testid="home-row-actions"
          className={inlineActions ? "simple-actions max-w-[22rem] flex-row! flex-wrap! items-center! justify-end! max-[600px]:max-w-none max-[600px]:justify-start!" : "simple-actions"}
        >
          {actions}
        </div>
      )}
    </li>
  );
}

/** A person's initials in a circle. */
export function Avatar({ name }: { name: string }) {
  const initials =
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  return (
    <span aria-hidden className="grid size-9 place-items-center rounded-full bg-surface2 text-[13px] font-semibold text-text2">
      {initials}
    </span>
  );
}

export function RowIcon({ name }: { name: IconName }) {
  return (
    <span aria-hidden className="grid size-9 place-items-center rounded-full bg-surface2 text-text2">
      <Icon name={name} size={20} />
    </span>
  );
}

/** The top rows and a "+ N more" line to the full list (`what` names its rows for a screen reader: "2 more of the decisions"). */
export function Top<T>({ rows, max = 3, more, what, children }: { rows: T[]; max?: number; more: string; what?: string; children: (row: T) => ReactNode }) {
  const left = rows.length - max;
  return (
    <>
      <ul className="flex flex-col">{rows.slice(0, max).map(children)}</ul>
      {left > 0 && (
        <Link href={more} data-testid="home-more" aria-label={what ? `${left} more ${what}` : undefined} className={`simple-more ${TARGET}`}>
          {left} more -&gt;
        </Link>
      )}
    </>
  );
}

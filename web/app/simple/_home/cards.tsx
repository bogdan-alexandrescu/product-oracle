"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/ds/Icon";
import { Loading } from "@/components/ui";

/**
 * The parts of Simple's Home (#723 S1, "Brief as cards"): a section card with its header row
 * (icon, title, count chip, "All ->"), the rows that share one layout with their actions in
 * one right-hand column, and a block's loading and failed states.
 */

/** A section card: header row, then its rows (or its state). */
export function HomeCard({
  id,
  icon,
  title,
  count,
  all,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  count?: number | null;
  all?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} data-testid={`home-${id}`} className="simple-card scroll-mt-6">
      <header className="flex items-center gap-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft text-accent-ink">
          <Icon name={icon} size={20} />
        </span>
        <h2 className="simple-h2 min-w-0 flex-1">{title}</h2>
        {count != null && count > 0 && (
          <span data-testid={`home-${id}-count`} className="simple-count tnum">
            {count}
          </span>
        )}
        {all && (
          <Link href={all} className="simple-small font-semibold whitespace-nowrap text-accent-ink hover:underline">
            All -&gt;
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

/** A block's data: its rows, or Loading, or a failure with Retry (the rest of Home stays). */
export function Block<T>({
  q,
  testId,
  children,
}: {
  q: { data: T | undefined; error: string | null; reload: () => unknown };
  testId: string;
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
  if (q.data === undefined) return <Loading />;
  return <>{children(q.data)}</>;
}

/** Rows share one layout: lead (avatar or icon) · title · meta · before/after · thumbnail, then the actions column. */
export function HomeRow({
  lead,
  title,
  meta,
  change,
  thumb,
  actions,
  testId = "home-row",
}: {
  lead: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  change?: { before: string; after: string } | null;
  thumb?: boolean;
  actions?: ReactNode;
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
      {actions && <div className="simple-actions">{actions}</div>}
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

/** The top rows and a "+ N more" line to the full list. */
export function Top<T>({ rows, max = 3, more, children }: { rows: T[]; max?: number; more: string; children: (row: T) => ReactNode }) {
  const left = rows.length - max;
  return (
    <>
      <ul className="flex flex-col">{rows.slice(0, max).map(children)}</ul>
      {left > 0 && (
        <Link href={more} data-testid="home-more" className="simple-small font-semibold text-accent-ink hover:underline">
          {left} more -&gt;
        </Link>
      )}
    </>
  );
}

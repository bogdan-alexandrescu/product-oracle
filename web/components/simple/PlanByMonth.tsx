"use client";

import Link from "next/link";

import { calendarDay } from "@/lib/dates";
import { PLAN_ROWS, type PlanStrip } from "@/lib/simple-home";

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * The plan strip (the owner's pick after CLD's production walk, 2026-10-27), on Home and the
 * one-pager: a PRD's span by month, one row per milestone ("M1 · 12 items", its date, a
 * diamond on it over its items' span), the items with no milestone summed in one row,
 * today's line and the commitments past the edge; never a bar per item. A row opens the
 * roadmap filtered to the PRD; past PLAN_ROWS rows, "+N more on the roadmap".
 */
export function PlanByMonth({ plan, prd, testId = "plan-strip" }: { plan: PlanStrip; prd: { slug: string; title: string }; testId?: string }) {
  const from = ms(plan.start);
  const span = ms(plan.end) + DAY - from;
  const pct = (day: string) => Math.max(0, Math.min(100, ((ms(day) - from) / span) * 100));
  const href = `/simple/roadmap?prd=${encodeURIComponent(prd.slug)}`;
  const today = plan.today ? pct(plan.today) : null;
  const shown = plan.rows.slice(0, PLAN_ROWS);
  const more = plan.rows.length - shown.length;
  const line = today != null && (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0 border-l-2 border-crit" style={{ left: `${today}%` }} />
  );
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className="grid grid-cols-[minmax(7.5rem,38%)_1fr] items-end gap-2 md:grid-cols-[minmax(10rem,32%)_1fr]">
        <span className="simple-small truncate">{prd.title}</span>
        <div className="relative h-6 text-[13px] text-text2">
          {plan.months.map((m) => (
            <span key={m} data-testid={`${testId}-month`} className="absolute top-0 truncate border-l border-line pl-1" style={{ left: `${pct(m)}%` }}>
              {calendarDay(m, { month: "short" })}
            </span>
          ))}
          {today != null && (
            <span data-testid={`${testId}-today`} aria-label={`Today, ${calendarDay(plan.today!, { month: "short", day: "numeric" })}`} className="absolute inset-y-0 w-0 border-l-2 border-crit" style={{ left: `${today}%` }} />
          )}
        </div>
      </div>
      <ul className="flex flex-col">
        {shown.map((r) => {
          const left = pct(r.start);
          const width = Math.max(1.5, pct(r.end) - left);
          const n = `${r.items} ${r.items === 1 ? "item" : "items"}`;
          const when = r.date ? calendarDay(r.date, { month: "short", day: "numeric" }) : null;
          return (
            <li key={`${r.name}|${r.date ?? ""}`}>
              <Link
                href={href}
                data-testid={`${testId}-row`}
                data-milestone={r.milestone ? "true" : undefined}
                aria-label={`${r.name} · ${n}${when ? ` · ${when}` : ""}: open the roadmap filtered to ${prd.title}`}
                className="grid grid-cols-[minmax(7.5rem,38%)_1fr] items-center gap-2 rounded-md py-1 hover:bg-surface2 md:grid-cols-[minmax(10rem,32%)_1fr]"
              >
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate font-semibold" data-testid={`${testId}-label`}>{`${r.name} · ${n}`}</span>
                  {when && <span className="simple-small tnum">{when}{r.past_edge ? " →" : ""}</span>}
                </span>
                <span className="relative h-7">
                  <span
                    aria-hidden
                    data-estimated={r.estimated ? "true" : undefined}
                    className={`absolute top-2 h-3 rounded ${r.estimated ? "simple-bar-estimated border border-dashed border-line-strong" : "bg-accent-soft"}`}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  />
                  {r.date && !r.past_edge && (
                    <span aria-hidden data-testid={`${testId}-diamond`} className="absolute top-[7px] size-3.5 -translate-x-1/2 rotate-45 bg-accent" style={{ left: `${pct(r.date)}%` }} />
                  )}
                  {line}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
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
              {plan.past_edge} {plan.past_edge === 1 ? "commitment ends" : "commitments end"} past {calendarDay(plan.end, { month: "short" })} →
            </span>
          )}
        </p>
      )}
    </div>
  );
}

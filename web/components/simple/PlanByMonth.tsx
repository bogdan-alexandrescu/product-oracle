"use client";

import Link from "next/link";

import { calendarDay } from "@/lib/dates";
import { PLAN_ROWS, type PlanStrip } from "@/lib/simple-home";

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The row grid: a label column beside the bars; on a phone the label sits above its bars
 * (qa-simple-prd-38: a narrow label column cut "Checkout redesi…" and "No milestone…"). */
const GRID = "grid grid-cols-[minmax(10rem,32%)_1fr] gap-x-2 max-[600px]:grid-cols-1";

/** A row's name as read: a bare milestone code says it is a milestone ("Milestone M1"); a
 * named one keeps its name ("M1 · Prove it"). */
const rowName = (r: PlanStrip["rows"][number]) => (r.milestone && /^M\d{1,2}$/i.test(r.name) ? `Milestone ${r.name}` : r.name);

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
  // Which rows hold the commitments past the edge (the strip counts them; a row ending past
  // the edge with a committed item holds them): "1 commitment with no milestone ends after Jan".
  const after = `after ${calendarDay(plan.end, { month: "short" })}`;
  const holders = plan.rows.filter((r) => !r.estimated && r.end > plan.end).map((r) => (r.milestone ? `in ${rowName(r)}` : "with no milestone"));
  const holderText = holders.length > 1 ? `${holders.slice(0, -1).join(", ")} and ${holders.at(-1)}` : (holders[0] ?? "");
  const edgeLine = `${plan.past_edge} ${plan.past_edge === 1 ? "commitment" : "commitments"}${holderText ? ` ${holderText}` : ""} ${plan.past_edge === 1 ? "ends" : "end"} ${after}`;
  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      <div className={`${GRID} items-end`}>
        <span aria-hidden className="max-[600px]:hidden" />
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
          const label = `${rowName(r)} · ${n}`;
          const when = r.date ? calendarDay(r.date, { month: "short", day: "numeric" }) : null;
          return (
            <li key={`${r.name}|${r.date ?? ""}`}>
              <Link
                href={href}
                data-testid={`${testId}-row`}
                data-milestone={r.milestone ? "true" : undefined}
                aria-label={`${label}${when ? ` · ${when}` : ""}: open the roadmap filtered to ${prd.title}`}
                className={`${GRID} items-center rounded-md py-1 hover:bg-surface2`}
              >
                <span className="flex min-w-0 flex-col leading-tight max-[600px]:flex-row max-[600px]:flex-wrap max-[600px]:items-baseline max-[600px]:gap-x-2">
                  <span className="truncate font-semibold max-[600px]:whitespace-normal max-[600px]:break-words" data-testid={`${testId}-label`}>{label}</span>
                  {when && <span className="simple-small tnum">{when}{r.past_edge ? `, after ${calendarDay(plan.end, { month: "short" })}` : ""}</span>}
                </span>
                <span className="relative h-7">
                  <span
                    aria-hidden
                    data-estimated={r.estimated ? "true" : undefined}
                    data-testid={`${testId}-bar`}
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
              {edgeLine}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

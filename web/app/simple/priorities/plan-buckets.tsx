"use client";

import { useEffect, useRef, useState } from "react";

import type { Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";

type Plan = Schemas["SimplePlanOut"];
type Milestone = Schemas["SimplePlanMilestone"];
type Slice = Schemas["SimpleSlice"];

/** One decimal, always ("4.0"): the owner's pick writes engineer-weeks this way. */
export const wk = (n: number): string => n.toFixed(1);

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number, one: string, many: string) => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`;

/** "Nov 2" (a calendar day, no time of day), as the owner's pick B writes the milestones' dates. */
const day = (iso: string): string => calendarDay(iso, { day: "numeric", month: "short" }, "en-US");

/**
 * A goal's name and its code, when it carries one: "G-A1 Account Safety" and "Account Safety
 * (G-A1)" read "Account Safety" with the code "G-A1"; "Reliability" has none.
 */
export function goalLabel(goal: string): { name: string; code: string | null } {
  const lead = /^(G-?[A-Z0-9]+(?:[.-][A-Z0-9]+)*)\s*[·:–—]?\s+(\S.*)$/.exec(goal.trim());
  if (lead) return { name: lead[2], code: lead[1] };
  const tail = /^(.*\S)\s*\((G-?[A-Z0-9]+(?:[.-][A-Z0-9]+)*)\)$/.exec(goal.trim());
  if (tail) return { name: tail[1], code: tail[2] };
  return { name: goal.trim(), code: null };
}

/** A milestone's colours (B: M1 blue, M2 violet, M3 amber, a fourth green): its bar, and its chip's tint and ink. */
export function milestoneColour(plan: Plan, code: string): { bar: string; tag: string; ink: string } {
  const k = (Math.max(0, plan.milestones.findIndex((m) => m.code === code)) % 4) + 1;
  return { bar: `var(--simple-m${k}-bar)`, tag: `var(--simple-m${k}-tag)`, ink: `var(--simple-m${k}-tag-ink)` };
}

/** "Nov 2 – Nov 27" and "13.0 of 16.0 wk" (no dates or capacity: left out). */
function legendParts(m: Milestone): { dates: string | null; full: string } {
  const dates = m.start_date && m.end_date ? `${day(m.start_date)} – ${day(m.end_date)}` : null;
  const full = m.effort_weeks != null ? `${wk(m.planned_weeks ?? 0)} of ${wk(m.effort_weeks)} wk` : `${wk(m.planned_weeks ?? 0)} wk planned`;
  return { dates, full };
}

/** "This quarter: 56.0 engineer-weeks over three milestones (51.0 planned + 5.0 spare). Bars are engineer-weeks." */
function summary(plan: Plan): string {
  const ms = plan.milestones;
  const planned = ms.reduce((n, m) => n + (m.planned_weeks ?? 0), 0);
  const over = count(ms.length, "milestone", "milestones");
  if (ms.some((m) => m.effort_weeks == null)) return `This quarter: ${wk(planned)} engineer-weeks planned over ${over}. Bars are engineer-weeks.`;
  const capacity = ms.reduce((n, m) => n + (m.effort_weeks ?? 0), 0);
  const spare = capacity - planned;
  const split = spare >= 0 ? `${wk(planned)} planned + ${wk(spare)} spare` : `${wk(planned)} planned, ${wk(-spare)} over`;
  return `This quarter: ${wk(capacity)} engineer-weeks over ${over} (${split}). Bars are engineer-weeks.`;
}

/** The goals in the plan's order (then any only the weeks name). */
export function planGoals(plan: Plan): string[] {
  const names = [...plan.goals.map((g) => g.name)];
  for (const w of plan.goal_weeks) if (!names.includes(w.goal)) names.push(w.goal);
  return names;
}

/** Each goal with its weeks per milestone. */
function goalRows(plan: Plan): { goal: string; parts: { milestone: string; weeks: number }[]; total: number }[] {
  const order = new Map(plan.milestones.map((m, i) => [m.code, i]));
  return planGoals(plan).map((goal) => {
    const parts = plan.goal_weeks
      .filter((w) => w.goal === goal && w.weeks > 0)
      .sort((a, b) => (order.get(a.milestone) ?? 99) - (order.get(b.milestone) ?? 99))
      .map((w) => ({ milestone: w.milestone, weeks: w.weeks }));
    return { goal, parts, total: parts.reduce((n, p) => n + p.weeks, 0) };
  });
}

/** The width of an element, kept as it resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setWidth(el.clientWidth);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A segment's label shows when the segment is wider than it (13 px type, padded); a narrower one is blank, its words in its title. */
const fits = (label: string, px: number) => px >= label.length * 8 + 12;

function GoalBar({ plan, goal, code, parts, total, max }: { plan: Plan; goal: string; code: string | null; parts: { milestone: string; weeks: number }[]; total: number; max: number }) {
  const [track, width] = useWidth<HTMLDivElement>();
  const label = (p: { milestone: string; weeks: number }) => `${p.milestone} ${wk(p.weeks)}`;
  return (
    <li data-testid="goal-bar" data-goal={goal} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-1.5 sm:grid-cols-[170px_1fr_90px]">
      <div className="min-w-0 text-[17px] font-[650] leading-6">
        <span data-testid="goal-bar-name">{goalLabel(goal).name}</span>
        {code && <span className="font-mono text-[12px] font-normal text-text2"> {code}</span>}
      </div>
      <div ref={track} data-testid="goal-bar-track" className="col-span-2 row-start-2 flex min-w-0 sm:col-span-1 sm:row-start-auto">
        {parts.map((p) => {
          const m = plan.milestones.find((x) => x.code === p.milestone);
          const shown = !!width && fits(label(p), (width * p.weeks) / max);
          return (
            <div
              key={p.milestone}
              data-testid="goal-bar-segment"
              data-milestone={p.milestone}
              title={`${p.milestone} ${m?.name ?? ""}: ${wk(p.weeks)} engineer-weeks`}
              className="flex h-[30px] flex-none items-center justify-center overflow-hidden border-r-2 border-surface text-[13px] font-[650] text-on-accent tabular-nums"
              style={{ width: `${(p.weeks / max) * 100}%`, background: milestoneColour(plan, p.milestone).bar }}
            >
              {shown ? (
                <span data-testid="goal-bar-label" className="whitespace-nowrap">
                  {label(p)}
                </span>
              ) : (
                <span className="sr-only">{label(p)}</span>
              )}
            </div>
          );
        })}
      </div>
      <b data-testid="goal-bar-total" className="text-right text-[16px] font-[650] tabular-nums">
        {wk(total)} wk
      </b>
    </li>
  );
}

/** plan-charts (the owner's pick B): where each goal's engineer-weeks land, milestone by milestone. */
export function PlanBucketsHead({ plan, codeOf }: { plan: Plan; codeOf: (goal: string) => string | null }) {
  const rows = goalRows(plan);
  // The longest bar stops short of the column's end, as B draws it.
  const max = Math.max(1, ...rows.map((r) => r.total)) * 1.07;
  return (
    <section data-testid="buckets-head" className="rounded-[var(--simple-card-radius)] border border-line bg-surface px-4 py-4 sm:px-5">
      <h2 className="text-[21px] font-[650] leading-7">Where each goal&apos;s work lands</h2>
      <p data-testid="buckets-summary" className="mb-2 mt-0.5 text-[16px] leading-6 text-text2">
        {summary(plan)}
      </p>
      <ul className="mb-1.5 flex flex-wrap gap-x-[18px] gap-y-1" aria-label="Milestones">
        {plan.milestones.map((m) => {
          const { dates, full } = legendParts(m);
          return (
            <li key={m.code} data-testid="milestone-chip" title={`${m.code} ${m.name}`} className="inline-flex items-center gap-1.5 text-[14px] leading-5 tabular-nums">
              <span aria-hidden className="inline-block h-3.5 w-3.5 flex-none rounded-[3px]" style={{ background: milestoneColour(plan, m.code).bar }} />
              <b className="font-[650]">{m.code} </b>
              {dates && <span className="whitespace-nowrap">{dates}</span>}
              {` · ${full}`}
            </li>
          );
        })}
      </ul>
      <ul aria-label="Engineer-weeks per goal">
        {rows.map((r) => (
          <GoalBar key={r.goal} plan={plan} goal={r.goal} code={codeOf(r.goal)} parts={r.parts} total={r.total} max={max} />
        ))}
      </ul>
      <p data-testid="buckets-footnote" className="mt-2 text-[14px] leading-5 text-text2">
        Each feature counts once, under the goal it moves most (listed first in the PRD&apos;s Goals column). Engineer-weeks are the PRD&apos;s, per slice.
      </p>
    </section>
  );
}

/** A slice's feature name: "Team invites, part 1 of 2" reads "Team invites". */
const featureName = (s: Slice) => s.name.replace(/, part \d+ of \d+$/, "");

/** Each goal's features (each once, under the goal it moves most) with their slices. */
export function planFeatures(plan: Plan, goal: string | null): { code: string; name: string; slices: Slice[]; weeks: number | null }[] {
  const by = new Map<string, Slice[]>();
  for (const s of plan.slices) if ((s.goal ?? null) === goal) by.set(s.feature_code, [...(by.get(s.feature_code) ?? []), s]);
  return [...by.entries()].map(([code, slices]) => {
    const weeks = slices.reduce((n, s) => n + (s.effort_weeks ?? 0), 0);
    return { code, name: featureName(slices[0]), slices, weeks: slices.every((s) => s.pm_owned) ? null : weeks };
  });
}

/** B's rows: the code, the name, a chip per milestone it lands in, its engineer-weeks (or PM-owned). */
export function PlanFeatureList({ plan, goal }: { plan: Plan; goal: string | null }) {
  const features = planFeatures(plan, goal);
  if (!features.length) return <p className="mt-2 text-[15px] text-text2">Nothing in the plan yet</p>;
  return (
    <ul className="mt-2">
      {features.map((f) => {
        const milestones = [...new Set(f.slices.map((s) => s.milestone))];
        return (
          <li key={f.code} data-testid="plan-feature" data-code={f.code} className="flex items-center gap-2 border-b border-line py-[5px] text-[16px] leading-[22px]">
            <span className="min-w-[38px] flex-none font-mono text-[13px] text-text2">{f.code}</span>{" "}
            <span data-testid="plan-feature-name" className="min-w-0 flex-1">
              {f.name}
            </span>
            <span className="flex flex-none gap-1">
              {milestones.map((code) => {
                const c = milestoneColour(plan, code);
                const of = f.slices.filter((s) => s.milestone === code);
                const weeks = of.every((s) => s.pm_owned || s.effort_weeks == null) ? "PM-owned" : `${wk(of.reduce((n, s) => n + (s.effort_weeks ?? 0), 0))} wk`;
                return (
                  <span
                    key={code}
                    data-testid="plan-chip"
                    title={`${code} ${of[0].milestone_name}: ${weeks}`}
                    className="inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-[12px] font-[650]"
                    style={{ background: c.tag, color: c.ink }}
                  >
                    {code}
                  </span>
                );
              })}
            </span>
            <span data-testid="plan-feature-total" className="w-[76px] flex-none text-right text-[15px] tabular-nums text-text2">
              {f.weeks == null ? "PM-owned" : `${wk(f.weeks)} wk`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "4 features this quarter". */
export const featureCount = (plan: Plan, goal: string | null): string => {
  const n = planFeatures(plan, goal).length;
  return `${n} ${n === 1 ? "feature" : "features"} this quarter`;
};

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

/** "2 Nov" (a calendar day, no time of day). */
const day = (iso: string): string => calendarDay(iso, { day: "numeric", month: "short" }, "en-GB");

/** A milestone's colour and the text on it: M1 light to M3 deep (a fourth on, then again). */
export function milestoneColour(plan: Plan, code: string): { bg: string; ink: string } {
  const k = Math.max(0, plan.milestones.findIndex((m) => m.code === code)) % 4;
  return { bg: `var(--simple-m${k + 1})`, ink: `var(--simple-m${k + 1}-ink)` };
}

/** "M2 Scale volume · 30 Nov - 25 Dec · 15.0 of 16.0 wk" (no dates or capacity: left out). */
function chipWords(m: Milestone): string {
  const dates = m.start_date && m.end_date ? ` · ${day(m.start_date)} - ${day(m.end_date)}` : "";
  const full = m.effort_weeks != null ? `${wk(m.planned_weeks ?? 0)} of ${wk(m.effort_weeks)} wk` : `${wk(m.planned_weeks ?? 0)} wk planned`;
  return `${m.code} ${m.name}${dates} · ${full}`;
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

/** The goals in the plan's order (then any only the weeks name), each with its weeks per milestone. */
function goalRows(plan: Plan): { goal: string; parts: { milestone: string; weeks: number }[]; total: number }[] {
  const names = [...plan.goals.map((g) => g.name)];
  for (const w of plan.goal_weeks) if (!names.includes(w.goal)) names.push(w.goal);
  const order = new Map(plan.milestones.map((m, i) => [m.code, i]));
  return names.map((goal) => {
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

/** A label fits inside a segment when the segment is wider than its text (15 px type, padded). */
const fits = (label: string, px: number) => px >= label.length * 9 + 14;

function GoalBar({ plan, goal, parts, total, max }: { plan: Plan; goal: string; parts: { milestone: string; weeks: number }[]; total: number; max: number }) {
  const [track, width] = useWidth<HTMLDivElement>();
  const label = (p: { milestone: string; weeks: number }) => `${p.milestone} ${wk(p.weeks)}`;
  // Labels too long for their segment are written under the bar instead (never cut).
  const outside = parts.filter((p) => !width || !fits(label(p), (width * p.weeks) / max));
  return (
    <li data-testid="goal-bar" data-goal={goal} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr_5rem]">
      <span data-testid="goal-bar-name" className="font-medium sm:order-none">
        {goal}
      </span>
      <div ref={track} data-testid="goal-bar-track" className="col-span-2 row-start-2 flex h-9 min-w-0 gap-0.5 sm:col-span-1 sm:row-start-auto">
        {parts.map((p) => {
          const c = milestoneColour(plan, p.milestone);
          const m = plan.milestones.find((x) => x.code === p.milestone);
          const inside = !outside.includes(p);
          return (
            <div
              key={p.milestone}
              data-testid="goal-bar-segment"
              data-milestone={p.milestone}
              title={`${p.milestone} ${m?.name ?? ""}: ${wk(p.weeks)} engineer-weeks`}
              className="flex h-full items-center rounded-md"
              style={{ width: `${(p.weeks / max) * 100}%`, background: c.bg, color: c.ink }}
            >
              {inside && <span className="block overflow-hidden whitespace-nowrap px-1.5 text-[length:var(--simple-small)] font-medium tabular-nums">{label(p)}</span>}
            </div>
          );
        })}
      </div>
      <span data-testid="goal-bar-total" className="text-right font-semibold tabular-nums sm:row-start-auto">
        {wk(total)} wk
      </span>
      {outside.length > 0 && (
        <p className="col-span-2 flex flex-wrap gap-x-3 text-[length:var(--simple-small)] text-text2 sm:col-start-2 sm:col-span-1">
          {outside.map((p) => (
            <span key={p.milestone} className="flex items-center gap-1 tabular-nums">
              <span aria-hidden className="inline-block h-3 w-3 rounded-sm" style={{ background: milestoneColour(plan, p.milestone).bg }} />
              {label(p)}
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

/** plan-charts (the owner's pick B): where each goal's engineer-weeks land, milestone by milestone. */
export function PlanBucketsHead({ plan }: { plan: Plan }) {
  const rows = goalRows(plan);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div data-testid="buckets-head" className="rounded-[var(--simple-card-radius)] border border-line bg-surface p-[var(--simple-card-pad)]">
      <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Where each goal&apos;s work lands</h2>
      <p data-testid="buckets-summary" className="mt-1 text-text2">
        {summary(plan)}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Milestones">
        {plan.milestones.map((m) => (
          <li key={m.code} data-testid="milestone-chip" className="flex items-center gap-2 rounded-full border border-line bg-bg px-3 py-0.5 text-[length:var(--simple-small)] tabular-nums">
            <span aria-hidden className="inline-block h-3 w-3 flex-none rounded-sm" style={{ background: milestoneColour(plan, m.code).bg }} />
            {chipWords(m)}
          </li>
        ))}
      </ul>
      <ul className="mt-4 flex flex-col gap-3" aria-label="Engineer-weeks per goal">
        {rows.map((r) => (
          <GoalBar key={r.goal} plan={plan} goal={r.goal} parts={r.parts} total={r.total} max={max} />
        ))}
      </ul>
      <p data-testid="buckets-footnote" className="mt-3 text-[length:var(--simple-small)] text-text2">
        Each feature counts once, under the goal it moves most. Engineer-weeks are the PRD&apos;s, per slice.
      </p>
    </div>
  );
}

/** A slice's feature name: "Team invites, part 1 of 2" reads "Team invites". */
const featureName = (s: Slice) => s.name.replace(/, part \d+ of \d+$/, "");

/** Each goal's features (each once, under the goal it moves most) with their milestone chips. */
export function planFeatures(plan: Plan, goal: string | null): { code: string; name: string; slices: Slice[]; weeks: number | null }[] {
  const by = new Map<string, Slice[]>();
  for (const s of plan.slices) if ((s.goal ?? null) === goal) by.set(s.feature_code, [...(by.get(s.feature_code) ?? []), s]);
  return [...by.entries()].map(([code, slices]) => {
    const weeks = slices.reduce((n, s) => n + (s.effort_weeks ?? 0), 0);
    return { code, name: featureName(slices[0]), slices, weeks: slices.every((s) => s.pm_owned) ? null : weeks };
  });
}

export function PlanFeatureList({ plan, goal }: { plan: Plan; goal: string | null }) {
  const features = planFeatures(plan, goal);
  if (!features.length) return <p className="mt-1 text-[length:var(--simple-small)] text-text2">Nothing in the plan yet</p>;
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {features.map((f) => (
        <li key={f.code} data-testid="plan-feature" data-code={f.code} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--simple-small)]">
          <span className="min-w-0 flex-1 basis-40">
            <span className="font-mono">{f.code}</span> {f.name}
          </span>
          {f.slices.map((s) => {
            const c = milestoneColour(plan, s.milestone);
            return (
              <span key={s.code} data-testid="plan-chip" title={`${s.milestone} ${s.milestone_name}`} className="rounded-full px-2 tabular-nums" style={{ background: c.bg, color: c.ink }}>
                {s.milestone} {s.pm_owned || s.effort_weeks == null ? "PM-owned" : `${wk(s.effort_weeks)} wk`}
              </span>
            );
          })}
          {f.weeks != null && (
            <span data-testid="plan-feature-total" className="w-16 text-right font-medium tabular-nums">
              {wk(f.weeks)} wk
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Each goal's engineer-weeks across the plan (its bar's total). */
export const goalTotal = (plan: Plan, goal: string) => plan.goal_weeks.filter((w) => w.goal === goal).reduce((n, w) => n + w.weeks, 0);

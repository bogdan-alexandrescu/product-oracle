"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { InfoTip } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";

type Plan = Schemas["SimplePlanOut"];
type Milestone = Schemas["SimplePlanMilestone"];
type Slice = Schemas["SimpleSlice"];

/** Engineer-weeks as the rest of the page writes them: "4", "5.5" (no trailing ".0"). */
export const wk = (n: number): string => Number(n.toFixed(1)).toString();
/** "week" for 1, else "weeks": the noun that follows `n`. */
const weekNoun = (n: number): string => (wk(n) === "1" ? "week" : "weeks");
/** Engineer-weeks in words, one wording across Priorities (the bars, the Value / effort chart, the Ranked tab): "1 week", "4 weeks", "5.5 weeks". */
export const weeksWords = (n: number): string => `${wk(n)} ${weekNoun(n)}`;
/** Engineer-weeks with the hyphenated noun, as the summary and a segment's title say them: "1 engineer-week", "4 engineer-weeks". */
const engineerWeeks = (n: number): string => `${wk(n)} engineer-${weekNoun(n)}`;

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

/**
 * "Nov 2 – Nov 27" and "13 of 16 weeks" (no dates or capacity: left out); when the two numbers take different nouns,
 * each its own: "2 weeks of 1 week", never "2 of 1 week".
 */
function legendParts(m: Milestone): { dates: string | null; full: string } {
  const dates = m.start_date && m.end_date ? `${day(m.start_date)} – ${day(m.end_date)}` : null;
  const planned = m.planned_weeks ?? 0;
  const of = m.effort_weeks == null ? null : weekNoun(planned) === weekNoun(m.effort_weeks) ? wk(planned) : weeksWords(planned);
  const full = m.effort_weeks != null ? `${of} of ${weeksWords(m.effort_weeks)}` : `${weeksWords(planned)} planned`;
  return { dates, full };
}

/** "Nov 2 – Feb 12": the plan's span, in the milestones' date style. */
export const planSpan = (span: { start: string; end: string }): string => `${day(span.start)} – ${day(span.end)}`;

/** "This plan, Nov 2 – Feb 12: 56 engineer-weeks over three milestones (51 planned + 5 spare). Bars are engineer-weeks." */
function summary(plan: Plan): string {
  const ms = plan.milestones;
  const span = plan.span ? `This plan, ${planSpan(plan.span)}` : "This plan";
  const planned = ms.reduce((n, m) => n + (m.planned_weeks ?? 0), 0);
  const over = count(ms.length, "milestone", "milestones");
  if (ms.some((m) => m.effort_weeks == null)) return `${span}: ${engineerWeeks(planned)} planned over ${over}. Bars are engineer-weeks.`;
  const capacity = ms.reduce((n, m) => n + (m.effort_weeks ?? 0), 0);
  const spare = capacity - planned;
  const split = spare >= 0 ? `${wk(planned)} planned + ${wk(spare)} spare` : `${wk(planned)} planned, ${wk(-spare)} over`;
  return `${span}: ${engineerWeeks(capacity)} over ${over} (${split}). Bars are engineer-weeks.`;
}

/** PR7: the summary's short line, "Nov 2 – Feb 12 · 56 engineer-weeks, 5 spare" (its sentence and the footnote behind the (i)). */
function shortSummary(plan: Plan): string {
  const ms = plan.milestones;
  const planned = ms.reduce((n, m) => n + (m.planned_weeks ?? 0), 0);
  let weeks = `${engineerWeeks(planned)} planned`;
  if (!ms.some((m) => m.effort_weeks == null)) {
    const capacity = ms.reduce((n, m) => n + (m.effort_weeks ?? 0), 0);
    const spare = capacity - planned;
    weeks = `${engineerWeeks(capacity)}, ${spare >= 0 ? `${wk(spare)} spare` : `${wk(-spare)} over`}`;
  }
  return plan.span ? `${planSpan(plan.span)} · ${weeks}` : weeks;
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

/** A Ground Truth feature code (F-12, a slice F-15a), else null: a short code made from a name's initials is no code. */
export const gtCode = (code: string | null | undefined): string | null => (code && /^[A-Z]{1,3}-\d+[a-j]?$/.test(code) ? code : null);

/** qa-simple-plan-37: a code as the other tabs draw it (the Ranked list's chip), never grey monospace. */
export function CodeTag({ code, title }: { code: string; title?: string }) {
  return (
    <span data-testid="prio-code" title={title} className="inline-block min-w-[3.25rem] flex-none whitespace-nowrap rounded-md border border-line-strong bg-surface px-1.5 text-center align-middle text-[13px] font-semibold leading-5 tabular-nums text-text">
      {code}
    </span>
  );
}

/**
 * A segment's label shows when its text, measured as drawn, fits the segment with 6 px to spare each side; a
 * narrower segment is blank, its words in its title. Measured, never guessed from the letter count, so a label
 * that fits is shown and one drawn wider on another system is never cut at the segment's edge.
 */
const LABEL_PAD = 12;

/** The milestones whose label fits its segment in `track`, measured whenever the track or the fonts change. */
function useFittingLabels(track: React.RefObject<HTMLDivElement | null>, width: number, key: string): Set<string> | null {
  const [fitting, setFitting] = useState<Set<string> | null>(null);
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    const f = document.fonts;
    if (!f) return;
    const on = () => setFonts((n) => n + 1);
    void f.ready.then(on);
    f.addEventListener("loadingdone", on);
    return () => f.removeEventListener("loadingdone", on);
  }, []);
  useLayoutEffect(() => {
    const t = track.current;
    if (!t || !width) return;
    const next = new Set<string>();
    for (const seg of t.querySelectorAll<HTMLElement>("[data-milestone]")) {
      const text = seg.querySelector<HTMLElement>("[data-label]");
      if (text && text.getBoundingClientRect().width + LABEL_PAD <= seg.clientWidth) next.add(seg.dataset.milestone!);
    }
    // A measurement of the drawn labels, set only when the set changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFitting((old) => (old && old.size === next.size && [...next].every((m) => old.has(m)) ? old : next));
  }, [track, width, key, fonts]);
  return fitting;
}

function GoalBar({ plan, goal, code, parts, total, max }: { plan: Plan; goal: string; code: string | null; parts: { milestone: string; weeks: number }[]; total: number; max: number }) {
  const [track, width] = useWidth<HTMLDivElement>();
  // mk-goalbuckets: a segment names its milestone ("M2 Fleet care · 4 weeks"), never the code alone.
  // A milestone's code and name; its code alone when it has no name.
  const named = (code: string) => [code, plan.milestones.find((x) => x.code === code)?.name].filter(Boolean).join(" ");
  const label = (p: { milestone: string; weeks: number }) => `${named(p.milestone)} · ${weeksWords(p.weeks)}`;
  const fitting = useFittingLabels(track, width, parts.map(label).join("|"));
  return (
    <li data-testid="goal-bar" data-goal={goal} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-1.5 sm:grid-cols-[170px_1fr_90px]">
      <div className="min-w-0 text-[17px] font-[650] leading-6">
        <span data-testid="goal-bar-name">{goalLabel(goal).name}</span>
        {code && <> <CodeTag code={code} /></>}
      </div>
      <div ref={track} data-testid="goal-bar-track" className="col-span-2 row-start-2 flex min-w-0 sm:col-span-1 sm:row-start-auto">
        {parts.map((p) => {
          const shown = !!fitting?.has(p.milestone);
          return (
            <div
              key={p.milestone}
              data-testid="goal-bar-segment"
              data-milestone={p.milestone}
              title={`${named(p.milestone)}: ${engineerWeeks(p.weeks)}`}
              className="relative flex h-[30px] flex-none items-center justify-center overflow-hidden border-r-2 border-surface text-[13px] font-[650] text-on-accent tabular-nums"
              style={{ width: `${(p.weeks / max) * 100}%`, background: milestoneColour(plan, p.milestone).bar }}
            >
              {/* A label that does not fit stays in the page, unseen (measured, and read out as sr-only text is). */}
              <span data-label data-testid={shown ? "goal-bar-label" : undefined} className={`whitespace-nowrap ${shown ? "" : "pointer-events-none absolute left-0 opacity-0"}`}>
                {label(p)}
              </span>
            </div>
          );
        })}
      </div>
      <b data-testid="goal-bar-total" className="text-right text-[16px] font-[650] tabular-nums">
        {weeksWords(total)}
      </b>
    </li>
  );
}

/** plan-charts (the owner's pick B): where each goal's engineer-weeks land, milestone by milestone. */
export function PlanBucketsHead<G extends { name: string }>({
  plan,
  codeOf,
  milestoneOf,
  onMilestone,
}: {
  plan: Plan;
  codeOf: (goal: string) => string | null;
  /** milestone-rename: the roadmap's own milestone a plan milestone is (its name and rights), if the reader sees it. */
  milestoneOf?: (code: string, name: string) => G | null;
  onMilestone?: (m: G) => void;
}) {
  const rows = goalRows(plan);
  // The longest bar stops short of the column's end, as B draws it.
  const max = Math.max(1, ...rows.map((r) => r.total)) * 1.07;
  return (
    <section data-testid="buckets-head" className="rounded-[var(--simple-card-radius)] border border-line bg-surface px-4 py-4 sm:px-5">
      <h2 className="text-[21px] font-[650] leading-7">Where each goal&apos;s work lands</h2>
      <p className="mb-2 mt-0.5 flex items-center gap-1.5 text-[16px] leading-6 text-text2">
        <span data-testid="buckets-summary">{shortSummary(plan)}</span>
        <InfoTip label="these bars" align="start" testId="buckets-about">
          <span data-testid="buckets-summary-full">{summary(plan)}</span>{" "}
          <span data-testid="buckets-footnote">Each feature counts once, under the goal it moves most (the first goal the one-pager names for it). Engineer-weeks are the one-pager&apos;s, part by part.</span>
        </InfoTip>
      </p>
      <ul className="mb-1.5 flex flex-wrap gap-x-[18px] gap-y-1" aria-label="Milestones">
        {plan.milestones.map((m) => {
          const { dates, full } = legendParts(m);
          // milestone-rename: its code opens the milestone's card, its name in place (the code stays).
          const own = milestoneOf?.(m.code, m.name) ?? null;
          const name = own?.name ?? m.name;
          return (
            <li key={m.code} data-testid="milestone-chip" title={`${m.code} ${name}`} className="inline-flex items-center gap-1.5 text-[14px] leading-5 tabular-nums">
              <span aria-hidden className="inline-block h-3.5 w-3.5 flex-none rounded-[3px]" style={{ background: milestoneColour(plan, m.code).bar }} />
              {own && onMilestone ? (
                <button type="button" data-testid="milestone-chip-edit" aria-label={`${m.code} ${name}`} className="font-[650] hover:underline" onClick={() => onMilestone(own)}>
                  {m.code}{" "}
                </button>
              ) : (
                <b className="font-[650]">{m.code} </b>
              )}
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

/** "4 features in the plan" (the plan may run past the quarter). */
export const featureCount = (plan: Plan, goal: string | null): string => {
  const n = planFeatures(plan, goal).length;
  return `${n} ${n === 1 ? "feature" : "features"} in the plan`;
};

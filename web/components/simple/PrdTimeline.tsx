"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { FlowDiagram } from "@/components/simple/FlowViews";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, todayIn, useCompanyZone } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

type Plan = Schemas["SimplePlanOut"];
type Milestone = Schemas["SimplePlanMilestone"];
type Slice = Schemas["SimpleSlice"];
type Goal = Schemas["SimplePlanGoal"];
type Decision = Schemas["SimplePlanDecision"];
type Risk = Schemas["SimplePlanRisk"];

/*
 * fidelity prd (the owner's picks, 2026-10-28, "keep the mockup design very strictly"):
 * D "Timeline first" (prd-shape D1 desktop, D2 phone, D3 no dates) and B "Goal lanes"
 * (timeline-overlap B1, the When strip). On a desktop the plan is two cards under the PRD's
 * header: the timeline card (the PRD's summary lines, the When strip with one slim lane per
 * goal, the decisions with a date and the legend, then "Milestones: done when") and, under
 * it, the picked milestone's own card (D1's M1 card). On a phone the timeline turns vertical
 * (D2) and the milestone's card follows it.
 */

const DAY = 86_400_000;
const PM_LANE = "Product manager's work";
const ms = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
/** "Nov 27": a day written as everywhere else in the app (qa-shell-21). */
const dm = (day: string) => calendarDay(day);
/** "Nov 27, 2026". */
export const dmy = (day: string) => calendarDay(day, { month: "short", day: "numeric", year: "numeric" });
/** "56", "2.5": a number of weeks with no pointless ".0". */
const weeks = (n: number) => String(Math.round(n * 10) / 10);
/** "56 engineer-weeks", "2.5 engineer-weeks", "1 engineer-week". */
export const ew = (n: number) => `${weeks(n)} ${Math.round(n * 10) === 10 ? "engineer-week" : "engineer-weeks"}`;

export const PHONE = "(max-width: 767px)";
function subscribePhone(on: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}
export const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);

/** A milestone's hue as the mock-ups draw it (M1 blue, M2 violet, M3 amber, then round again). */
function hue(plan: Plan, code: string) {
  const n = (Math.max(0, plan.milestones.findIndex((m) => m.code === code)) % 3) + 1;
  return { line: `var(--prd-m${n})`, bg: `var(--prd-m${n}-bg)`, fill: `var(--prd-m${n}-fill)` };
}

// ---------------------------------------------------------------- text widths

let measure: CanvasRenderingContext2D | null | undefined;
let family = "sans-serif";
/** The drawn width of `text` in the page's font (a label fitted to its bar is never cut). */
function textWidth(text: string, px: number, weight: number): number {
  if (typeof document === "undefined") return text.length * px * 0.6;
  if (measure === undefined) {
    measure = document.createElement("canvas").getContext("2d");
    family = getComputedStyle(document.body).fontFamily || family;
  }
  if (!measure) return text.length * px * 0.6;
  measure.font = `${weight} ${px}px ${family}`;
  return measure.measureText(text).width;
}
const fits = (variants: string[], room: number, px = 12, weight = 650) =>
  variants.find((v) => textWidth(v, px, weight) + 2 <= room) ?? variants[variants.length - 1];

// ---------------------------------------------------------------- the plan's shape

/** A piece of work in a lane: a run of one milestone's slices (a gap of more than two weeks starts a new one). */
export type Piece = { milestone: string; slices: Slice[]; start: string; end: string; row: number; pm: boolean };

export function piecesOf(slices: Slice[]): Piece[] {
  const out: Piece[] = [];
  const by = new Map<string, Slice[]>();
  for (const s of slices) if (s.start_date && s.end_date) by.set(s.milestone, [...(by.get(s.milestone) ?? []), s]);
  for (const [milestone, of] of by) {
    let cur: Piece | null = null;
    for (const s of [...of].sort((a, b) => a.start_date!.localeCompare(b.start_date!))) {
      if (cur && ms(s.start_date!) - ms(cur.end) <= 14 * DAY) {
        cur.slices.push(s);
        if (s.end_date! > cur.end) cur.end = s.end_date!;
      } else {
        cur = { milestone, slices: [s], start: s.start_date!, end: s.end_date!, row: 0, pm: s.pm_owned };
        out.push(cur);
      }
    }
  }
  // The owner's rule: pieces that run at the same time, or less than a week apart (their bars
  // would touch and read as one), stack into the next row.
  out.sort((a, b) => a.start.localeCompare(b.start));
  const rows: string[] = [];
  for (const p of out) {
    let r = rows.findIndex((end) => ms(p.start) - ms(end) >= 7 * DAY);
    if (r < 0) r = rows.length;
    rows[r] = p.end;
    p.row = r;
  }
  return out;
}

type Lane = { name: string; goal: Goal | null; pieces: Piece[] };

/** The lanes: one per goal (the plan's order), then the PM-owned lane. */
function lanesOf(plan: Plan): Lane[] {
  const names = [...plan.goals.map((g) => g.name)];
  for (const s of plan.slices) if (!s.pm_owned && s.goal && !names.includes(s.goal)) names.push(s.goal);
  const lanes: Lane[] = names.map((n) => ({
    name: n,
    goal: plan.goals.find((g) => g.name === n) ?? null,
    pieces: piecesOf(plan.slices.filter((s) => !s.pm_owned && s.goal === n)),
  }));
  const pm = plan.slices.filter((s) => s.pm_owned);
  if (pm.length) lanes.push({ name: PM_LANE, goal: null, pieces: piecesOf(pm) });
  return lanes;
}

/** "M1 100 → M2 250 → M3 600 weekly active teams": the unit once when every target shares it. */
export function targetSteps(goal: Goal): string {
  const t = goal.targets;
  if (!t.length) return "No targets yet";
  const split = t.map((x) => x.target.match(/^(\S+)\s+(.+)$/));
  const unit = split[0]?.[2];
  if (unit && split.every((m) => m && m[2] === unit)) return `${t.map((x, i) => `${x.milestone} ${split[i]![1]}`).join(" → ")} ${unit}`;
  return t.map((x) => `${x.milestone} ${x.target}`).join(" → ");
}

/** "Now 40 · behind": what is measured now (the unit the target line already gives is left out). */
function measuredWords(goal: Goal | null): string {
  if (!goal?.measured) return "Not counted yet";
  const unit = goal.targets[0]?.target.match(/^\S+\s+(.+)$/)?.[1];
  const value = unit && goal.measured.endsWith(` ${unit}`) ? goal.measured.slice(0, -unit.length - 1) : goal.measured;
  return `Now ${value}${goal.on_track == null ? "" : goal.on_track ? " · on track" : " · behind"}`;
}

const dated = (m: Milestone) => !!(m.start_date && m.end_date);

/** The milestone running today, else the next to start, else (none dated) the first, else the last. */
function currentOf(plan: Plan, today: string): string | null {
  const d = plan.milestones.filter(dated);
  return (
    d.find((m) => m.start_date! <= today && today <= m.end_date!)?.code ??
    d.find((m) => m.start_date! > today)?.code ??
    (d.length ? d[d.length - 1].code : plan.milestones[0]?.code) ??
    null
  );
}

/** A milestone's length in weeks ("4 weeks"; "7 weeks, holidays inside"). */
function weeksWords(plan: Plan, m: Milestone): string {
  const n = Math.max(1, Math.round((ms(m.end_date!) - ms(m.start_date!) + 3 * DAY) / (7 * DAY)));
  const off = plan.holidays.some((h) => h.start <= m.end_date! && h.end >= m.start_date!);
  return `${n} ${n === 1 ? "week" : "weeks"}${off ? ", holidays inside" : ""}`;
}

/** "Now · week 2 of 4", "Next · starts 30 Nov", "Later · starts 28 Dec", "Ended 27 Nov". */
function stateOf(plan: Plan, m: Milestone, today: string): { words: string; now: boolean; week: string | null } {
  if (!dated(m)) return { words: "No dates yet", now: false, week: null };
  if (today < m.start_date!) {
    const next = plan.milestones.filter(dated).find((x) => x.start_date! > today)?.code === m.code;
    return { words: `${next ? "Next" : "Later"} · starts ${dm(m.start_date!)}`, now: false, week: null };
  }
  if (today > m.end_date!) return { words: `Ended ${dm(m.end_date!)}`, now: false, week: null };
  const n = Math.max(1, Math.round((ms(m.end_date!) - ms(m.start_date!) + 3 * DAY) / (7 * DAY)));
  const k = Math.min(n, Math.floor((ms(today) - ms(m.start_date!)) / (7 * DAY)) + 1);
  return { words: `Now · week ${k} of ${n}`, now: true, week: `week ${k} of ${n}` };
}

/** "16 engineer-weeks, 3 of it buffer": the milestone's engineer-weeks and what is left unplanned. */
function ewWords(m: Milestone): string | null {
  const cap = m.effort_weeks;
  if (cap == null) return m.planned_weeks ? `${ew(m.planned_weeks)} planned` : null;
  if (m.planned_weeks < 0.05) return `${ew(cap)} capacity, nothing planned yet`;
  const left = cap - m.planned_weeks;
  if (left >= 0.05) return `${ew(cap)}, ${weeks(left)} of it buffer`;
  if (left <= -0.05) return `${ew(cap)} capacity, ${ew(m.planned_weeks)} planned`;
  return ew(cap);
}

/** "Nov 2 → Nov 27, 2026"; across a year end "Dec 28, 2026 → Feb 12, 2027". */
function spanWords(start: string, end: string): string {
  return start.slice(0, 4) === end.slice(0, 4) ? `${dm(start)} → ${dmy(end)}` : `${dmy(start)} → ${dmy(end)}`;
}

/** A target as a tile: its number and its words ("250" and "weekly active teams"). */
export function splitTarget(t: string): [string, string] {
  const m = t.match(/^((?:[≥≤<>~≈]\s*)?\S+)\s+(.+)$/);
  if (!m || !/\d/.test(m[1])) return [t, ""];
  return [m[1], m[2]];
}

/** Where a day falls in the plan: "before M2 starts", "at the M1 review", "M1 week 2"; null outside the milestones. */
function placeOf(plan: Plan, day: string): string | null {
  for (const m of plan.milestones.filter(dated)) {
    if (day === m.start_date) return `before ${m.code} starts`;
    if (day === m.end_date) return `at the ${m.code} review`;
    if (m.start_date! < day && day < m.end_date!) return `${m.code} week ${Math.floor((ms(day) - ms(m.start_date!)) / (7 * DAY)) + 1}`;
  }
  return null;
}

/** A due day in words: "was due M1 week 1" / "was due 20 Oct" when past, else "before M2 starts, 30 Nov" or "due 5 Nov". */
function dueWords(plan: Plan, day: string, today: string, withDay = true): { words: string; late: boolean } {
  const place = placeOf(plan, day);
  if (day < today) return { words: place?.includes("week") ? `was due ${place}` : `was due ${dm(day)}`, late: true };
  if (!withDay) return { words: place ?? "", late: false };
  return { words: place ? `${place}, ${dm(day)}` : `due ${dm(day)}`, late: false };
}

/**
 * The decisions with a due day, one entry per day (D1 joins "Q4 M1 trigger · Q8 numbers"). A
 * milestone with no dates keeps its decisions under it (they are worded against milestones).
 */
function datedDecisions(plan: Plan): { day: string; label: string; codes: string[] }[] {
  const by = new Map<string, Decision[]>();
  for (const m of plan.milestones.filter(dated)) for (const d of m.decisions) if (d.due_on && !by.get(d.due_on)?.some((x) => x.code === d.code)) by.set(d.due_on, [...(by.get(d.due_on) ?? []), d]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ds]) => ({ day, codes: ds.map((d) => d.code), label: ds.map((d) => `${d.code} ${d.title}`).join(" · ") }));
}

const named = (s: Slice) => `${s.code} ${s.name}`;

/** A bar's label, longest first: every feature by code and name, then fewer with "+N", then the count. */
function barVariants(p: Piece): string[] {
  const sl = p.slices;
  if (sl.length === 1) return [named(sl[0]), sl[0].name, sl[0].code];
  const out = [sl.map(named).join(" · ")];
  for (let k = sl.length - 1; k >= 1; k--) out.push(`${sl.slice(0, k).map(named).join(" · ")} +${sl.length - k}`);
  out.push(`${sl[0].name} +${sl.length - 1}`, `${sl[0].code} +${sl.length - 1}`, `${sl.length} features`);
  return out;
}

/** Brings the picked milestone's card into view once it has rendered. */
function showPart() {
  requestAnimationFrame(() => document.getElementById("milestone-part")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

/** "**Goal: x.** rest": the PRD's bold words bold. */
function Bolded({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <b key={i} className="font-bold">{part.slice(2, -2)}</b> : <span key={i}>{part}</span>))}
    </>
  );
}

// ---------------------------------------------------------------- shared pieces

const SEC_H = "text-[13px] leading-[18px] font-bold uppercase tracking-[.07em] text-text-faint";
const H3 = "text-[20px] leading-[28px] font-[650]";
const PAPER = "min-w-0 rounded-[14px] border border-[var(--simple-rule)] bg-[var(--simple-paper)]";
const CODE = "self-start justify-self-start whitespace-nowrap rounded-[6px] px-[7px] py-px font-mono text-[13px] leading-[20px] font-semibold";

function MTag({ plan, code, small }: { plan: Plan; code: string; small?: boolean }) {
  return (
    <span
      className={`inline-grid flex-none place-items-center font-mono font-bold leading-none ${small ? "h-6 min-w-8 rounded-[8px] px-2 text-[13px]" : "h-7 min-w-[38px] rounded-[8px] px-2 text-[15px]"}`}
      style={{ background: hue(plan, code).line, color: "var(--simple-paper)" }}
    >
      {code}
    </span>
  );
}

function FlowIcon() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="flex-none">
      <rect x="3" y="4" width="7" height="5" rx="1" />
      <rect x="14" y="15" width="7" height="5" rx="1" />
      <path d="M6.5 9v3.5a2 2 0 002 2H14" />
    </svg>
  );
}

const FLAG = (
  <svg viewBox="0 0 12 12" width={13} height={13} aria-hidden fill="currentColor" className="flex-none">
    <path d="M2 1h1.4v10H2zM3.4 1.5h7l-1.8 2.6 1.8 2.6h-7z" />
  </svg>
);

// ---------------------------------------------------------------- the plan

/**
 * The PRD's plan under its header: the timeline card and the picked milestone's card on a
 * desktop (D1 with B1's When strip), the vertical timeline and the milestone's card on a phone
 * (D2). Picking a milestone in the timeline switches the card.
 */
export function PrdPlan({ plan, title, onPlan }: { plan: Plan; title: string; onPlan: (p: Plan) => void }) {
  const phone = usePhone();
  const zone = useCompanyZone();
  // Today in the company's time zone.
  const [today] = useState(() => todayIn(zone));
  const [picked, setPicked] = useState<string | null>(null);
  const pick = picked ?? currentOf(plan, today);
  const m = plan.milestones.find((x) => x.code === pick) ?? null;
  return phone ? (
    <PhonePlan plan={plan} title={title} today={today} pick={pick} onPick={setPicked} onPlan={onPlan} m={m} />
  ) : (
    <>
      <TimelineCard
        plan={plan}
        today={today}
        pick={pick}
        onPick={setPicked}
        onShow={(c) => {
          setPicked(c);
          showPart();
        }}
        onPlan={onPlan}
      />
      {m && <MilestoneCard plan={plan} m={m} today={today} phone={false} />}
    </>
  );
}

/** The no-dates note (D3): the milestones without dates as chips, and for an owner "Read the plan again". */
function NoDates({ plan, onPlan }: { plan: Plan; onPlan: (p: Plan) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const undated = plan.milestones.filter((x) => !dated(x));
  async function read() {
    setBusy(true);
    setError(null);
    try {
      onPlan(await unwrap(api.POST("/v1/simple/prds/{prd}/plan/read-again", { params: { path: { prd: plan.prd.slug } } })));
      setAgain(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="timeline-no-dates" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-dashed border-line-strong px-3 py-2.5">
      <span className="text-[14px] leading-5">
        <b className="font-bold">No dates yet:</b>{" "}
        {undated.map((x) => {
          const c = hue(plan, x.code);
          return (
            <span key={x.code} className="mr-1.5 inline-flex h-6 items-center whitespace-nowrap rounded-xl px-[9px] text-[13px] leading-[18px] font-semibold" style={{ background: c.bg, color: c.line }}>
              {x.code} · {x.name}
            </span>
          );
        })}
      </span>
      <span className="basis-full text-[14px] leading-5 text-text2">
        {plan.can_read_again ? "Add dates to the milestones in the PRD, then read it again." : `The PRD gives no dates for ${undated.length === 1 ? "it" : "them"} yet.`}
      </span>
      {plan.can_read_again && (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void read()}
          className="simple-noprint inline-flex min-h-[34px] items-center whitespace-nowrap rounded-[9px] border border-accent bg-accent px-2.5 text-[14px] font-semibold text-on-accent disabled:opacity-60"
        >
          {busy ? "Reading the plan…" : "Read the plan again"}
        </button>
      )}
      {again && <span role="status" className="text-[14px] text-text-faint">Read again: the PRD still gives no dates.</span>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Each goal with its targets per milestone and how it stands now ("Now 40 · behind"): where no lane draws it. */
function GoalList({ plan }: { plan: Plan }) {
  if (!plan.goals.length) return null;
  return (
    <div data-testid="timeline-goal-list">
      <h3 className={SEC_H}>Goals</h3>
      <ul className="mt-1">
        {plan.goals.map((g) => (
          <li key={g.name} data-testid="timeline-goal" className="list-none border-t border-[var(--simple-rule)] py-1.5 first:border-t-0">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <b className="text-[15px] leading-5 font-bold">{g.name}</b>
              <small className={`text-[13px] leading-[18px] ${g.on_track === false ? "font-[650] text-crit" : "text-text-faint"}`}>{measuredWords(g)}</small>
            </span>
            <small className="block text-[13px] leading-[18px] text-text2">{targetSteps(g)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A decision's line under its milestone: its code and title, and its day when it has one. */
function DecisionLine({ d }: { d: Decision }) {
  return (
    <li className="relative list-none pl-[18px] text-[14px] leading-5">
      <span aria-hidden className="absolute top-[5px] left-0.5 h-2.5 w-2.5 rotate-45 rounded-[2px]" style={{ background: "var(--warn)" }} />
      <b className="font-bold">
        {d.code} {d.title}
      </b>
      <span className="text-text-faint">{d.due_on ? ` · due ${dm(d.due_on)}` : " · no date yet"}</span>
    </li>
  );
}

/** The milestones with no dates, in order (D3): each with its targets and the decisions it needs. */
function UndatedList({ plan }: { plan: Plan }) {
  const undated = plan.milestones.filter((x) => !dated(x));
  if (!undated.length) return null;
  return (
    <ul data-testid="timeline-undated" className="flex flex-col gap-2.5">
      {undated.map((x) => (
        <li key={x.code} data-testid="timeline-undated-milestone" className="list-none border-l-4 pl-3" style={{ borderLeftColor: hue(plan, x.code).line }}>
          <span className="flex items-center gap-2">
            <MTag plan={plan} code={x.code} small /> <b className="text-[15px] leading-5 font-bold">{x.name}</b>
          </span>
          {x.targets.length > 0 && (
            <p className="mt-1 text-[13px] leading-[18px] text-text2">
              <b className="font-semibold">Targets:</b> {x.targets.map((t) => t.target).join(" · ")}
            </p>
          )}
          {x.decisions.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1" aria-label={`Decisions ${x.code} needs`}>
              {x.decisions.map((d) => (
                <DecisionLine key={d.code} d={d} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function TimelineCard({ plan, today, pick, onPick, onShow, onPlan }: { plan: Plan; today: string; pick: string | null; onPick: (c: string) => void; onShow: (c: string) => void; onPlan: (p: Plan) => void }) {
  const lanes = lanesOf(plan);
  const anyDated = plan.milestones.some(dated);
  const undatedDecisions = plan.milestones.filter(dated).reduce((n, x) => n + x.decisions.filter((d) => !d.due_on).length, 0);
  return (
    <section aria-label="Timeline" className={`${PAPER} flex flex-col gap-4 px-7 py-6`}>
      {plan.summary.length > 0 && (
        <ul data-testid="timeline-summary" className="-mt-1.5">
          {plan.summary.map((line) => (
            <li key={line} className="relative mt-1.5 list-none pl-5 text-[17px] leading-[26px] before:absolute before:top-[11px] before:left-1 before:h-1.5 before:w-1.5 before:rounded-full before:bg-text-faint">
              <Bolded text={line} />
            </li>
          ))}
        </ul>
      )}
      <h3 className={SEC_H}>When</h3>
      {anyDated && <Strip plan={plan} lanes={lanes} today={today} onPick={onShow} />}
      {plan.milestones.some((x) => !dated(x)) && <NoDates plan={plan} onPlan={onPlan} />}
      <UndatedList plan={plan} />
      {!anyDated && <GoalList plan={plan} />}
      {anyDated && undatedDecisions > 0 && (
        <p className="-mt-2 text-[14px] leading-5 text-text-faint">
          {undatedDecisions} more {undatedDecisions === 1 ? "decision has" : "decisions have"} no date yet; {undatedDecisions === 1 ? "it is" : "they are"} listed under {undatedDecisions === 1 ? "its" : "their"} milestone.
        </p>
      )}
      <h3 className={`${SEC_H} mt-1.5`}>Milestones: done when</h3>
      <div role="group" aria-label="Milestones" className="grid gap-6" style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, plan.milestones.length))}, minmax(0, 1fr))` }}>
        {plan.milestones.map((x) => {
          const on = pick === x.code;
          return (
            <button key={x.code} type="button" aria-pressed={on} onClick={() => onPick(x.code)} className="flex items-center gap-2.5 rounded-[8px] text-left text-[18px] leading-6 font-[650]">
              <span
                className="inline-grid h-[26px] min-w-9 flex-none place-items-center rounded-[8px] px-[7px] font-mono text-[14px] leading-none font-bold"
                style={{ background: hue(plan, x.code).line, color: "var(--simple-paper)", boxShadow: on ? `0 0 0 3px var(--simple-paper), 0 0 0 5px ${hue(plan, x.code).line}` : undefined }}
              >
                {x.code}
              </span>{" "}
              <span>{x.name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the When strip (B1)

const LABEL_W = 300;
const AX_H = 22;
const FLAG_H = 22;
const SH = 22;
const SG = 4;
const DIA_LEVEL = 40;

function Strip({ plan, lanes, today, onPick }: { plan: Plan; lanes: Lane[]; today: string; onPick: (c: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w0, setW0] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setW0(el.getBoundingClientRect().width);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = Math.max(0, w0 - LABEL_W);
  const ds = plan.milestones.filter(dated);
  const allDecisions = datedDecisions(plan);
  // The axis: every dated milestone, today and every decision's due day, two days either side.
  const first = Math.min(...ds.map((x) => ms(x.start_date!)), ms(today), ...allDecisions.map((d) => ms(d.day)));
  const last = Math.max(...ds.map((x) => ms(x.end_date!)), ms(today), ...allDecisions.map((d) => ms(d.day)));
  const T0 = first - 2 * DAY;
  const T1 = last + 3 * DAY;
  const X = (day: string) => ((ms(day) - T0) / (T1 - T0)) * W;
  const XE = (day: string) => ((ms(day) + DAY - T0) / (T1 - T0)) * W;
  const XT = X(today) + ((0.5 * DAY) / (T1 - T0)) * W;
  const months: { label: string; x: number; at: number }[] = [];
  for (let d = new Date(T0); d.getTime() < T1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const at = Math.max(T0, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    months.push({ label: calendarDay(new Date(at).toISOString().slice(0, 10), { month: "short" }), x: ((at - T0) / (T1 - T0)) * W, at });
  }
  // The first month's label gives way when the next one starts within a label's width; a
  // label the Today pill would cover moves just past the pill.
  const pill = { from: Math.max(XT, 26) - 25, to: Math.max(XT, 26) + 25 };
  const shown: typeof months = [];
  months.forEach((m, i) => {
    // A clear gap either side of the pill, so a month's name never touches it.
    const x = m.x + 40 > pill.from && m.x < pill.to + 4 ? pill.to + 4 : m.x;
    const next = months[i + 1];
    if ((next && next.x - x < 34) || x + 30 > W) return;
    shown.push({ ...m, x });
  });
  const decisions = allDecisions;
  // Decision labels: one level unless they would overlap, then the next.
  const levels: [number, number][][] = [];
  const placed = decisions.map((d) => {
    const x = X(d.day) + ((0.5 * DAY) / (T1 - T0)) * W;
    const due = dueWords(plan, d.day, today);
    // Its drawn width: the diamond, the gap, the words' padding and the longer line.
    const w = 23 + Math.max(textWidth(d.label, 13, 700), textWidth(due.words, 13, 400));
    // The first level where its words fit, after the diamond, else (D1's Q4 · Q8) before it.
    const free = (lv: number, a: number, b: number) => (levels[lv] ?? []).every(([p, q]) => b + 6 < p || a > q + 6);
    let lvl = 0;
    let right = false;
    for (; lvl < 8; lvl++) {
      if ((x + w <= W || x - w < 0) && free(lvl, x - 6, x - 6 + w)) break;
      if (x - w >= 0 && free(lvl, x + 6 - w, x + 6)) {
        right = true;
        break;
      }
    }
    (levels[lvl] ??= []).push(right ? [x + 6 - w, x + 6] : [x - 6, x - 6 + w]);
    return { ...d, x, due, right, lvl };
  });
  const decH = decisions.length ? 6 + Math.max(1, levels.length) * DIA_LEVEL : 0;
  const holidays = plan.holidays.filter((h) => ms(h.end) + DAY > T0 && ms(h.start) < T1);
  const holidayWords = holidays.map((h) => `${dm(h.start)} – ${dm(h.end)}`).join(", ");
  const rows = lanes.map((l) => Math.max(1, ...l.pieces.map((p) => p.row + 1)));
  // Every cell has its place (the overlay shares the right column's cells).
  const at = (row: number, col: 1 | 2) => ({ gridRow: row, gridColumn: col });
  const lastRow = 2 + lanes.length + (decisions.length ? 1 : 0);
  return (
    <div ref={box} data-testid="timeline-strip" className="relative">
      {w0 > 0 && (
        <div className="grid" style={{ gridTemplateColumns: `${LABEL_W}px ${W}px`, gridTemplateRows: `${AX_H}px ${FLAG_H}px repeat(${lastRow - 2}, auto)` }}>
          {/* The month row: months and the Today pill. */}
          <div data-testid="timeline-axis" className="relative text-[13px] leading-[22px] font-[650] text-text-faint" style={at(1, 2)}>
            {shown.map((x) => (
              <span key={x.at} data-testid="timeline-month" className="absolute top-0 z-[2] pr-1 pl-1.5" style={{ left: x.x, background: "linear-gradient(to right, transparent 3px, var(--simple-paper) 3px)" }}>
                {x.label}
              </span>
            ))}
            <span className="absolute top-0.5 z-[7] h-[18px] -translate-x-1/2 rounded-[9px] bg-crit px-[7px] text-[11.5px] leading-[18px] font-[750] whitespace-nowrap text-[var(--simple-paper)]" style={{ left: Math.max(XT, 26) }}>
              Today
            </span>
          </div>
          {/* The flags row: each milestone's end. */}
          <div className="relative" style={at(2, 2)}>
            {ds.map((x) => {
              const words = `${x.code} ends ${dm(x.end_date!)}`;
              const at = XE(x.end_date!);
              const flip = at - (textWidth(words, 12.5, 700) + 31) < 0;
              // Off the dashed end line by a few px, on a halo of the card's paper.
              return (
                <button
                  key={x.code}
                  type="button"
                  onClick={() => onPick(x.code)}
                  className={`absolute top-0 z-[5] flex items-center gap-1 rounded-[5px] bg-[var(--simple-paper)] px-1 text-[12.5px] leading-5 font-bold whitespace-nowrap ${flip ? "" : "-translate-x-full"}`}
                  style={{ left: flip ? at + 4 : at - 5, color: hue(plan, x.code).line, boxShadow: "0 0 0 2px var(--simple-paper)" }}
                >
                  {FLAG}
                  {words}
                </button>
              );
            })}
          </div>
          {lanes.map((l, i) => {
            const barsH = rows[i] * SH + (rows[i] - 1) * SG + 10;
            return (
              <div key={l.name} data-testid="timeline-lane" className="contents">
                <div data-testid={l.goal ? "timeline-goal" : undefined} className="flex flex-col justify-center border-t border-[var(--simple-rule)] py-1 pr-2.5 pl-4" style={at(3 + i, 1)}>
                  <span className="flex items-baseline gap-2">
                    <b className="text-[15px] leading-5 font-bold whitespace-nowrap">{l.name}</b>
                    {l.goal && <small className={`text-[13px] leading-[17px] ${l.goal.on_track === false ? "font-[650] text-crit" : "text-text-faint"}`}>{measuredWords(l.goal)}</small>}
                  </span>
                  {l.goal && <small className="text-[13px] leading-[17px] text-text2">{targetSteps(l.goal)}</small>}
                </div>
                <div className="relative z-[2] border-t border-[var(--simple-rule)]" style={{ minHeight: barsH, ...at(3 + i, 2) }}>
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2" style={{ height: barsH }}>
                    {l.pieces.map((p) => {
                      const c = hue(plan, p.milestone);
                      const x0 = X(p.start);
                      const room = Math.max(XE(p.end) - x0, textWidth(p.slices[0].code, 12, 650) + 22);
                      const mile = plan.milestones.find((x) => x.code === p.milestone);
                      return (
                        <button
                          key={`${p.milestone}-${p.start}`}
                          type="button"
                          data-testid="timeline-bar"
                          data-milestone={p.milestone}
                          data-row={p.row}
                          data-pm={p.pm ? "true" : undefined}
                          aria-label={`${p.slices.map(named).join(", ")} (${p.milestone} ${mile?.name ?? ""})`}
                          title={p.slices.map(named).join("\n")}
                          onClick={() => onPick(p.milestone)}
                          className={`absolute z-[2] flex items-center overflow-hidden rounded-full px-[9px] text-[12px] leading-none font-[650] whitespace-nowrap ${p.pm ? "border-[1.5px] border-dashed bg-[var(--simple-paper)] text-text2" : "border-[1.5px] border-solid"}`}
                          style={{
                            left: x0,
                            width: room,
                            top: 5 + p.row * (SH + SG),
                            height: SH,
                            ...(p.pm ? { borderColor: "var(--prd-pm)" } : { background: c.bg, borderColor: c.line, color: c.line }),
                          }}
                        >
                          {/* Names, not only codes; what does not fit ends in "…" (the whole list on hover). */}
                          <span className="min-w-0 truncate">{fits(barVariants(p), room - 20)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {decisions.length > 0 && (
            <div data-testid="timeline-decisions" className="contents">
              <div className="flex flex-col justify-center border-t border-[var(--simple-rule)] py-1 pr-2.5 pl-4" style={at(lastRow, 1)}>
                <b className="text-[15px] leading-5 font-bold">Decisions</b>
                <small className="text-[12.5px] leading-4 text-text-faint">with a date</small>
              </div>
              <div className="relative border-t border-[var(--simple-rule)]" style={{ height: decH, ...at(lastRow, 2) }}>
                {placed.map((d) => (
                  <div
                    key={d.day}
                    data-testid="timeline-decision"
                    className={`absolute z-[3] flex items-start gap-1.5 text-[13px] leading-[17px] whitespace-nowrap ${d.right ? "-translate-x-full flex-row-reverse text-right" : ""}`}
                    style={{ left: d.right ? d.x + 6 : d.x - 6, top: 6 + d.lvl * DIA_LEVEL }}
                  >
                    <i aria-hidden className="mt-[3px] h-[11px] w-[11px] flex-none rotate-45 rounded-[2px]" style={{ background: d.due.late ? "var(--crit)" : "var(--warn)" }} />
                    <span className="rounded-[4px] bg-[var(--simple-paper)] px-[3px]" style={{ boxShadow: "0 0 0 3px var(--simple-paper)" }}>
                      <b className="font-bold">{d.label}</b>
                      <small className={`block text-[13px] ${d.due.late ? "font-[650] text-crit" : "text-text-faint"}`}>{d.due.words}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* What runs across every row: the month lines, the no-work weeks, today and each milestone's end. */}
          <div aria-hidden className="pointer-events-none relative" style={{ gridColumn: 2, gridRow: `1 / ${lastRow + 1}` }}>
            {months.slice(1).map((x) => (
              <i key={x.at} className="absolute bottom-0 w-0 border-l border-line" style={{ left: x.x, top: AX_H }} />
            ))}
            {holidays.map((h) => (
              <i
                key={h.start}
                data-testid="timeline-no-work"
                title={h.label ? `No work: ${h.label}` : "No work"}
                className="absolute bottom-0 opacity-30"
                style={{ left: X(h.start), width: XE(h.end) - X(h.start), top: AX_H, background: "repeating-linear-gradient(135deg, var(--line-strong) 0 1.5px, transparent 1.5px 7px)" }}
              />
            ))}
            <i className="absolute bottom-0 z-[1] w-0 border-l-2 border-crit" style={{ left: XT - 1, top: AX_H - 2 }} />
            {ds.map((x) => (
              <i key={x.code} className="absolute bottom-0 z-[1] w-0 border-l-[1.5px] border-dashed" style={{ left: XE(x.end_date!) - 1, top: AX_H + 4, borderColor: hue(plan, x.code).line }} />
            ))}
          </div>
        </div>
      )}
      <div data-testid="timeline-legend" className="flex flex-wrap gap-x-4 gap-y-1.5 pt-2 text-[13px] leading-[18px] text-text-faint">
        {ds.map((x) => (
          <span key={x.code} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[5px] border-[1.5px]" style={{ background: hue(plan, x.code).bg, borderColor: hue(plan, x.code).line }} />
            {x.code}
          </span>
        ))}
        {lanes.some((l) => l.name === PM_LANE) && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[5px] border-[1.5px] border-dashed" style={{ borderColor: "var(--prd-pm)" }} />
            Product manager&apos;s work, no engineering
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <i aria-hidden className="inline-block h-3.5 w-0.5 flex-none bg-crit" />
          Today {dm(today)}
        </span>
        {holidays.length > 0 && (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i aria-hidden className="inline-block h-2.5 w-[18px] flex-none rounded-[2px] opacity-60" style={{ background: "repeating-linear-gradient(135deg, var(--line-strong) 0 1.5px, transparent 1.5px 7px)" }} />
            Holidays {holidayWords}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden className="flex-none fill-text-faint">
            <path d="M2 1h1.4v10H2zM3.4 1.5h7l-1.8 2.6 1.8 2.6h-7z" />
          </svg>
          milestone end
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the phone (D2)

function PhonePlan({ plan, title, today, pick, onPick, onPlan, m }: { plan: Plan; title: string; today: string; pick: string | null; onPick: (c: string) => void; onPlan: (p: Plan) => void; m: Milestone | null }) {
  // D2: past the PRD's header a bar keeps its title and where the reader is.
  const top = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<string | null>(null);
  useEffect(() => {
    const on = () => {
      const head = document.querySelector('[data-testid="phone-header"]')?.getBoundingClientRect().bottom ?? 0;
      // Past the header: where the plan starts has gone under the bar's own place.
      const past = (top.current?.getBoundingClientRect().top ?? Infinity) < head + 40;
      const inCard = (card.current?.getBoundingClientRect().top ?? Infinity) < head + 60;
      setBar(past ? (inCard && m ? `${m.code} · ${m.name}` : "Timeline") : null);
    };
    on();
    window.addEventListener("scroll", on, { passive: true, capture: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, { capture: true });
      window.removeEventListener("resize", on);
    };
  }, [m]);
  const events: { day: string; order: number; node: ReactNode }[] = [];
  const undated: ReactNode[] = [];
  for (const x of plan.milestones) {
    const node = (
      <PhoneMilestone
        key={x.code}
        plan={plan}
        m={x}
        today={today}
        open={pick === x.code}
        onPick={onPick}
        onShow={(c) => {
          onPick(c);
          showPart();
        }}
      />
    );
    if (x.start_date) events.push({ day: x.start_date, order: 2, node });
    else undated.push(node);
  }
  for (const d of datedDecisions(plan)) {
    const due = dueWords(plan, d.day, today, false);
    events.push({
      day: d.day,
      order: 0,
      node: (
        <div key={`d-${d.day}`} data-testid="timeline-decision" className="relative">
          <span className="absolute top-0.5 -left-16 w-[46px] text-right text-[12px] leading-[15px] font-bold text-text2">{dm(d.day)}</span>
          <span aria-hidden className="absolute top-[5px] -left-4 h-2.5 w-2.5 rotate-45 rounded-[2px]" style={{ background: due.late ? "var(--crit)" : "var(--warn)" }} />
          <div className="text-[14px] leading-[19px]">
            <b className="font-bold">{d.label}</b>
            {due.words && <small className={`block text-[13px] ${due.late ? "font-[650] text-crit" : "text-text-faint"}`}>{due.words}</small>}
          </div>
        </div>
      ),
    });
  }
  events.push({
    day: today,
    order: 1,
    node: (
      <div key="today" className="relative">
        <span className="absolute top-0.5 -left-16 w-[46px] text-right text-[12px] leading-[15px] font-bold text-crit">{dm(today)}</span>
        <span aria-hidden className="absolute top-[5px] -left-[17px] h-3 w-3 rounded-full border-2 border-[var(--simple-paper)] bg-crit" />
        <div className="text-[13px] leading-[19px] font-[750] text-crit">Today</div>
      </div>
    ),
  });
  events.sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order);
  return (
    <>
      <div ref={top} />
      {bar && (
        <div data-testid="timeline-stick" className="fixed inset-x-0 top-0 z-20 flex items-center gap-2 border-b border-[var(--simple-rule)] bg-[var(--simple-paper)] px-4 py-[9px] text-[15px] font-[650] max-[600px]:top-[var(--phone-top-bar)]">
          <span className="min-w-0 truncate">{title}</span>
          <span className="ml-auto flex-none text-[14px] leading-5 text-text-faint">{bar}</span>
        </div>
      )}
      <GoalList plan={plan} />
      <section aria-label="Timeline" data-testid="timeline-vertical" className="relative flex flex-col gap-3 pl-16">
        <span aria-hidden className="absolute top-1.5 bottom-0 left-[52px] border-l-2 border-[var(--simple-rule)]" />
        {events.map((e) => e.node)}
        {undated}
        {plan.milestones.some((x) => !dated(x)) && <NoDates plan={plan} onPlan={onPlan} />}
      </section>
      <div ref={card}>{m && <MilestoneCard plan={plan} m={m} today={today} phone />}</div>
    </>
  );
}

/** A milestone in the vertical timeline: a compact summary (its part follows the timeline in full). */
function PhoneMilestone({ plan, m, today, open, onPick, onShow }: { plan: Plan; m: Milestone; today: string; open: boolean; onPick: (c: string) => void; onShow: (c: string) => void }) {
  const c = hue(plan, m.code);
  const st = stateOf(plan, m, today);
  const slices = plan.slices.filter((s) => s.milestone === m.code);
  const flows = slices.filter((s) => s.flow_steps.length).length;
  const facts = dated(m) ? [`to ${dm(m.end_date!)}`, weeksWords(plan, m), ...(m.effort_weeks != null ? [ew(m.effort_weeks)] : [])].join(" · ") : "No dates yet";
  return (
    <div data-testid="timeline-step" className="relative">
      <span className="absolute top-0.5 -left-16 w-[46px] text-right text-[12px] leading-[15px] font-bold text-text2">{m.start_date ? dm(m.start_date) : ""}</span>
      <span aria-hidden className="absolute top-[5px] -left-[17px] h-3 w-3 rounded-full border-2 border-[var(--simple-paper)]" style={{ background: c.line }} />
      <div className="flex flex-col gap-2 rounded-[12px] border border-l-4 border-[var(--simple-rule)] bg-[var(--simple-paper)] px-3 py-2.5" style={{ borderLeftColor: c.line }}>
        <button type="button" aria-expanded={open} onClick={() => onPick(m.code)} className="flex items-center gap-2 text-left">
          <MTag plan={plan} code={m.code} small />{" "}
          <b className="text-[16px] leading-[21px] font-bold">{m.name}</b>
        </button>
        <div className="text-[14px] leading-5 text-text2">
          {facts}
          {open && st.week && (
            <>
              {" · "}
              <b className="font-bold whitespace-nowrap text-accent-ink">{st.week}</b>
            </>
          )}
        </div>
        {!dated(m) && m.decisions.length > 0 && (
          // With no dates, the decisions worded against it stay under it.
          <ul className="flex flex-col gap-1" aria-label={`Decisions ${m.code} needs`}>
            {m.decisions.map((d) => (
              <DecisionLine key={d.code} d={d} />
            ))}
          </ul>
        )}
        <a
          href="#milestone-part"
          onClick={(e) => {
            e.preventDefault();
            onShow(m.code);
          }}
          className="self-start text-[14px] font-semibold whitespace-nowrap text-accent underline underline-offset-[3px]"
        >
          {slices.length} {slices.length === 1 ? "feature" : "features"}, {flows} {flows === 1 ? "flow" : "flows"} · {m.decisions.length} {m.decisions.length === 1 ? "decision" : "decisions"} ›
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the milestone's card (D1)

function Checks({ items, small }: { items: string[]; small?: boolean }) {
  return (
    <ul data-testid="part-done-when">
      {items.map((d) => (
        <li
          key={d}
          className={`relative list-none before:absolute before:left-1 before:h-1.5 before:w-1.5 before:rounded-full before:bg-text-faint ${small ? "mt-[5px] pl-5 text-[15px] leading-[21px] before:top-[8px]" : "mt-1.5 pl-5 text-[16px] leading-[23px] before:top-[9px]"}`}
        >
          {d}
        </li>
      ))}
      {!items.length && <li className="mt-[5px] list-none text-[15px] text-text-faint">Not written yet</li>}
    </ul>
  );
}

const PM_KIND = "Product manager's work, no new engineering";

export function MilestoneCard({ plan, m, today, phone }: { plan: Plan; m: Milestone; today: string; phone: boolean }) {
  const c = hue(plan, m.code);
  const st = stateOf(plan, m, today);
  const slices = plan.slices.filter((s) => s.milestone === m.code);
  const groups: [string, Slice[]][] = [];
  for (const s of slices) {
    const kind = s.pm_owned ? PM_KIND : s.kind || "Other work";
    const g = groups.find(([k]) => k === kind);
    if (g) g[1].push(s);
    else groups.push([kind, [s]]);
  }
  groups.sort(([a], [b]) => Number(a === PM_KIND) - Number(b === PM_KIND));
  const flows = slices.filter((s) => s.flow_steps.length);
  const facts = [dated(m) ? null : "No dates yet", dated(m) ? weeksWords(plan, m) : null, ewWords(m)].filter(Boolean).join(" · ");
  return (
    <section id="milestone-part" aria-label={`${m.code} ${m.name}`} data-testid="milestone-part" className={`${PAPER} flex scroll-mt-28 flex-col gap-[18px] border-t-[5px] ${phone ? "px-4 py-5" : "px-7 py-6"}`} style={{ borderTopColor: c.line }}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className={`flex items-center gap-3 font-bold tracking-[-.01em] ${phone ? "text-[22px] leading-7" : "text-[26px] leading-8"}`}>
          <MTag plan={plan} code={m.code} /> <span>{m.name}</span>
        </h2>
        <span className={`inline-flex h-6 items-center rounded-xl px-[9px] text-[13px] leading-[18px] font-semibold whitespace-nowrap ${st.now ? "bg-accent-soft text-accent-ink" : "bg-na-bg text-na"}`}>{st.words}</span>
      </div>
      <p className="-mt-1 text-[15px] leading-[22px] text-text2" data-testid="part-dates">
        {dated(m) && <b className="font-bold text-text">{spanWords(m.start_date!, m.end_date!)}</b>}
        {dated(m) && facts ? " · " : ""}
        {facts}
      </p>
      {m.why && (
        <p data-testid="part-why" className="flex items-baseline gap-3 text-[17px] leading-[26px]">
          <span className="w-[72px] flex-none text-[12px] leading-[18px] font-[750] tracking-[.07em] text-text-faint uppercase">Why now</span>
          <span>{m.why}</span>
        </p>
      )}
      <div className={`grid gap-7 ${phone ? "grid-cols-1" : "grid-cols-[300px_minmax(0,1fr)]"}`}>
        <div className="flex flex-col gap-3.5">
          <div>
            <h3 className={H3}>Done when</h3>
            <Checks items={m.done_when} small />
          </div>
          <div>
            <h3 className={H3}>Targets</h3>
            <div data-testid="part-targets" className="mt-2 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
              {m.targets.map((t) => {
                const [v, u] = splitTarget(t.target);
                return (
                  <div key={t.goal} title={t.goal} className="rounded-[12px] border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-3 py-2.5">
                    <div className="text-[28px] leading-[34px] font-[750] tracking-[-.01em]">{v}</div>
                    <div className="text-[14px] leading-[19px] text-text2">{u}</div>
                  </div>
                );
              })}
              {!m.targets.length && <p className="text-[15px] text-text-faint">No targets yet</p>}
            </div>
          </div>
        </div>
        <div data-testid="part-builds">
          <h3 className={`${H3} mb-2`}>
            What we build <span className="text-[16px] font-medium text-text-faint">· {slices.length} {slices.length === 1 ? "feature" : "features"}, by kind</span>
          </h3>
          <div className="flex flex-col gap-3.5">
            {groups.map(([kind, of]) => (
              <div key={kind}>
                <h4 className="mb-1 flex items-center gap-2 text-[12px] leading-4 font-[750] tracking-[.07em] text-text-faint uppercase">
                  {kind} <span className="font-semibold">· {of.length}</span>
                </h4>
                <ul>
                  {of.map((s) => (
                    <li key={s.code} className={`grid list-none gap-x-2.5 border-t border-[var(--simple-rule)] py-1.5 text-[15px] leading-[21px] ${phone ? "grid-cols-[62px_minmax(0,1fr)] gap-y-0.5" : "grid-cols-[62px_250px_minmax(0,1fr)] gap-y-2.5"}`}>
                      <span className={`${CODE} border border-line bg-surface2 text-text`}>{s.code}</span>
                      <b className="font-[650]">
                        {s.name}
                        {s.flow_steps.length > 0 && (
                          <span className="text-[13px] font-[650] whitespace-nowrap">
                            {" · "}
                            <button
                              type="button"
                              onClick={() => document.getElementById(`flow-${s.code}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                              className="text-accent underline underline-offset-[3px]"
                            >
                              flow below
                            </button>
                          </span>
                        )}
                      </b>
                      <span className={`text-text2 ${phone ? "col-start-2" : ""}`}>{s.what ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!groups.length && <p className="text-[15px] text-text-faint">Nothing planned in it yet</p>}
          </div>
        </div>
      </div>
      {flows.length > 0 && (
        <>
          <h3 className={H3}>Flows in {m.code}</h3>
          {flows.map((s) => (
            <div key={s.code} id={`flow-${s.code}`} data-testid="part-flow" className="scroll-mt-28 rounded-[12px] border border-dashed border-line-strong bg-[var(--simple-paper)] px-3.5 pt-2.5 pb-3">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px] leading-[18px] font-[650] text-text2">
                <FlowIcon />
                Flow · {s.code} {s.name}
                <span className="ml-auto flex gap-3 font-medium text-text-faint">
                  <span className="inline-flex items-center gap-1">
                    <i aria-hidden className="inline-block h-2.5 w-3 rounded-[3px] border-[1.2px] border-line-strong bg-surface" />a step
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <i aria-hidden className="inline-block h-2.5 w-2.5 scale-[.8] rotate-45 border-[1.2px] border-line-strong bg-surface2" />a check
                  </span>
                </span>
              </div>
              <div className="max-w-[880px]">
                <FlowDiagram flow={{ steps: s.flow_steps }} layout="across" />
              </div>
            </div>
          ))}
        </>
      )}
      <div className={`grid gap-6 ${phone ? "grid-cols-1" : "grid-cols-2"}`}>
        <div data-testid="part-decisions">
          <h3 className={H3}>
            Decisions it needs <span className="text-[16px] font-medium text-text-faint">· {m.decisions.length}</span>
          </h3>
          <ul>
            {m.decisions.map((d) => {
              const when = decisionWhen(plan, m, d, today);
              return (
                <li key={d.code} className="grid list-none items-start gap-x-2.5 gap-y-1 border-t border-[var(--simple-rule)] py-2.5 first:border-t-0" style={{ gridTemplateColumns: phone ? "44px minmax(0,1fr)" : "44px minmax(0,1fr) auto" }}>
                  <span className={`${CODE} bg-warn-bg text-warn`}>{d.code}</span>
                  <div>
                    <b className="text-[16px] leading-[22px] font-[650]">{d.title}</b>
                    {d.recommendation && (
                      <div className="mt-0.5 text-[14px] leading-5 text-text2">
                        <em className="font-bold text-text not-italic">Recommended:</em> {d.recommendation}
                      </div>
                    )}
                  </div>
                  <span className={`pt-0.5 text-[13px] leading-[18px] whitespace-nowrap ${phone ? "col-start-2" : "text-right"} ${when.late ? "font-[650] text-warn" : "text-text-faint"}`}>{when.words}</span>
                </li>
              );
            })}
            {!m.decisions.length && <li className="list-none py-2.5 text-[15px] text-text-faint">No open decisions</li>}
          </ul>
        </div>
        <div data-testid="part-risks">
          <h3 className={H3}>
            Risks <span className="text-[16px] font-medium text-text-faint">· {m.risks.length}</span>
          </h3>
          <ul>
            {m.risks.map((r) => (
              <li key={r.title} className="grid list-none items-start gap-x-2.5 gap-y-1 border-t border-[var(--simple-rule)] py-2.5 first:border-t-0" style={{ gridTemplateColumns: phone ? "44px minmax(0,1fr)" : "44px minmax(0,1fr) auto" }}>
                {r.code ? <span className={`${CODE} bg-crit-bg text-crit`}>{r.code}</span> : <span />}
                <div>
                  <b className="text-[16px] leading-[22px] font-[650]">{r.title}</b>
                  {r.what_we_do && (
                    <div className="mt-0.5 text-[14px] leading-5 text-text2">
                      <em className="font-bold text-text not-italic">What we do:</em> {r.what_we_do}
                    </div>
                  )}
                </div>
                {riskLevel(r) && <span className={`pt-0.5 text-[13px] leading-[18px] whitespace-nowrap text-text-faint ${phone ? "col-start-2" : "text-right"}`}>{riskLevel(r)}</span>}
              </li>
            ))}
            {!m.risks.length && <li className="list-none py-2.5 text-[15px] text-text-faint">No risks written yet</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** A decision's "when" in the milestone's list, worded as the timeline words it ("was due 20 Oct", "at the M1 review, 27 Nov", "before M2 starts, 30 Nov", "due 5 Nov"), or "during M3" when it has no day. */
function decisionWhen(plan: Plan, m: Milestone, d: Decision, today: string): { words: string; late: boolean } {
  if (!d.due_on) return { words: `during ${m.code}`, late: false };
  return dueWords(plan, d.due_on, today);
}

const level = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1);

/** "Likelihood: Medium · Impact: High". */
function riskLevel(r: Risk): string | null {
  return [r.likelihood && `Likelihood: ${level(r.likelihood)}`, r.impact && `Impact: ${level(r.impact)}`].filter(Boolean).join(" · ") || null;
}

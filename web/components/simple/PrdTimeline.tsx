"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ds";
import { FlowMini } from "@/components/simple/FlowVisual";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, todayIn, useCompanyZone } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

type Plan = Schemas["SimplePlanOut"];
type Milestone = Schemas["SimplePlanMilestone"];
type Slice = Schemas["SimpleSlice"];
type Goal = Schemas["SimplePlanGoal"];

const DAY = 86_400_000;
const PM_LANE = "PM-owned · no engineering";
const ms = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** "27 Nov". */
const dm = (day: string) => calendarDay(day, { day: "numeric", month: "short" }, "en-GB");

const PHONE = "(max-width: 767px)";
function subscribePhone(on: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", on);
  return () => mq.removeEventListener("change", on);
}
const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);

/** A milestone's colour (M1 blue, M2 violet, M3 amber, then round again), as --simple-mN tokens. */
function tone(plan: Plan, code: string) {
  const n = (Math.max(0, plan.milestones.findIndex((m) => m.code === code)) % 3) + 1;
  return { fill: `var(--simple-m${n})`, edge: `var(--simple-m${n}-edge)`, ink: `var(--simple-m${n}-ink)` };
}

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
  // Pieces that run at the same time (or back to back, less than a week apart, where their
  // bars would touch and read as one) stack into the next row.
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

/** The lanes: one per goal (the plan's order), then the PM-owned lane. */
function lanesOf(plan: Plan): { name: string; goal: Goal | null; pieces: Piece[] }[] {
  const names = [...plan.goals.map((g) => g.name)];
  for (const s of plan.slices) if (!s.pm_owned && s.goal && !names.includes(s.goal)) names.push(s.goal);
  const lanes: { name: string; goal: Goal | null; pieces: Piece[] }[] = names.map((n) => ({
    name: n,
    goal: plan.goals.find((g) => g.name === n) ?? null,
    pieces: piecesOf(plan.slices.filter((s) => !s.pm_owned && s.goal === n)),
  }));
  const loose = plan.slices.filter((s) => !s.pm_owned && !s.goal);
  if (loose.length) lanes.push({ name: "No goal named", goal: null, pieces: piecesOf(loose) });
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

function measuredWords(goal: Goal | null): string {
  if (!goal?.measured) return "Not counted yet";
  return `Now ${goal.measured}${goal.on_track == null ? "" : goal.on_track ? " · on track" : " · behind"}`;
}

/** The milestone running today, else the next to start, else the last. */
function currentOf(plan: Plan, today: string): string | null {
  const dated = plan.milestones.filter((m) => m.start_date && m.end_date);
  return (
    dated.find((m) => m.start_date! <= today && today <= m.end_date!)?.code ??
    dated.find((m) => m.start_date! > today)?.code ??
    plan.milestones[plan.milestones.length - 1]?.code ??
    null
  );
}

const named = (s: Slice) => `${s.code} ${s.name}`;
const codesOf = (p: Piece) => p.slices.map((s) => s.code);

/** The bar's label fitted to its width: as many codes as fit, then "+N" for the rest. */
export function fitCodes(codes: string[], px: number): string {
  const CH = 7.8;
  for (let k = codes.length; k >= 1; k--) {
    const text = codes.slice(0, k).join(" · ") + (k < codes.length ? ` +${codes.length - k}` : "");
    if (text.length * CH + 20 <= px) return text;
  }
  return codes.length > 1 ? `${codes[0]} +${codes.length - 1}` : codes[0] ?? "";
}

/**
 * prd-timeline (the owner's picks D "Timeline first" and B "Goal lanes", 2026-10-28): the
 * PRD's dated plan as a timeline, one lane per goal and a PM-owned lane, the milestone chips
 * above it and the picked milestone's part below it. A phone reads it down the page.
 */
export function PrdTimeline({ plan, onPlan }: { plan: Plan; onPlan: (p: Plan) => void }) {
  const phone = usePhone();
  const zone = useCompanyZone();
  // Today in the company's time zone.
  const [today] = useState(() => todayIn(zone));
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAgain, setReadAgain] = useState(false);
  const pick = picked ?? currentOf(plan, today);
  const m = plan.milestones.find((x) => x.code === pick) ?? null;

  async function again() {
    setBusy(true);
    setError(null);
    try {
      const next = await unwrap(api.POST("/v1/simple/prds/{prd}/plan/read-again", { params: { path: { prd: plan.prd.slug } } }));
      onPlan(next);
      setReadAgain(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!plan.dated || !plan.span) {
    return (
      <section aria-label="Timeline" className="rounded-md border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-6 py-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Timeline</h2>
        <p className="mt-2">The milestones have no dates yet{plan.milestones.length ? `: ${plan.milestones.map((x) => `${x.code} ${x.name}`).join(", ")}.` : "."}</p>
        {plan.can_read_again && (
          <div className="simple-noprint mt-3 flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={() => void again()}>Read the plan again</Button>
            {readAgain && <span role="status" className="text-base text-text-faint">Read again: the PRD still gives no dates.</span>}
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </section>
    );
  }

  const lanes = lanesOf(plan);
  return (
    <section aria-label="Timeline" className="rounded-md border border-[var(--simple-rule)] bg-[var(--simple-paper)] px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Timeline · {plan.span.label}</h2>
        {plan.slices.some((s) => s.estimated) && <p className="text-sm text-text-faint">Milestone dates from the PRD · work inside them placed by Oracle (estimated)</p>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Milestones">
        {plan.milestones.map((x) => {
          const c = tone(plan, x.code);
          return (
            <button
              key={x.code}
              type="button"
              aria-pressed={pick === x.code}
              onClick={() => setPicked(x.code)}
              className="rounded-full border-2 px-3 py-1 text-base"
              style={{ background: c.fill, color: c.ink, borderColor: pick === x.code ? c.edge : "transparent" }}
            >
              {x.code} {x.name} · {dm(x.start_date!)} – {dm(x.end_date!)}
            </button>
          );
        })}
      </div>
      {phone ? (
        <>
          <GoalsTracked plan={plan} lanes={lanes} />
          <Vertical plan={plan} lanes={lanes} today={today} onPick={setPicked} />
        </>
      ) : (
        <Lanes plan={plan} lanes={lanes} today={today} onPick={setPicked} />
      )}
      {m && <Part plan={plan} m={m} />}
    </section>
  );
}

function GoalLabel({ name, goal }: { name: string; goal: Goal | null }) {
  return (
    <div data-testid="timeline-goal" className="text-sm leading-snug">
      <p className="text-base font-semibold">{name}</p>
      {goal && <p>{targetSteps(goal)}</p>}
      <p className={goal?.on_track === false ? "font-semibold text-[var(--crit)]" : "text-text-faint"}>{measuredWords(goal)}</p>
    </div>
  );
}

function GoalsTracked({ lanes }: { plan: Plan; lanes: ReturnType<typeof lanesOf> }) {
  return (
    <div className="mt-4 space-y-3 border-t border-[var(--simple-rule)] pt-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Goals tracked</h3>
      {lanes.filter((l) => l.goal).map((l) => <GoalLabel key={l.name} name={l.name} goal={l.goal} />)}
    </div>
  );
}

const ROW = 40;
const LABEL = 260;

function Lanes({ plan, lanes, today, onPick }: { plan: Plan; lanes: ReturnType<typeof lanesOf>; today: string; onPick: (code: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const on = () => setWidth(el.getBoundingClientRect().width);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const span = plan.span!;
  // The axis: from the Monday of the first week (today's when it comes first) to the last week's end.
  const first = Math.min(ms(span.start), ms(today));
  const from = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY;
  const last = Math.max(ms(span.end), ms(today));
  const to = last + (7 - ((new Date(last).getUTCDay() + 6) % 7)) * DAY;
  const pct = (day: string, endOfDay = false) => ((ms(day) + (endOfDay ? DAY : 0) - from) / (to - from)) * 100;
  const weeks: string[] = [];
  for (let t = from; t < to; t += 7 * DAY) weeks.push(iso(t));
  const months: { label: string; at: number }[] = [];
  for (let d = new Date(from); d.getTime() < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const at = Math.max(from, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    months.push({ label: calendarDay(iso(at), { month: "short" }, "en-GB"), at: ((at - from) / (to - from)) * 100 });
  }
  const dated = plan.milestones.filter((x) => x.end_date);
  return (
    <div className="mt-4">
      <GoalsHeading />
      <div className="flex">
        <div style={{ width: LABEL }} className="flex-none" />
        <div ref={track} data-testid="timeline-axis" className="relative h-16 flex-1 border-b border-[var(--simple-rule)]">
          {dated.map((x) => {
            const c = tone(plan, x.code);
            return (
              <button
                key={x.code}
                type="button"
                onClick={() => onPick(x.code)}
                className="absolute top-0 -translate-x-full whitespace-nowrap rounded-l-md border-r-2 px-2 py-0.5 text-sm font-semibold"
                style={{ left: `${pct(x.end_date!, true)}%`, background: c.fill, color: c.ink, borderColor: c.edge }}
              >
                {x.code} ends {dm(x.end_date!)}
              </button>
            );
          })}
          <span className="absolute top-8 z-10 -translate-x-1/2 rounded-full bg-accent px-2 text-xs font-semibold text-on-accent" style={{ left: `${pct(today)}%` }}>Today</span>
          {months.map((x) => (
            <span key={x.at} data-testid="timeline-month" className="absolute bottom-0 border-l border-[var(--simple-rule)] pl-1 text-sm text-text-faint" style={{ left: `${x.at}%` }}>{x.label}</span>
          ))}
          {weeks.map((w) => (
            <span key={w} aria-hidden className="absolute bottom-0 h-1.5 border-l border-[var(--simple-rule)]" style={{ left: `${pct(w)}%` }} />
          ))}
        </div>
      </div>
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LABEL }}>
          {plan.holidays.map((h) => (
            <span
              key={h.start}
              data-testid="timeline-no-work"
              title={h.label ? `No work: ${h.label}` : "No work"}
              className="absolute inset-y-0"
              style={{ left: `${pct(h.start)}%`, width: `${pct(h.end, true) - pct(h.start)}%`, background: "repeating-linear-gradient(135deg, var(--simple-hatch) 0 4px, transparent 4px 9px)" }}
            />
          ))}
          {dated.map((x) => (
            <span key={x.code} className="absolute inset-y-0 border-l border-dashed" style={{ left: `${pct(x.end_date!, true)}%`, borderColor: tone(plan, x.code).edge }} />
          ))}
          <span className="absolute inset-y-0 border-l-2 border-accent" style={{ left: `${pct(today)}%` }} />
        </div>
        {lanes.map((l) => {
          const rows = Math.max(1, ...l.pieces.map((p) => p.row + 1));
          return (
            <div key={l.name} data-testid="timeline-lane" className="flex border-b border-[var(--simple-rule)]">
              <div style={{ width: LABEL }} className="flex-none py-2 pr-3">
                {l.goal ? <GoalLabel name={l.name} goal={l.goal} /> : <p className="text-base font-semibold">{l.name}</p>}
              </div>
              <div className="relative flex-1" style={{ minHeight: rows * ROW + 12 }}>
                {l.pieces.map((p) => {
                  const c = tone(plan, p.milestone);
                  const left = pct(p.start);
                  const w = pct(p.end, true) - left;
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
                      className={`absolute h-8 whitespace-nowrap rounded-full border px-2.5 text-left text-sm font-semibold ${p.pm ? "border-dashed" : ""}`}
                      style={{ left: `${left}%`, width: `${w}%`, top: 6 + p.row * ROW, background: c.fill, color: c.ink, borderColor: c.edge, borderWidth: p.pm ? 2 : 1 }}
                    >
                      {fitCodes(codesOf(p), (w / 100) * width)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GoalsHeading() {
  return <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Goals tracked</h3>;
}

/** A phone: milestones down the page, each goal's pieces in it as chips. */
function Vertical({ plan, lanes, today, onPick }: { plan: Plan; lanes: ReturnType<typeof lanesOf>; today: string; onPick: (code: string) => void }) {
  const todayAt = plan.milestones.findIndex((x) => x.end_date && x.end_date >= today);
  return (
    <ol data-testid="timeline-vertical" className="mt-4 space-y-3 border-t border-[var(--simple-rule)] pt-3">
      {plan.milestones.map((x, i) => {
        const c = tone(plan, x.code);
        const off = plan.holidays.filter((h) => h.start <= x.end_date! && h.end >= x.start_date!);
        return (
          <li key={x.code} className="list-none">
            {i === todayAt && (
              <p className="mb-2 flex items-center gap-2 text-sm">
                <span className="rounded-full bg-accent px-2 text-xs font-semibold text-on-accent">Today</span>
                <span className="text-text-faint">{dm(today)}</span>
              </p>
            )}
            <div data-testid="timeline-step" className="rounded-md border-l-4 p-3" style={{ borderColor: c.edge, background: c.fill, color: c.ink }}>
              <p className="font-semibold">{x.code} {x.name}</p>
              <p className="text-sm">Starts {dm(x.start_date!)} · ends {dm(x.end_date!)}</p>
              {off.map((h) => (
                <p key={h.start} className="mt-1 rounded px-1 text-sm" style={{ background: "repeating-linear-gradient(135deg, var(--simple-hatch) 0 4px, transparent 4px 9px)" }}>
                  No work {dm(h.start)} – {dm(h.end)}{h.label ? ` (${h.label})` : ""}
                </p>
              ))}
              <div className="mt-2 space-y-2">
                {lanes.map((l) => {
                  const ps = l.pieces.filter((p) => p.milestone === x.code);
                  if (!ps.length) return null;
                  return (
                    <div key={l.name} data-testid="timeline-step-goal">
                      <p className="text-sm font-semibold">{l.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {ps.map((p) => (
                          <button
                            key={p.start}
                            type="button"
                            aria-label={`${p.slices.map(named).join(", ")} (${x.code} ${x.name})`}
                            onClick={() => onPick(x.code)}
                            className={`rounded-full border bg-[var(--simple-paper)] px-2.5 py-0.5 text-sm ${p.pm ? "border-dashed" : ""}`}
                            style={{ borderColor: c.edge, color: c.ink }}
                          >
                            {codesOf(p).join(" · ")}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The picked milestone's part: name and dates, Done when, targets, what it builds by kind, decisions and risks. */
function Part({ plan, m }: { plan: Plan; m: Milestone }) {
  const slices = plan.slices.filter((s) => s.milestone === m.code);
  const groups: [string, Slice[]][] = [];
  for (const s of slices) {
    const kind = s.pm_owned ? "PM-owned" : s.kind || "Other work";
    const g = groups.find(([k]) => k === kind);
    if (g) g[1].push(s);
    else groups.push([kind, [s]]);
  }
  groups.sort(([a], [b]) => Number(a === "PM-owned") - Number(b === "PM-owned"));
  const c = tone(plan, m.code);
  return (
    <div data-testid="milestone-part" className="mt-5 border-t-4 pt-4" style={{ borderColor: c.edge }}>
      <h2 className="text-2xl font-semibold">{m.code} {m.name}</h2>
      <p className="text-base text-text-faint">
        {m.start_date && m.end_date ? `${dm(m.start_date)} – ${dm(m.end_date)}` : "No dates yet"}
        {m.effort_weeks != null ? ` · ${m.planned_weeks} of ${m.effort_weeks} engineer-weeks planned` : ""}
      </p>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Done when</h3>
          <ul data-testid="part-done-when" className="mt-1 space-y-1">
            {m.done_when.map((d) => (
              <li key={d} className="flex list-none items-start gap-2">
                <span aria-hidden className="mt-1.5 inline-block h-4 w-4 flex-none rounded border-2 border-[var(--simple-rule)]" />
                <span>{d}</span>
              </li>
            ))}
            {!m.done_when.length && <li className="list-none text-text-faint">Not written yet</li>}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Targets</h3>
          <ul data-testid="part-targets" className="mt-1 space-y-1">
            {m.targets.map((t) => <li key={t.goal} className="list-none">{t.goal}: {t.target}</li>)}
            {!m.targets.length && <li className="list-none text-text-faint">No targets yet</li>}
          </ul>
        </div>
      </div>
      <div data-testid="part-builds" className="mt-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-text-faint">What it builds</p>
        {groups.map(([kind, of]) => (
          <div key={kind} className="mt-2">
            <h3 className="text-base font-semibold">{kind}</h3>
            <ul className="mt-1 space-y-2">
              {of.map((s) => (
                <li key={s.code} className="flex list-none items-start gap-3">
                  <span data-testid="part-flow" className="flex-none rounded border border-[var(--simple-rule)] bg-[var(--simple-paper)] p-0.5" title={s.flow_steps.length ? s.flow_steps.join(" → ") : "No flow yet"}>
                    {s.flow_steps.length ? <FlowMini flow={{ steps: s.flow_steps }} /> : <span className="block h-10 w-16 px-1 py-2 text-center text-xs text-text-faint">No flow yet</span>}
                  </span>
                  <span>
                    <strong>{named(s)}</strong>
                    {s.what && <span className="block text-base">{s.what}</span>}
                    <span className="block text-sm text-text-faint">
                      {s.pm_owned ? "No engineering" : s.effort_weeks != null ? `${s.effort_weeks} engineer-weeks` : ""}
                      {s.start_date && s.end_date ? `${s.pm_owned || s.effort_weeks != null ? " · " : ""}${dm(s.start_date)} – ${dm(s.end_date)}${s.estimated ? " (estimated)" : ""}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!groups.length && <p className="text-text-faint">Nothing planned in it yet</p>}
      </div>
      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <div data-testid="part-decisions">
          <p className="text-sm font-semibold uppercase tracking-wide text-text-faint">Open decisions</p>
          <ul className="mt-1 space-y-1">
            {m.decisions.map((d) => <li key={d.code} className="list-none">{d.code} {d.title}</li>)}
            {!m.decisions.length && <li className="list-none text-text-faint">No open decisions</li>}
          </ul>
        </div>
        <div data-testid="part-risks">
          <p className="text-sm font-semibold uppercase tracking-wide text-text-faint">Risks</p>
          <ul className="mt-1 space-y-1">
            {m.risks.map((r) => <li key={r} className="list-none">{r}</li>)}
            {!m.risks.length && <li className="list-none text-text-faint">No risks written yet</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

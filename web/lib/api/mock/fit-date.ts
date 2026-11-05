// Bring a date in (Simple, oracle.simple.fit_date_router): one invented PRD's goal milestone that
// misses its target, Oracle's ranked changes, the live date of a picked set, the drafted re-plan and
// its approval. Invented company (Larkspur Help Desk), goals, items and engineers only. Served under
// the "fit-date" mock scenario (and "fit-date-hard": the target is Jan 8, which no set reaches;
// "fit-date-hard-no-goal": the same with no Baseline goal by the goal's name; "fit-date-foreign-draft":
// the roadmap's draft holds someone else's edits, so approving is refused; "fit-date-company-roadmap":
// the company roadmap (Product roadmap) exists next to the PRD's older Help desk roadmap, so the
// answer and the re-plan read and write the company roadmap, as the API's _roadmap_id). The goal is a Baseline
// goal (fitDateGoal); lowering its target shrinks the goal's own unlocked work, as the API's _scale
// and build_plan: never a guardrail, safety or must-include item. Every day, person-week, move, rank,
// pick and date comes from the API's capacity queue (./fit-date-engine, a port of oracle.simple.fit_date)
// run on ./fit-date-plan.json, the plan api/tests/test_simple_fit_date_mock_plan.py runs through the real
// engine; no number here is set by hand.

import type { Schemas } from "@/lib/api/client";
import { MOCK_NOW } from "./clock";
import * as fd from "./fit-date-engine";
import { PLAN_HARD_TARGET, PLAN_TARGET } from "./fit-date-engine";

export { round1 } from "./fit-date-engine";
import { stableUuid } from "./ids";
import { COMPANY_SLUG, COMPANY_TITLE } from "./one-roadmap";
import { fitDateApproved, roadmapId } from "./simple-roadmap";

type Goal = Schemas["FitGoalOut"];
type Answer = Schemas["FitAnswerOut"];
type Change = Schemas["FitChangeOut"];
type Draft = Schemas["FitDraftOut"];

export const FIT_COMPANY_SCENARIO = "fit-date-company-roadmap";
export const FIT_SCENARIOS = ["fit-date", "fit-date-hard", "fit-date-hard-no-goal", "fit-date-foreign-draft", FIT_COMPANY_SCENARIO] as const;
const isHard = (scenario: string | null) => scenario === "fit-date-hard" || scenario === "fit-date-hard-no-goal";

// The Baseline goal the M2 gate counts toward: the PRD's milestone target names 40.
export const FIT_GOAL_ID = stableUuid("fit-date/goal");
const GOAL_TITLE = "40 replied threads per agent per day";
const PLAN_TARGET_VALUE = 40;
// The goal's own due date (invented): the smaller-goal sheet opens with it.
const GOAL_DUE = "2027-03-31";
type GoalRow = { id: string; type: string; title: string; status: string; attrs?: Record<string, unknown> | null };

/** The fit-date scenarios' Baseline goal (none under "fit-date-hard-no-goal"). */
export function fitDateGoal<T extends GoalRow>(scenario: string | null, template: T): T | null {
  if (scenario === "fit-date-hard-no-goal") return null;
  return {
    ...template, id: FIT_GOAL_ID, key: "replied-threads", type: "goal", title: GOAL_TITLE, body: null, status: "confirmed",
    locked: false, locked_by: null, locked_at: null,
    attrs: { metric: "replied threads per agent per day", unit: "threads", comparison: "at_least", start: 20, target: PLAN_TARGET_VALUE, horizon: "short", due: GOAL_DUE },
  };
}

const PRD = { id: stableUuid("fit-date/prd"), slug: "reply-faster", title: "Reply faster in the shared inbox" };
const ROADMAP = { id: stableUuid("fit-date/roadmap"), slug: "help-desk-roadmap", title: "Help desk roadmap" };
// one-roadmap-many-prds: while the company roadmap exists, the re-plan reads and writes it, never the
// PRD's track's older roadmap (the API's fit_date_router._roadmap_id).
const COMPANY = { id: roadmapId(COMPANY_SLUG), slug: COMPANY_SLUG, title: COMPANY_TITLE };

type State = { version: number; roadmapVersion: number; approved: Schemas["FitApprovalOut"] | null; picks: string[]; target: string; company: boolean };
let state: State | null = null;
function fresh(scenario: string | null): State {
  return { version: 3, roadmapVersion: 6, approved: null, picks: [], target: isHard(scenario) ? PLAN_HARD_TARGET : PLAN_TARGET, company: scenario === FIT_COMPANY_SCENARIO };
}

let goals: GoalRow[] = [];

/** The Baseline goal by the goal's name, as the API's _baseline_goal: confirmed first, never rejected. */
function baselineGoal(role: string): Schemas["FitBaselineGoalOut"] | null {
  const found = goals.filter((g) => g.type === "goal" && g.title.trim().toLowerCase() === GOAL_TITLE.toLowerCase() && g.status !== "rejected");
  const g = found.find((x) => x.status === "confirmed") ?? found[0];
  if (!g) return null;
  const a = g.attrs ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: Schemas["FitBaselineGoalOut"] = {
    id: g.id, title: g.title, target: num(a.target), unit: typeof a.unit === "string" ? a.unit : null,
    comparison: typeof a.comparison === "string" ? a.comparison : null, start: num(a.start),
    due: typeof a.due === "string" ? a.due : null, plan_target: PLAN_TARGET_VALUE, smaller: false, can_edit: APPROVERS.has(role),
  };
  out.smaller = scale(out) < 1;
  return out;
}

/** The share of the goal's own work a smaller goal still needs (the API's _scale). */
function scale(g: Schemas["FitBaselineGoalOut"] | null): number {
  if (!g || g.target == null || g.plan_target == null || !["at_least", "above"].includes(g.comparison ?? "")) return 1;
  const base = g.start != null && g.start < g.plan_target ? g.start : 0;
  if (g.target >= g.plan_target || g.plan_target <= base) return 1;
  return Math.max(0.1, Math.min(1, (g.target - base) / (g.plan_target - base)));
}

/** The PRD's plan as the API reads it (build_plan): the goal's own work at the smaller goal's share,
 * the approved re-plans in it, the milestone's target. */
const planOf = (s: State): fd.Plan => fd.apply(fd.basePlan(scale(baselineGoal("viewer")), s.target), s.picks);

/** A calendar day, "Mar 19" (the API's company_time.calendar_day). */
function words(isoDay: string | null): string {
  if (!isoDay) return "not dated";
  return new Date(Date.parse(`${isoDay}T00:00:00Z`)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The change in one line, from the plan with it applied (the API's _effect). */
function effect(p: fd.Plan, c: fd.Change): string {
  const names = new Map(p.milestones.map((m) => [m.code, m.name]));
  const item = p.items.find((i) => i.id === c.id);
  const after = fd.schedule(fd.apply(p, [c.id]));
  const nxt = fd.nextCode(p, p.milestone);
  const lands = words(after.items[c.id] ?? null);
  if (c.lever === "move" && item) return c.cost_kind === "must" ? "Must-include for this goal" : `Moves to ${names.get(nxt ?? "") ?? "later"}: lands ${lands}`;
  if (c.lever === "ungate") return `Still built, lands ${lands}; ${p.milestone} no longer waits for it`;
  if (c.lever === "next_prd") return "Leaves this PRD; waits for the next one";
  if (c.lever === "slice" && item) return `${item.pw} person-weeks down to ${item.slice_pw || item.pw}`;
  if (c.lever === "split" && item) return `Slice 1 lands ${lands}; slice 2 after ${p.milestone}`;
  if (c.lever === "overlap") return `${p.milestone} work starts during the wait, not after it`;
  return `Every bar is shorter at ${fd.pyRound((p.focus_raise || p.focus) * 100)}% focus`;
}

/** The lanes of the plan, in milestone order, each item at its scheduled end (the API's _lanes). */
function lanes(p: fd.Plan): Schemas["FitLane"][] {
  const s = fd.schedule(p);
  return p.milestones.map((m) => ({
    code: m.code, name: m.name, date: s.milestones[m.code] ?? null,
    items: p.items.filter((i) => i.milestone === m.code).map((i) => ({ id: i.id, title: i.title, date: s.items[i.id] ?? null, locked: !!i.guard, needs_estimate: false })),
  }));
}

function goal(s: State): Goal {
  const p = planOf(s);
  const today = fd.schedule(p).milestones[p.milestone];
  return {
    prd: PRD, prd_version: s.version, roadmap: s.company ? COMPANY : ROADMAP, roadmap_version: s.roadmapVersion,
    goal: "40 replied threads per agent per day", goal_now: "26 replied threads per agent today",
    milestone: p.milestone, milestone_name: p.milestones.find((m) => m.code === p.milestone)?.name ?? p.milestone, target: p.target, today,
    late_days: fd.gap(today, p.target), team: { engineers: p.engineers, focus: p.focus }, lanes: lanes(p), approved: s.approved,
  };
}

// The weeks before a new engineer's work counts (the API's HIRE_START_WEEKS).
const HIRE_START_WEEKS = 3;
/** The best date with one more engineer who counts only after their start weeks (the API's _hire). */
function hire(p: fd.Plan, best: string): Schemas["FitHireOut"] {
  const n = p.engineers;
  const start = HIRE_START_WEEKS * 7;
  const days = fd.gap(best, p.start);
  const after = days <= start ? days : start + Math.ceil(((days - start) * n) / (n + 1));
  const date = fd.addDays(p.start, after);
  return { start_weeks: HIRE_START_WEEKS, date, reaches: date <= p.target };
}

function answer(s: State, role: string): Answer {
  const p = planOf(s);
  const a = fd.answer(p);
  const changes: Change[] = a.changes.map((c) => ({
    id: c.id, lever: c.lever, item: c.item, title: c.title, days: c.days, pw_saved: c.pw_saved, cost_kind: c.cost_kind, cost: c.cost,
    pickable: c.pickable, effect: effect(p, c), moves: c.moves.map(([what, before, after]) => ({ what, before, after })),
  }));
  return {
    ...goal(s), changes, pick: a.pick, pick_date: a.pick_date, best_date: a.best_date, reachable: a.reachable,
    locked: a.locked.map(([it, reach]) => ({ item: it.title, pw: it.pw, why: it.guard ?? "", would_reach: reach })),
    hire: a.reachable ? null : hire(p, a.best_date),
    baseline_goal: baselineGoal(role),
  };
}

/** The re-plan the picks draft (the API's _draft_out). */
function draft(s: State, picks: string[]): Draft {
  const p = planOf(s);
  const d = fd.draft(p, picks);
  const dates = d.dates.map(([what, before, after]) => {
    const later = after === null || (before !== null && after > before);
    const target = what === "Target";
    return {
      what: target ? `${p.milestone} target` : what, before, after, kind: later ? ("out" as const) : ("in" as const),
      note: target ? `No set of changes reaches ${words(before)}, so you approve the new target too` : null,
    };
  });
  return {
    prd: PRD, prd_version: s.version, next_version: s.version + 1, roadmap_version: s.roadmapVersion,
    changes: d.prd.map(([item, change]) => ({ item, change })), dates, new_target: d.new_target,
    date: fd.schedule(d.plan).milestones[p.milestone], needs_estimate: d.needs_estimate.map((i) => ({ item: i.title, owner: i.owner })),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The Help desk roadmap's decider (invented).
const DECIDER = "Noor Hale";
// Who has unsaved edits in the roadmap's working draft under "fit-date-foreign-draft" (invented).
const DRAFT_EDITOR = "Ines Moreau";
const APPROVERS = new Set(["owner", "decider", "approver"]);

/** GET /v1/simple/fit-date, GET|POST /v1/simple/prds/{prd}/fit-date[/live|/draft|/approve]. */
export async function routeFitDate(scenario: string | null, role: string, req: Request, p: string[], baseline: GoalRow[] = []): Promise<Response | null> {
  goals = baseline;
  if (p[1] !== "simple") return null;
  const list = p[2] === "fit-date" && p.length === 3;
  const one = p[2] === "prds" && p[4] === "fit-date";
  if (!list && !one) return null;
  const on = (FIT_SCENARIOS as readonly string[]).includes(scenario ?? "");
  if (list) return json(200, on ? [goal((state ??= fresh(scenario)))] : []);
  if (!on || (p[3] !== PRD.slug && p[3] !== PRD.id)) return json(404, { detail: "No such PRD" });
  const s = (state ??= fresh(scenario));
  if (req.method === "GET" && p.length === 5) return json(200, answer(s, role));
  if (req.method !== "POST") return null;
  const body = JSON.parse((await req.text()) || "{}") as Schemas["FitPicksIn"];
  const picks = body.picks;
  const plan = planOf(s);
  if (p[5] === "live") {
    // The milestone's date with these changes picked: the capacity queue (the API's fit_date_live).
    const after = fd.apply(plan, picks);
    const date = fd.schedule(after).milestones[plan.milestone];
    return json(200, { date, target: plan.target, over_days: fd.gap(date, plan.target), pw_saved: fd.pwSaved(plan, after), picks });
  }
  if (!APPROVERS.has(role)) return json(403, { detail: "Only approvers can change the plan." });
  if (p[5] === "draft") return json(200, draft(s, picks));
  if (p[5] === "approve") {
    const d = draft(s, picks);
    if (d.changes.length === 0) return json(422, { detail: "Pick at least one change." });
    // The roadmap's working draft holds someone else's edits: approving would publish them (the API's
    // _foreign_edits), so it is refused and nothing is written.
    if (scenario === "fit-date-foreign-draft")
      return json(409, { detail: `${DRAFT_EDITOR} has unsaved changes in this roadmap's draft; ask them to submit or discard first.` });
    // The roadmap's version is live when the approver decides the roadmap (an owner or its
    // decider), else it waits in review with its decider, as the API's _roadmap_follows.
    const live = role !== "approver";
    const was = fd.schedule(plan).milestones[plan.milestone];
    s.version += 1;
    s.roadmapVersion += 1;
    // The next version's re-plan section holds these picks with the ones before (the API's _replans).
    s.picks = [...s.picks, ...picks];
    if (d.new_target) s.target = d.new_target;
    // The roadmap follows: its items take the draft's new dates.
    fitDateApproved(d.dates.map((x) => ({ item: x.what, end: x.after })), d.needs_estimate.map((n) => n.item));
    s.approved = {
      at: new Date(Date.parse(MOCK_NOW) + 3 * 3600000 + 14 * 60000).toISOString(), by_me: true, version: s.version, roadmap_version: s.roadmapVersion, roadmap_live: live, roadmap_decider: live ? null : DECIDER,
      was, date: d.date, target: s.target,
      moves: d.dates.filter((m) => m.what !== `${plan.milestone} target`).map((m) => `${m.what}: ${words(m.after ?? null)}`),
    };
    return json(200, { prd: PRD, version: s.version, date: d.date, target: s.target, approved_at: s.approved.at, needs_estimate: d.needs_estimate, roadmap_version: s.roadmapVersion, roadmap_live: live, roadmap_decider: live ? null : DECIDER });
  }
  return null;
}

/** A fresh mock (a new page load) starts from today's plan again. */
export function resetFitDate(): void {
  state = null;
}

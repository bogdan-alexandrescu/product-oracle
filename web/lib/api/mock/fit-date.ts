// Bring a date in (Simple, oracle.simple.fit_date_router): one invented PRD's goal milestone that
// misses its target, Oracle's ranked changes, the live date of a picked set, the drafted re-plan and
// its approval. Invented company (Larkspur Help Desk), goals, items and engineers only. Served under
// the "fit-date" mock scenario (and "fit-date-hard": the target is Jan 8, which no set reaches;
// "fit-date-hard-no-goal": the same with no Baseline goal by the goal's name; "fit-date-foreign-draft":
// the roadmap's draft holds someone else's edits, so approving is refused; "fit-date-company-roadmap":
// the company roadmap (Product roadmap) exists next to the PRD's older Help desk roadmap, so the
// answer and the re-plan read and write the company roadmap, as the API's _roadmap_id). The goal is a Baseline
// goal (fitDateGoal); lowering its target shrinks the goal's own unlocked work, as the API's _scale
// and build_plan: never a guardrail, safety or must-include item.

import type { Schemas } from "@/lib/api/client";
import { MOCK_NOW } from "./clock";
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
const PLAN_TARGET = 40;
// The goal's own due date (invented): the smaller-goal sheet opens with it.
const GOAL_DUE = "2027-03-31";
// The goal's own M2 work a smaller goal shrinks (the API's build_plan): unlocked and neither guardrail,
// safety nor must-include, so Reply drafts in the inbox (must-include) and the two locked items keep their
// size. Days on the plan in M2, and the days left in M2 once its change is picked (moved: none; sliced:
// the slice).
const GOAL_WORK: Record<string, { days: number; left: number }> = {
  bulk: { days: 16, left: 0 },
  summary: { days: 21, left: 16 },
};
type GoalRow = { id: string; type: string; title: string; status: string; attrs?: Record<string, unknown> | null };

/** The fit-date scenarios' Baseline goal (none under "fit-date-hard-no-goal"). */
export function fitDateGoal<T extends GoalRow>(scenario: string | null, template: T): T | null {
  if (scenario === "fit-date-hard-no-goal") return null;
  return {
    ...template, id: FIT_GOAL_ID, key: "replied-threads", type: "goal", title: GOAL_TITLE, body: null, status: "confirmed",
    locked: false, locked_by: null, locked_at: null,
    attrs: { metric: "replied threads per agent per day", unit: "threads", comparison: "at_least", start: 20, target: PLAN_TARGET, horizon: "short", due: GOAL_DUE },
  };
}

const PRD = { id: stableUuid("fit-date/prd"), slug: "reply-faster", title: "Reply faster in the shared inbox" };
const ROADMAP = { id: stableUuid("fit-date/roadmap"), slug: "help-desk-roadmap", title: "Help desk roadmap" };
// one-roadmap-many-prds: while the company roadmap exists, the re-plan reads and writes it, never the
// PRD's track's older roadmap (the API's fit_date_router._roadmap_id).
const COMPANY = { id: roadmapId(COMPANY_SLUG), slug: COMPANY_SLUG, title: COMPANY_TITLE };

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shift = (date: string, days: number) => iso(day(date) - days * 86400000);
const gap = (a: string, b: string) => Math.round((day(a) - day(b)) / 86400000);

const PROJECTED = "2027-03-12";
const TARGET = "2027-01-29";
const HARD_TARGET = "2027-01-08";

type Item = { id: string; title: string; end: string; locked?: boolean };
const M1: Item[] = [
  { id: "views", title: "Shared inbox views", end: "2026-11-27" },
  { id: "assign", title: "Assign a thread", end: "2026-12-04" },
];
const M2: Item[] = [
  { id: "drafts", title: "Reply drafts in the inbox", end: "2026-12-18" },
  { id: "guard", title: "Send check before a draft goes out", end: "2026-12-30", locked: true },
  { id: "summary", title: "Thread summary card", end: "2027-01-22" },
  { id: "bulk", title: "Reply to similar threads at once", end: "2027-02-12" },
  { id: "analytics", title: "Reply time chart", end: "2027-02-19" },
  { id: "tone", title: "Tone presets", end: "2027-02-26" },
  { id: "snippets", title: "Import saved snippets", end: "2027-03-05" },
  { id: "redact", title: "Hide card numbers in drafts", end: "2027-03-12", locked: true },
];
const M3: Item[] = [{ id: "edit", title: "Edit a thread summary", end: "2027-04-02" }];

const mv = (what: string, before: string, after: string) => ({ what, before, after });
// Ranked by days saved for the least harm (the API's order); Oracle's own pick reaches Jan 29.
const CHANGES: Change[] = [
  { id: "bulk", lever: "move", title: "Move after the date", item: "Reply to similar threads at once", days: 16, pw_saved: 5, cost_kind: "goal", pickable: true,
    cost: "The goal starts lower: about 34 of 40 replied threads at launch, 40 after M3.",
    effect: "Moves to M3 Team inbox: lands Mar 19, M3 on Apr 9",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-02-24"), mv("M3 Team inbox", "2027-04-02", "2027-04-09")] },
  { id: "analytics", lever: "ungate", title: "Take off the gate, keep on the roadmap", item: "Reply time chart", days: 10, pw_saved: 4, cost_kind: "gate", pickable: true,
    cost: "For three weeks after launch nobody sees reply times on a chart; the weekly export still has them.",
    effect: "Still built, lands Mar 5; M2 no longer waits for it",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-02")] },
  { id: "tone", lever: "next_prd", title: "Move to the next PRD", item: "Tone presets", days: 8, pw_saved: 3, cost_kind: "none", pickable: true,
    cost: "Asked for in 6 requests; those people hear it moved.",
    effect: "Leaves this PRD; waits for the next one",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-04")] },
  { id: "wait:M2", lever: "overlap", title: "Overlap a calendar-only wait", item: "M1 7-day hold", days: 7, pw_saved: 0, cost_kind: "risk", pickable: true,
    cost: "A bug found in M1's hold pulls Rina Vale back for up to a week.",
    effect: "M2 work starts during M1's hold, not after it",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-05")] },
  { id: "focus", lever: "capacity", title: "Raise focus time", item: "Team focus 70% to 80%", days: 6, pw_saved: 0, cost_kind: "risk", pickable: true,
    cost: "Support shifts move to two people outside the team for 10 weeks.",
    effect: "Fewer support shifts for the four engineers",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-06")] },
  { id: "summary", lever: "slice", title: "Ship only the slice M2 needs", item: "Thread summary card", days: 5, pw_saved: 2, cost_kind: "none", pickable: true,
    cost: "Agents cannot fix a wrong summary until the rest ships in M3.",
    effect: "8 person-weeks down to 6: read-only summary, no edit",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-07")] },
  { id: "snippets", lever: "split", title: "Split so a first slice lands early", item: "Import saved snippets", days: 3, pw_saved: 1, cost_kind: "none", pickable: true,
    cost: "Snippets with pictures wait for slice 2.",
    effect: "Slice 1 (plain text) lands Jan 14; slice 2 after M2",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-09")] },
  { id: "drafts", lever: "move", title: "Move after the date", item: "Reply drafts in the inbox", days: 18, pw_saved: 6, cost_kind: "must", pickable: false,
    cost: "The goal cannot move without drafts, so Oracle will not tick it.",
    effect: "Must-include for this goal",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-02-22")] },
];
const PICK = ["bulk", "analytics", "tone", "wait:M2", "summary"];

const LOCKED = [
  { item: "Send check before a draft goes out", pw: 3, why: "Guardrail: no draft is sent without an agent reading it." },
  { item: "Hide card numbers in drafts", pw: 2, why: "Safety: card numbers never reach a draft or a log." },
];

type State = { version: number; roadmapVersion: number; approved: Schemas["FitApprovalOut"] | null; picks: string[]; target: string; company: boolean };
let state: State | null = null;
function fresh(scenario: string | null): State {
  return { version: 3, roadmapVersion: 6, approved: null, picks: [], target: isHard(scenario) ? HARD_TARGET : TARGET, company: scenario === FIT_COMPANY_SCENARIO };
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
    due: typeof a.due === "string" ? a.due : null, plan_target: PLAN_TARGET, smaller: false, can_edit: APPROVERS.has(role),
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

const share = () => scale(baselineGoal("viewer"));
const byId = (ids: string[]) => CHANGES.filter((c) => c.pickable && ids.includes(c.id));
/** Days a set of picks takes off M2: the other changes' days, and the goal's own work (GOAL_WORK)
 * counted at the smaller goal's share, what is left of it once its change is picked. */
function savedDays(ids: string[]): number {
  const s = share();
  const other = byId(ids).filter((c) => !GOAL_WORK[c.id]).reduce((t, c) => t + c.days, 0);
  const own = Object.entries(GOAL_WORK).reduce((t, [id, w]) => t + w.days - s * (ids.includes(id) ? w.left : w.days), 0);
  return Math.round(other + own);
}
const pwSaved = (ids: string[]) => Math.round(byId(ids).reduce((t, c) => t + c.pw_saved * (GOAL_WORK[c.id] ? share() : 1), 0) * 10) / 10;
const at = (picks: string[]) => shift(PROJECTED, savedDays(picks));

const HARM: Record<Change["cost_kind"], number> = { none: 0, risk: 1, gate: 2, goal: 3, must: 9 };
/** The changes measured against the goal (the goal's own work at its share), ranked strictly by days
 * saved for the least harm, the must-include change too (the API's answer). */
function ranked(): Change[] {
  const s = share();
  return CHANGES.map((c) => (GOAL_WORK[c.id] ? { ...c, days: Math.round(c.days * s), pw_saved: Math.max(Math.round(c.pw_saved * s * 10) / 10, c.pw_saved * 0.1) } : c)).sort(
    (x, y) => y.days - x.days || HARM[x.cost_kind] - HARM[y.cost_kind] || x.item.localeCompare(y.item),
  );
}

/** The lanes after the picks: kept M2 items end by M2's new date; moved ones go where the change says. */
function lanes(picks: string[]): Schemas["FitLane"][] {
  const date = at(picks);
  const on = (id: string) => picks.includes(id);
  const lane = (items: Item[]) => items.map((i) => ({ id: i.id, title: i.title, date: i.end, locked: !!i.locked, needs_estimate: false }));
  if (picks.length === 0)
    return [
      { code: "M2", name: "M2 Agent reply flow", date, items: lane(M2) },
      { code: "M1", name: "M1 Inbox basics", date: "2026-12-04", items: lane(M1) },
      { code: "M3", name: "M3 Team inbox", date: "2027-04-02", items: lane(M3) },
    ];
  const m2 = M2.filter((i) => !(on(i.id) && ["bulk", "tone"].includes(i.id))).map((i) => {
    const end = i.id === "summary" && on("summary") ? "2027-01-08" : i.id === "snippets" ? (on("snippets") ? "2027-01-14" : shift(date, 7)) : i.id === "redact" ? date : i.id === "analytics" && on("analytics") ? "2027-03-05" : day(i.end) > day(date) ? date : i.end;
    const title = i.id === "summary" && on("summary") ? "Thread summary card (first slice)" : i.id === "analytics" && on("analytics") ? "Reply time chart (no longer holds M2)" : i.title;
    return { id: i.id, title, date: end, locked: !!i.locked, needs_estimate: (i.id === "summary" && on("summary")) || (i.id === "snippets" && on("snippets")) };
  });
  const m3 = [...(on("bulk") ? [{ id: "bulk", title: "Reply to similar threads at once", date: "2027-03-19", locked: false, needs_estimate: false }] : []), ...lane(M3)];
  const out: Schemas["FitLane"][] = [
    { code: "M1", name: "M1 Inbox basics", date: "2026-12-04", items: lane(M1) },
    { code: "M2", name: "M2 Agent reply flow", date, items: m2 },
    { code: "M3", name: "M3 Team inbox", date: on("bulk") ? "2027-04-09" : "2027-04-02", items: m3 },
  ];
  if (on("tone")) out.push({ code: "next", name: "Next PRD", date: null, items: [{ id: "tone", title: "Tone presets", date: null, locked: false, needs_estimate: false }] });
  return out;
}

function goal(s: State): Goal {
  const today = at(s.picks);
  return {
    prd: PRD, prd_version: s.version, roadmap: s.company ? COMPANY : ROADMAP, roadmap_version: s.roadmapVersion,
    goal: "40 replied threads per agent per day", goal_now: "26 replied threads per agent today",
    milestone: "M2", milestone_name: "M2 Agent reply flow", target: s.target, today,
    late_days: gap(today, s.target), team: { engineers: 4, focus: 0.7 }, lanes: lanes(s.picks), approved: s.approved,
  };
}

function answer(s: State, role: string): Answer {
  const changes = ranked();
  const all = changes.filter((c) => c.pickable).map((c) => c.id);
  const best = at(all);
  const reachable = gap(best, s.target) <= 0;
  // Oracle's own pick, else (a smaller goal) down the ranked list until the date reaches the target.
  const greedy: string[] = [];
  for (const id of all) if (gap(at(greedy), s.target) > 0) greedy.push(id);
  const pick = !reachable ? all : gap(at(PICK), s.target) <= 0 ? PICK : greedy;
  return {
    ...goal(s), changes, pick, pick_date: at(pick), best_date: best, reachable,
    locked: LOCKED.map((l) => ({ ...l, would_reach: !reachable && l.pw === 3 })),
    hire: reachable ? null : { start_weeks: 3, date: shift(HARD_TARGET, -6), reaches: false },
    baseline_goal: baselineGoal(role),
  };
}

function draft(s: State, picks: string[]): Draft {
  const date = at(picks);
  const newTarget = gap(date, s.target) > 0 ? date : null;
  const on = (id: string) => picks.includes(id);
  const prdWords: Record<string, [string, string]> = {
    bulk: ["Reply to similar threads at once", "Moved to M3"],
    analytics: ["Reply time chart", "No longer holds M2; still built, lands Mar 5"],
    summary: ["Thread summary card (8 to 6 person-weeks)", "First slice only in M2"],
    tone: ["Tone presets", "Moved to the next PRD"],
    snippets: ["Import saved snippets", "First slice only in M2 (plain text)"],
    focus: ["Team focus", "70% to 80%; support shifts move to two people outside the team for 10 weeks"],
    "wait:M2": ["M1 7-day hold", "M2 work starts during the hold"],
  };
  const changes = picks.filter((p) => prdWords[p]).map((p) => ({ item: prdWords[p][0], change: prdWords[p][1] }));
  if (on("bulk")) changes.push({ item: "The goal", change: "34 of 40 replied threads at launch; 40 after M3" });
  const d = (what: string, before: string, after: string | null, kind: "in" | "out", note: string | null = null) => ({ what, before, after, kind, note });
  const dates = [
    ...(newTarget ? [d("M2 target", s.target, newTarget, "out", `No set of cuts reaches ${words(s.target)}, so you approve the new target too`)] : []),
    d("M2 Agent reply flow", PROJECTED, date, "in"),
    d("Goal: 40 replied threads per agent per day", PROJECTED, date, "out", on("bulk") ? "Launches at 34 of 40; the full 40 comes with M3 Team inbox, Apr 9" : null),
    ...(on("summary") ? [d("Thread summary card (first slice)", "2027-01-22", "2027-01-08", "in")] : []),
    d(on("snippets") ? "Import saved snippets (first slice)" : "Import saved snippets", "2027-03-05", on("snippets") ? "2027-01-14" : shift(date, 7), "in"),
    d("Hide card numbers in drafts", PROJECTED, date, "in"),
    ...(on("analytics") ? [d("Reply time chart (no longer holds M2)", "2027-02-19", "2027-03-05", "out")] : []),
    ...(on("bulk") ? [d("Reply to similar threads at once (to M3)", "2027-02-12", "2027-03-19", "out"), d("M3 Team inbox", "2027-04-02", "2027-04-09", "out")] : []),
    ...(on("tone") ? [d("Tone presets (to the next PRD)", "2027-02-26", null, "out")] : []),
  ];
  const needs = [
    ...(on("summary") ? [{ item: "Thread summary card", owner: "Tomas Brook" }] : []),
    ...(on("snippets") ? [{ item: "Import saved snippets", owner: "Rina Vale" }] : []),
  ];
  return { prd: PRD, prd_version: s.version, next_version: s.version + 1, roadmap_version: s.roadmapVersion, changes, dates, new_target: newTarget, date, needs_estimate: needs };
}

function words(isoDay: string): string {
  return new Date(day(isoDay)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
  const picks = body.picks.filter((id) => byId([id]).length > 0);
  if (p[5] === "live") {
    const date = at(picks);
    return json(200, { date, target: s.target, over_days: gap(date, s.target), pw_saved: pwSaved(picks), picks: body.picks });
  }
  if (!APPROVERS.has(role)) return json(403, { detail: "Only approvers can change the plan." });
  if (p[5] === "draft") return json(200, draft(s, picks));
  if (p[5] === "approve") {
    if (picks.length === 0) return json(422, { detail: "Pick at least one change." });
    // The roadmap's working draft holds someone else's edits: approving would publish them (the API's
    // _foreign_edits), so it is refused and nothing is written.
    if (scenario === "fit-date-foreign-draft")
      return json(409, { detail: `${DRAFT_EDITOR} has unsaved changes in this roadmap's draft; ask them to submit or discard first.` });
    const d = draft(s, picks);
    // The roadmap's version is live when the approver decides the roadmap (an owner or its
    // decider), else it waits in review with its decider, as the API's _roadmap_follows.
    const live = role !== "approver";
    const was = at(s.picks);
    s.version += 1;
    s.roadmapVersion += 1;
    s.picks = picks;
    if (d.new_target) s.target = d.new_target;
    // The roadmap follows: its items take the draft's new dates ("Thread summary card (first slice)": Thread summary card).
    fitDateApproved(d.dates.map((x) => ({ item: x.what.replace(/ \(.*\)$/, ""), end: x.after })), d.needs_estimate.map((n) => n.item));
    s.approved = {
      at: new Date(Date.parse(MOCK_NOW) + 3 * 3600000 + 14 * 60000).toISOString(), by_me: true, version: s.version, roadmap_version: s.roadmapVersion, roadmap_live: live, roadmap_decider: live ? null : DECIDER,
      was, date: d.date, target: s.target,
      moves: [
        ...(picks.includes("bulk") ? ["Reply to similar threads at once moved to M3 Team inbox: it lands Mar 19, and M3 lands Apr 9 (was Apr 2)."] : []),
        ...(picks.includes("analytics") ? ["The reply time chart is still built and lands Mar 5; M2 no longer waits for it."] : []),
        ...(picks.includes("tone") ? ["Tone presets left this PRD; Priorities lists it under the next one."] : []),
        ...(picks.includes("bulk") ? ["The goal starts at 34 of 40 replied threads at launch and reaches 40 with M3."] : []),
      ],
    };
    return json(200, { prd: PRD, version: s.version, date: d.date, target: s.target, approved_at: s.approved.at, needs_estimate: d.needs_estimate, roadmap_version: s.roadmapVersion, roadmap_live: live, roadmap_decider: live ? null : DECIDER });
  }
  return null;
}

/** A fresh mock (a new page load) starts from today's plan again. */
export function resetFitDate(): void {
  state = null;
}

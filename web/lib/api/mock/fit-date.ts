// Bring a date in (Simple, oracle.simple.fit_date_router): one invented PRD's goal milestone that
// misses its target, Oracle's ranked changes, the live date of a picked set, the drafted re-plan and
// its approval. Invented company (Larkspur Help Desk), goals, items and engineers only. Served under
// the "fit-date" mock scenario (and "fit-date-hard": the target is Jan 8, which no set reaches).

import type { Schemas } from "@/lib/api/client";
import { MOCK_NOW } from "./clock";
import { stableUuid } from "./ids";
import { fitDateApproved } from "./simple-roadmap";

type Goal = Schemas["FitGoalOut"];
type Answer = Schemas["FitAnswerOut"];
type Change = Schemas["FitChangeOut"];
type Draft = Schemas["FitDraftOut"];

export const FIT_SCENARIOS = ["fit-date", "fit-date-hard"] as const;

const PRD = { id: stableUuid("fit-date/prd"), slug: "reply-faster", title: "Reply faster in the shared inbox" };
const ROADMAP = { id: stableUuid("fit-date/roadmap"), slug: "help-desk-roadmap", title: "Help desk roadmap" };

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
    effect: "4 person-weeks down to 2: read-only summary, no edit",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-07")] },
  { id: "snippets", lever: "split", title: "Split so a first slice lands early", item: "Import saved snippets", days: 3, pw_saved: 1, cost_kind: "none", pickable: true,
    cost: "Snippets with pictures wait for slice 2.",
    effect: "Slice 1 (plain text) lands Jan 14; slice 2 after M2",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-03-09")] },
  { id: "drafts", lever: "move", title: "Move after the date", item: "Reply drafts in the inbox", days: 18, pw_saved: 6, cost_kind: "must", pickable: false,
    cost: "The goal cannot move without drafts, so Oracle ranks it last and will not tick it.",
    effect: "Must-include for this goal",
    moves: [mv("M2 Agent reply flow", "2027-03-12", "2027-02-22")] },
];
const PICK = ["bulk", "analytics", "tone", "wait:M2", "summary"];

const LOCKED = [
  { item: "Send check before a draft goes out", pw: 3, why: "Guardrail: no draft is sent without an agent reading it." },
  { item: "Hide card numbers in drafts", pw: 2, why: "Safety: card numbers never reach a draft or a log." },
];

type State = { version: number; roadmapVersion: number; approved: Schemas["FitApprovalOut"] | null; picks: string[]; target: string };
let state: State | null = null;
function fresh(hard: boolean): State {
  return { version: 3, roadmapVersion: 6, approved: null, picks: [], target: hard ? HARD_TARGET : TARGET };
}

const byId = (ids: string[]) => CHANGES.filter((c) => c.pickable && ids.includes(c.id));
const saved = (ids: string[]) => byId(ids).reduce((s, c) => ({ days: s.days + c.days, pw: s.pw + c.pw_saved }), { days: 0, pw: 0 });

/** The lanes after the picks: kept M2 items end by M2's new date; moved ones go where the change says. */
function lanes(picks: string[]): Schemas["FitLane"][] {
  const date = shift(PROJECTED, saved(picks).days);
  const on = (id: string) => picks.includes(id);
  const lane = (items: Item[]) => items.map((i) => ({ id: i.id, title: i.title, date: i.end, locked: !!i.locked, needs_estimate: false }));
  if (picks.length === 0)
    return [
      { code: "M2", name: "M2 Agent reply flow", date: PROJECTED, items: lane(M2) },
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
  const today = shift(PROJECTED, saved(s.picks).days);
  return {
    prd: PRD, prd_version: s.version, roadmap: ROADMAP, roadmap_version: s.roadmapVersion,
    goal: "40 replied threads per agent per day", goal_now: "26 replied threads per agent today",
    milestone: "M2", milestone_name: "M2 Agent reply flow", target: s.target, today,
    late_days: gap(today, s.target), team: { engineers: 4, focus: 0.7 }, lanes: lanes(s.picks), approved: s.approved,
  };
}

function answer(s: State): Answer {
  const all = CHANGES.filter((c) => c.pickable).map((c) => c.id);
  const best = shift(PROJECTED, saved(all).days);
  const reachable = gap(best, s.target) <= 0;
  const pick = reachable ? PICK : all;
  return {
    ...goal(s), changes: CHANGES, pick, pick_date: shift(PROJECTED, saved(pick).days), best_date: best, reachable,
    locked: LOCKED.map((l) => ({ ...l, would_reach: !reachable && l.pw === 3 })),
    hire: reachable ? null : { start_weeks: 3, date: shift(HARD_TARGET, -6), reaches: false },
  };
}

function draft(s: State, picks: string[]): Draft {
  const date = shift(PROJECTED, saved(picks).days);
  const newTarget = gap(date, s.target) > 0 ? date : null;
  const on = (id: string) => picks.includes(id);
  const prdWords: Record<string, [string, string]> = {
    bulk: ["Reply to similar threads at once", "Moved to M3"],
    analytics: ["Reply time chart", "No longer holds M2; still built, lands Mar 5"],
    summary: ["Thread summary card (4 to 2 person-weeks)", "First slice only in M2"],
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
const APPROVERS = new Set(["owner", "decider", "approver"]);

/** GET /v1/simple/fit-date, GET|POST /v1/simple/prds/{prd}/fit-date[/live|/draft|/approve]. */
export async function routeFitDate(scenario: string | null, role: string, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  const list = p[2] === "fit-date" && p.length === 3;
  const one = p[2] === "prds" && p[4] === "fit-date";
  if (!list && !one) return null;
  const on = (FIT_SCENARIOS as readonly string[]).includes(scenario ?? "");
  if (list) return json(200, on ? [goal((state ??= fresh(scenario === "fit-date-hard")))] : []);
  if (!on || (p[3] !== PRD.slug && p[3] !== PRD.id)) return json(404, { detail: "No such PRD" });
  const s = (state ??= fresh(scenario === "fit-date-hard"));
  if (req.method === "GET" && p.length === 5) return json(200, answer(s));
  if (req.method !== "POST") return null;
  const body = JSON.parse((await req.text()) || "{}") as Schemas["FitPicksIn"];
  const picks = body.picks.filter((id) => byId([id]).length > 0);
  if (p[5] === "live") {
    const date = shift(PROJECTED, saved(picks).days);
    return json(200, { date, target: s.target, over_days: gap(date, s.target), pw_saved: saved(picks).pw, picks: body.picks });
  }
  if (!APPROVERS.has(role)) return json(403, { detail: "Only approvers can change the plan." });
  if (p[5] === "draft") return json(200, draft(s, picks));
  if (p[5] === "approve") {
    if (picks.length === 0) return json(422, { detail: "Pick at least one change." });
    const d = draft(s, picks);
    // The roadmap's version is live when the approver decides the roadmap (an owner or its
    // decider), else it waits in review with its decider, as the API's _roadmap_follows.
    const live = role !== "approver";
    const was = shift(PROJECTED, saved(s.picks).days);
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

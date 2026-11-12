/**
 * Simple Goal map (build-goal-map): GET /v1/simple/goal-map and its edits (POST /areas,
 * PUT /areas/order, PATCH /goals/{id}, POST /milestones, PATCH /milestones/{id}, POST
 * /links; goal-ladder: POST /links/move, POST /place-card, DELETE /places), as the API
 * (api/oracle/simple/goal_map.py). Invented data: three goals, a guardrail, four areas,
 * seven gated milestones and twelve features. The "goal-map-hard" scenario
 * (MOCK_SCENARIO_KEY) gives the hard case: 5 areas, 12 milestones, 40 features, one
 * milestone missed, revenue not measured yet. "goal-map-guardrail-goal" gives the goals with
 * their priorities and a goal marked as a guardrail (guardrailGoal). Under "fit-date-company-roadmap" the company roadmap
 * exists next to an older roadmap that still holds goal milestones of its own: only the company
 * roadmap's show (goal_map._on_map). "goal-map-scoreboard" (SCOREBOARD_SCENARIO) gives the
 * scoreboard's cases: sign-ups measured by its metric, conversions tied to a metric with no
 * value yet, revenue with no metric (Daily revenue to pick), and one gate with no feature.
 * Read as the API does (finish): each goal's missing, the gaps, the unplaced roadmap features
 * (each with the goal its item serves) and each link's lift from the reading before and after
 * it shipped. goal-map-editing: POST /links/detach, the goals in the one goal order (their
 * Baseline position), a goal in Trash off the map, and the map's milestones as Simple
 * Roadmap's own (PATCH, DELETE to Trash and restore under /v1/simple/roadmap/milestones,
 * routeLadderMilestone). Invented people, products and numbers only.
 */
import type { Schemas } from "@/lib/api/client";
import { CURRENCY_SIGNS, goalFigure } from "@/lib/goal-figure";
import { goalName } from "@/lib/placeholders";

import type { LadderMilestones } from "./simple-changes";
import type { TrashDb, TrashEntryRow } from "./trash";

import { FIT_COMPANY_SCENARIO } from "./fit-date";
import { LADDER_KR_CODES_SCENARIO, LADDER_KR_SCENARIO, LADDER_SCENARIO, LADDER_TRACK_OWNER_SCENARIO, LADDER_TWINS_SCENARIO, ladderMap } from "./goal-ladder";
import { GM_TRACKS_HARD_SCENARIO, isTracksScenario, tracksMap } from "./goal-map-tracks";
import { stableUuid } from "./ids";
import { codedTitle, shownCode, shownTitle } from "./item-code";
import { COMPANY_SLUG } from "./one-roadmap";
import { canEditRoadmap, type SimpleDb } from "./simple-roadmap";

export type GoalMap = Schemas["GoalMapOut"];
export type GmGoal = Schemas["GmGoal"];
export type GmArea = Schemas["GmArea"];
export type GmMilestone = Schemas["GmMilestone"];
export type GmFeature = Schemas["GmFeature"];
export type GmGuardrail = Schemas["GmGuardrail"];
export type GmStatus = GmMilestone["status"];
export type GmLift = GmFeature["lift"];
export type GmLink = Schemas["GmLink"];
export type GmMetricChoice = Schemas["GmMetricChoice"];

export const SCOREBOARD_SCENARIO = "goal-map-scoreboard";
/** The scoreboard scenario's names, for its specs. */
export const SCOREBOARD = { measured: "Weekly sign-ups", empty: "Paid conversions", pick: "Daily revenue", gap: "6 paid conversions per rep", offMap: "Cut early churn" } as const;
/** The day a metric's weekly value lands on as the goal's reading (the week's last day). */
const READ_ON = "Nov 1";

/** The mock's ids: stable UUIDs, as the API's. */
const id = (k: string) => stableUuid(`goal-map/${k}`);
/** The API id the mock gives a short name (goal-ladder's goals are Baseline goals with it). */
export const goalMapIdOf = id;
/**
 * one-feature-panel: each feature is its own Simple roadmap item ("gm-f1", ...), as the API's map
 * reads the roadmap's items, so its item panel opens on it (server.ts adds the items: goalMapItems).
 */
const ITEM_OF = new Map<string, string>();
const fid = (k: string) => {
  if (!/^f\d+$/.test(k)) return id(k);
  const uid = stableUuid(`simple-item/gm-${k}`);
  ITEM_OF.set(uid, `gm-${k}`);
  return uid;
};
// Known before any map is seeded (a map read back from storage names them too).
for (let n = 1; n <= 70; n++) fid(`f${n}`);
/** The roadmap items the map's features are: key, id, name and the PRD section that gives its code (F-101, ...). */
export const goalMapItems = (map: GoalMap): { key: string; id: string; title: string; section: string }[] =>
  map.features.flatMap((f) => {
    const key = ITEM_OF.get(f.id);
    return key ? [{ key, id: f.id, title: f.name, section: `f-${100 + Number(key.slice(4))}` }] : [];
  });

/**
 * pre-demo QA P-6: each feature's goal as its panel reads it (service._ladder_goals): the goal of
 * a milestone it serves, the first in the goal order (the map's own), with its measure and target.
 */
export function goalMapGoals(map: GoalMap, entities: { id: string; key: string; attrs?: Record<string, unknown> | null }[]): Record<string, Schemas["SimpleGoalRef"]> {
  const out: Record<string, Schemas["SimpleGoalRef"]> = {};
  const goalOf = new Map(map.milestones.map((m) => [m.id, m.goal]));
  for (const f of map.features) {
    const served = new Set(f.milestones.map((m) => goalOf.get(m)));
    const g = map.goals.find((x) => served.has(x.id));
    if (!g) continue;
    const e = entities.find((x) => x.id === g.id);
    const a = e?.attrs ?? {};
    const metric = typeof a.metric === "string" && a.metric ? a.metric : g.measure || null;
    const unit = g.unit || "";
    const target = unit === "%" ? `${g.target}%` : `${g.target} ${unit}`.trim();
    out[f.id] = { id: g.id, key: e?.key ?? g.id, title: g.name, metric, position: typeof a.position === "number" ? a.position : null, target, due: null, current: null, unit: unit || null };
  }
  return out;
}

const GOALS: GmGoal[] = [
  {
    id: "signups",
    name: "Sign-ups per rep per day",
    measure: "sign-ups per rep per day",
    target: 40,
    current: 31,
    unit: "",
    status: "on_track",
    math: "Each rep's daily sign-ups",
    builds_on: [],
    history: [
      { date: "Oct 30, 2026", text: "Target 30 → 40", by: "Dana Whitlock" },
      { date: "Sep 14, 2026", text: "Goal set at 30", by: "Dana Whitlock" },
    ],
    metric: { id: "metric-signups", title: "Weekly sign-ups" },
    missing: null,
    choices: [],
    read_on: READ_ON,
  },
  {
    id: "conversions",
    name: "Paid conversions per rep per day",
    measure: "paid conversions per rep per day",
    target: 10,
    current: 5.6,
    unit: "",
    status: "at_risk",
    math: "Sign-ups per rep × conversion rate (needs 40–65 sign-ups at 15–25%)",
    builds_on: ["signups"],
    history: [{ date: "Oct 2, 2026", text: "Goal set at 10", by: "Dana Whitlock" }],
    metric: { id: "metric-conversions", title: "Paid conversions" },
    missing: null,
    choices: [],
    read_on: READ_ON,
  },
  {
    id: "revenue",
    name: "Revenue per day",
    measure: "revenue per day",
    target: 20000,
    current: 11200,
    unit: "$",
    status: "at_risk",
    math: "Reps × conversions per rep × value",
    builds_on: ["conversions"],
    history: [{ date: "Oct 2, 2026", text: "Goal set at $20k", by: "Dana Whitlock" }],
    metric: { id: "metric-revenue", title: "Daily revenue" },
    missing: null,
    choices: [],
    read_on: READ_ON,
  },
];

const AREAS: GmArea[] = [
  { id: "scale", name: "Scale per rep", lever: "Sign-ups per rep" },
  { id: "safety", name: "Customer safety", lever: "Guardrail: complaints" },
  { id: "conv", name: "Conversions (incl. new channels)", lever: "Conversion rate" },
  { id: "onboard", name: "Onboarding & revenue", lever: "Value per conversion" },
];
const FIFTH: GmArea = { id: "reps", name: "More reps", lever: "Number of reps" };

const GUARDRAIL: GmGuardrail = { name: "Customer complaints", rule: "= 0 every day", current: 0, days: [0, 0, 0, 0, 0, 0, 0], held: true };

const APPROVER = "Dana Whitlock";
/** The map's today ("Nov 3") as a date, as the API's today_on. */
const TODAY_ON = "2026-11-03";
const by = ["Priya Okafor", "Marco Lindqvist", "Dana Whitlock", "Sam Ferreira"];

/** goal-ladder: a milestone's due date itself (the last day of its month), as the API's due_on. */
function dueOn(month: string): string {
  const i = MONTH_NAMES.indexOf(month);
  const year = i >= 9 ? 2026 : 2027;
  return new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10);
}
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ms(
  id: string,
  name: string,
  goal: string,
  threshold: number,
  current: number | null,
  status: GmStatus,
  areas: string[],
  depends: string[],
  month: string,
  unit = GOALS.find((g) => g.id === goal)!.unit,
): GmMilestone {
  const wiggle = [0.04, 0.01, 0.05, 0.02, 0.06, 0.03, 0.05];
  const days =
    current === null
      ? [null, null, null, null, null, null, null]
      : status === "met"
        ? wiggle.map((w, i) => Math.round(Math.max(threshold, current * (0.94 + w + i * 0.005)) * 10) / 10)
        : Array.from({ length: 7 }, (_, i) => Math.round(current * (1 - (6 - i) * 0.02 + wiggle[i] / 4) * 10) / 10);
  return {
    id,
    name,
    goal,
    measure: GOALS.find((g) => g.id === goal)!.measure,
    threshold,
    unit,
    current,
    status,
    areas,
    depends,
    month,
    due: `${month} ${({ Oct: 31, Nov: 30, Dec: 31, Jan: 31, Feb: 28 } as Record<string, number>)[month] ?? 30}`,
    due_on: dueOn(month),
    days,
    confirmed: status === "met" ? by[id.length % by.length] : null,
    confirmed_on: status === "met" ? "Nov 2" : null,
    proposed: false,
    can_change: false,
  };
}

const MILESTONES: GmMilestone[] = [
  ms("m1", "25 sign-ups per rep", "signups", 25, 31, "met", ["scale"], [], "Oct"),
  ms("m2", "50 sign-ups per rep", "signups", 50, 31, "on_track", ["scale", "onboard"], ["m1"], "Nov"),
  ms("m3", "3 paid conversions per rep", "conversions", 3, 5.6, "met", ["conv"], ["m1"], "Oct"),
  ms("m4", "6 paid conversions per rep", "conversions", 6, 5.6, "at_risk", ["conv", "safety"], ["m3"], "Nov"),
  ms("m5", "$12k revenue per day", "revenue", 12000, 11200, "on_track", ["onboard"], ["m3"], "Nov", "$"),
  ms("m6", "10 paid conversions per rep", "conversions", 10, 5.6, "at_risk", ["conv", "onboard"], ["m4"], "Dec"),
  ms("m7", "$20k revenue per day", "revenue", 20000, 11200, "at_risk", ["onboard", "scale"], ["m6"], "Jan"),
];

function ft(
  id: string,
  name: string,
  area: string,
  milestones: string[],
  lever: string,
  expected: string,
  confidence: GmFeature["confidence"],
  lift: GmLift,
  measured: string | null,
  released = lift !== "not_measured" || measured !== null,
): GmFeature {
  return { id, name, code: "", area, milestones, lever, expected, confidence, released, measured, lift, links: milestones.map((m) => link(m, expected, confidence, measured, lift)) };
}

/** A link as seeded: a feature that helped or not shipped on Oct 20; its readings are set by finish(). */
function link(milestone: string, expected: string, confidence: GmFeature["confidence"], measured: string | null, lift: GmLift): GmLink {
  return { milestone, expected, confidence, measured, lift, shipped_on: lift === "not_measured" ? null : "Oct 20", before: null, after: null };
}

const FEATURES: GmFeature[] = [
  ft("f1", "One-tap sign-up link", "scale", ["m1"], "Sign-ups per rep", "+6 a day", "High", "helping", "+8 a day"),
  ft("f2", "Rep call script hints", "scale", ["m2"], "Sign-ups per rep", "+5 a day", "Medium", "not_helping", "+0 a day"),
  ft("f3", "Lead list ranking", "scale", ["m2"], "Sign-ups per rep", "+7 a day", "Medium", "not_measured", null, false),
  ft("f4", "Complaint early warning", "safety", ["m4"], "Guardrail", "0 complaints", "High", "helping", "0 complaints, 21 days"),
  ft("f5", "Refund in one step", "safety", ["m4"], "Guardrail", "0 complaints", "Medium", "not_measured", null, false),
  ft("f6", "Trial reminder texts", "conv", ["m3"], "Conversion rate", "+3 points", "High", "helping", "+4 points"),
  ft("f7", "Partner referral channel", "conv", ["m4", "m6"], "Conversion rate", "+4 points", "Low", "not_measured", null, false),
  ft("f8", "Pricing page test", "conv", ["m4"], "Conversion rate", "+2 points", "Medium", "not_helping", "−1 point"),
  ft("f9", "Guided first week", "onboard", ["m2", "m5"], "Value per conversion", "+$40 each", "Medium", "helping", "+$55 each"),
  // Linked to $20k first: its card, under $12k, shows what it is expected to do there (+$90), not for $20k.
  { ...ft("f10", "Annual plan offer", "onboard", ["m7", "m5"], "Value per conversion", "+$60 each", "Low", "not_measured", null, false), links: [
    link("m7", "+$60 each", "Low", null, "not_measured"),
    link("m5", "+$90 each", "Medium", null, "not_measured"),
  ] },
  ft("f11", "Team invite at sign-up", "onboard", ["m7"], "Value per conversion", "+$30 each", "Medium", "not_measured", null, false), // serves the revenue milestone
  ft("f12", "Rep daily scoreboard", "scale", ["m7"], "Sign-ups per rep", "+3 a day", "Medium", "not_measured", null, false),
];

/** The hard case: 5 areas, 12 milestones, 40 features, one milestone missed, one goal not measured yet. */
function hard(): GoalMap {
  const goals: GmGoal[] = GOALS.map((g) => ({ ...g, history: [...g.history] }));
  goals[2] = { ...goals[2], current: null, status: "not_measured", metric: { id: "metric-revenue-weekly", title: "Weekly revenue" } };
  const areas = [...AREAS, FIFTH];
  const extra: GmMilestone[] = [
    ms("m8", "75 sign-ups per rep", "signups", 75, 31, "on_track", ["scale", "reps"], ["m2"], "Dec"),
    ms("m9", "100 sign-ups per rep", "signups", 100, 31, "on_track", ["scale", "reps"], ["m8"], "Feb"),
    ms("m10", "8 paid conversions per rep", "conversions", 8, 5.6, "missed", ["conv"], ["m3"], "Oct"),
    ms("m11", "12 reps live", "signups", 12, 9, "on_track", ["reps"], [], "Nov"),
    ms("m12", "$30k revenue per day", "revenue", 30000, null, "not_measured", ["onboard", "reps"], ["m7"], "Feb", "$"),
  ];
  extra[4].days = extra[4].days.map(() => null);
  extra[3].measure = "reps live";
  extra[3].days = [8, 8, 9, 9, 9, 9, 9];
  const milestones = [...MILESTONES.map((m) => ({ ...m })), ...extra];
  for (const m of milestones) if (m.goal === "revenue" && !m.proposed) {
    m.current = null;
    m.days = m.days.map(() => null);
    m.status = "not_measured";
  }
  const names = [
    "Call queue autopilot", "Shared rep notes", "Smart follow-up timer", "Lead source tags", "Voice memo sign-up",
    "Quiet hours for calls", "Do-not-call check", "Plain cancel button", "Complaint reply in 1 hour", "Calm reminders",
    "Two-step checkout", "Chat channel trial", "Local-language pages", "Win-back offer", "Price in local money",
    "Welcome call booking", "Setup in 10 minutes", "Usage nudges", "Upgrade at day 20", "Family plan",
    "Rep hiring page", "New rep training", "Rep buddy system", "Territory planner", "Rep target board",
    "Weekend sign-up desk", "Sign-up kiosk mode", "Faster ID check",
  ];
  const areaFor = ["scale", "scale", "scale", "conv", "scale", "safety", "safety", "safety", "safety", "safety", "conv", "conv", "conv", "conv", "conv", "onboard", "onboard", "onboard", "onboard", "onboard", "reps", "reps", "reps", "reps", "reps", "scale", "scale", "reps"];
  const leverOf: Record<string, [string, string]> = {
    scale: ["Sign-ups per rep", "+2 a day"],
    safety: ["Guardrail", "0 complaints"],
    conv: ["Conversion rate", "+1 point"],
    onboard: ["Value per conversion", "+$20 each"],
    reps: ["Number of reps", "+1 rep"],
  };
  const measuredOf: Record<string, [string, string]> = {
    scale: ["+3 a day", "+0 a day"],
    safety: ["0 complaints, 14 days", "1 complaint"],
    conv: ["+2 points", "+0 points"],
    onboard: ["+$30 each", "+$0 each"],
    reps: ["+2 reps", "+0 reps"],
  };
  const msFor: Record<string, string[]> = {
    scale: ["m2", "m8", "m7"],
    safety: ["m4"],
    conv: ["m10", "m6", "m4"],
    onboard: ["m5", "m7", "m12"],
    reps: ["m11", "m8", "m12"],
  };
  const lifts: GmLift[] = ["helping", "not_measured", "not_helping", "not_measured", "helping", "not_measured", "not_measured"];
  const more = names.map((name, i) => {
    const area = areaFor[i];
    const lift = lifts[i % lifts.length];
    const list = msFor[area];
    return ft(
      `h${i}`,
      name,
      area,
      [list[i % list.length]],
      leverOf[area][0],
      leverOf[area][1],
      (["High", "Medium", "Low"] as const)[i % 3],
      lift,
      lift === "helping" ? measuredOf[area][0] : lift === "not_helping" ? measuredOf[area][1] : null,
      lift !== "not_measured" || i % 2 === 0,
    );
  });
  return { goals, areas, guardrail: GUARDRAIL, milestones, features: [...FEATURES.map((f) => ({ ...f, links: f.links.map((l) => ({ ...l })) })), ...more], gaps: [], unplaced: [], off_map: [], today: "Nov 3", today_on: TODAY_ON, reps: 9, approver: APPROVER, can_edit: true, places: [] };
}

function plain(): GoalMap {
  return {
    goals: GOALS.map((g) => ({ ...g, history: [...g.history] })),
    areas: [...AREAS],
    guardrail: GUARDRAIL,
    milestones: MILESTONES.map((m) => ({ ...m })),
    features: FEATURES.map((f) => ({ ...f, links: f.links.map((l) => ({ ...l })) })),
    gaps: [],
    unplaced: [],
    off_map: [],
    today: "Nov 3",
    today_on: TODAY_ON,
    reps: 10,
    approver: APPROVER,
    can_edit: true,
    places: [],
  };
}

/** The data above with the API's ids (UUIDs) in place of its short names. */
function withIds(map: GoalMap): GoalMap {
  const fe = (k: string) => fid(k);
  return {
    ...map,
    goals: map.goals.map((g) => ({ ...g, id: id(g.id), builds_on: g.builds_on.map(id), metric: g.metric ? { ...g.metric, id: id(g.metric.id) } : null, choices: g.choices.map((c) => ({ ...c, id: id(c.id) })) })),
    areas: map.areas.map((a) => ({ ...a, id: id(a.id) })),
    milestones: map.milestones.map((m) => ({ ...m, id: id(m.id), goal: id(m.goal), areas: m.areas.map(id), depends: m.depends.map(id) })),
    features: map.features.map((f) => ({ ...f, id: fe(f.id), area: f.area ? id(f.area) : null, milestones: f.milestones.map(id), links: f.links.map((l) => ({ ...l, milestone: id(l.milestone) })) })),
  };
}

/** A goal milestone added on the roadmap with no gate yet (no threshold). */
function noGate(): GoalMap {
  const map = plain();
  const m = ms("m8", "Sign-ups at every rep", "signups", 0, 31, "no_gate", ["scale"], ["m2"], "Dec");
  map.milestones.push({ ...m, threshold: null, confirmed: null, confirmed_on: null });
  return map;
}

/** The "goal-map-guardrail-goal" scenario's guardrail: a goal marked as a guardrail, no constraint. */
export const GUARDRAIL_GOAL = "Account restrictions";

/**
 * The company's goals with their priorities (attrs.position) and a goal marked as a guardrail,
 * read as the API does (goal_map._goals and build): the cards in the one goal order, the
 * guardrail goal never a card but the strip's guardrail while no guardrail constraint is set.
 */
function guardrailGoal(): GoalMap {
  const map = plain();
  const place: Record<string, number> = { revenue: 1, signups: 3, conversions: 4 };
  const every = [
    ...map.goals.map((g) => ({ g, position: place[g.id], guardrail: false })),
    { g: { ...map.goals[0], id: "restrictions", name: GUARDRAIL_GOAL, measure: "account restrictions", target: 0, current: 0, math: "", history: [] }, position: 2, guardrail: true },
  ].sort((a, b) => a.position - b.position);
  map.goals = every.filter((x) => !x.guardrail).map((x) => x.g);
  map.guardrail = { name: GUARDRAIL_GOAL, rule: "= 0 every day", current: 0, days: [0, 0, 0, 0, 0, 0, 0], held: true };
  return map;
}

/** Goal milestones only an older roadmap holds: history once the company roadmap exists. */
export const OLDER_MILESTONES = ["15 sign-ups per rep", "$8k revenue per day"];

/**
 * one-roadmap-many-prds: the map's milestones on the company roadmap, the older roadmap's beside
 * them; the map reads the roadmaps that feed Simple alone (company.feeding_ids), the company's.
 */
function companyRoadmap(): GoalMap {
  const map = plain();
  const older = [
    ms("old1", OLDER_MILESTONES[0], "signups", 15, 31, "met", ["scale"], [], "Sep"),
    ms("old2", OLDER_MILESTONES[1], "revenue", 8000, 11200, "met", ["onboard"], ["old1"], "Sep", "$"),
  ];
  const on = [...map.milestones.map((m) => ({ m, roadmap: COMPANY_SLUG })), ...older.map((m) => ({ m, roadmap: "help-desk-roadmap" }))];
  map.milestones = on.filter((x) => x.roadmap === COMPANY_SLUG).map((x) => x.m);
  return map;
}

/**
 * The scoreboard's cases: sign-ups measured by its metric; conversions tied to a metric with no
 * value yet; revenue with no metric and Daily revenue (no goal yet) to pick; one gate
 * ("6 paid conversions per rep") whose areas have no feature.
 */
function scoreboard(): GoalMap {
  const map = plain();
  const [, conv, rev] = map.goals;
  Object.assign(conv, { current: null, status: "not_measured" });
  Object.assign(rev, { current: null, status: "not_measured", metric: null, choices: [{ id: "metric-daily-revenue", title: SCOREBOARD.pick, last: 11200 }] });
  conv.choices = [];
  for (const m of map.milestones)
    if (m.goal !== "signups") Object.assign(m, { current: null, days: m.days.map(() => null), status: "not_measured", confirmed: null, confirmed_on: null });
  // Its features move under the next gate: m4 keeps no feature.
  map.features = map.features.map((f) => {
    if (!f.milestones.includes("m4")) return f;
    const ms = f.milestones.includes("m6") ? f.milestones.filter((x) => x !== "m4") : f.milestones.map((x) => (x === "m4" ? "m6" : x));
    return { ...f, milestones: ms, links: ms.map((x) => ({ ...(f.links.find((l) => l.milestone === x) ?? f.links[0]), milestone: x })) };
  });
  // m6 pulls conversions alone (its feature is there); m4 (conversions and safety) has none.
  map.milestones.find((m) => m.id === "m6")!.areas = ["conv"];
  return map;
}

/** A shipped feature's reading before it shipped: lower when it helped, the same when not. */
function seedReadings(map: GoalMap): void {
  const cur = (m: string) => map.goals.find((g) => g.id === map.milestones.find((x) => x.id === m)?.goal)?.current ?? null;
  for (const f of map.features)
    for (const l of f.links) {
      const c = cur(l.milestone);
      if (l.shipped_on && c !== null && l.lift !== "not_measured") l.before = l.lift === "helping" ? Math.round(c * 8) / 10 : c;
    }
}

export function seedGoalMap(scenario: string | null): GoalMap {
  const map =
    scenario === "goal-map-hard" ? hard() : scenario === "goal-map-no-gate" ? noGate() : scenario === "goal-map-guardrail-goal" ? guardrailGoal() : scenario === FIT_COMPANY_SCENARIO ? companyRoadmap() : scenario === SCOREBOARD_SCENARIO ? scoreboard() : scenario === LADDER_SCENARIO || scenario === LADDER_TRACK_OWNER_SCENARIO ? ladderMap() : scenario === LADDER_KR_SCENARIO ? ladderMap(true) : scenario === LADDER_KR_CODES_SCENARIO ? ladderMap(true, true) : scenario === LADDER_TWINS_SCENARIO ? ladderMap(false, false, true) : isTracksScenario(scenario) ? tracksMap(scenario === GM_TRACKS_HARD_SCENARIO, scenario) : plain();
  seedReadings(map);
  return withIds(map);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A Baseline goal as the map reads it (goal_map._goals): one store, the same ids. */
export type BaselineGoal = { id: string; key: string; title: string; status: string; attrs: Record<string, unknown> };

/**
 * The scoreboard's goals as Baseline goals (the API reads the same Entity rows): the map's three,
 * same ids, each with its number to aim at.
 */
export function scoreboardGoals(): BaselineGoal[] {
  return GOALS.map((g, i) => ({ id: id(g.id), key: `g.${g.id}`, title: g.name, status: "confirmed", attrs: { metric: g.measure, target: g.target, unit: g.unit, math: g.math, position: i + 1 } }));
}

/** The one goal order (goal_order.goal_sort_key): a Baseline position first, by position; the rest after, as they were. */
function inGoalOrder(goals: GmGoal[], baseline: BaselineGoal[]): GmGoal[] {
  const pos = (g: GmGoal) => {
    const v = baseline.find((x) => x.id === g.id)?.attrs.position;
    return typeof v === "number" && v >= 1 ? v : Infinity;
  };
  return goals.map((g, i) => ({ g, i })).sort((a, b) => pos(a.g) - pos(b.g) || a.i - b.i).map((x) => x.g);
}

/** As the API reads them (goal_map.build): each goal's missing, each link's lift from its readings, the gaps, the unplaced features and the goals left off the map. */
function finish(map: GoalMap, items: { id: string; title: string; code?: string | null; status: string; goal?: { id: string } | null }[], baseline: BaselineGoal[]): GoalMap {
  const goalOf = (m: string) => map.goals.find((g) => g.id === map.milestones.find((x) => x.id === m)?.goal);
  for (const g of map.goals) {
    g.missing = g.current !== null ? null : g.metric ? "values" : "metric";
    if (g.current === null) g.read_on = null;
    // One store: a goal that is a Baseline goal reads its name from it.
    const e = baseline.find((x) => x.id === g.id);
    if (e) {
      g.name = goalName(e.title, e.key);
      if (typeof e.attrs.target === "number") g.target = e.attrs.target;
    }
  }
  for (const f of map.features) {
    for (const l of f.links) {
      const c = goalOf(l.milestone)?.current ?? null;
      if (c === null) Object.assign(l, { before: null, after: null, lift: "not_measured" });
      else if (l.shipped_on && l.before !== null) Object.assign(l, { after: c, lift: c > l.before ? "helping" : "not_helping" });
    }
    f.lift = f.links[0]?.lift ?? f.lift;
  }
  const gaps: GoalMap["gaps"] = [];
  for (const m of map.milestones) {
    const cells = new Set(map.features.filter((f) => f.milestones.includes(m.id)).map((f) => f.area));
    if (m.areas.length) gaps.push(...m.areas.filter((a) => map.areas.some((x) => x.id === a) && !cells.has(a)).map((a) => ({ milestone: m.id, area: a })));
    else if (!cells.size) gaps.push({ milestone: m.id, area: null });
  }
  const placed = new Set(map.features.map((f) => f.id));
  // goal-map-editing: each with the goal its item serves (goal_map._unplaced).
  const unplaced = items.filter((i) => !["draft", "cut", "merged"].includes(i.status) && !placed.has(i.id)).map((i) => ({ id: i.id, name: i.title, goal: i.goal?.id ?? null, code: i.code ?? "" }));
  const onMap = new Set(map.goals.map((g) => g.id));
  // Confirmed goals with no number to aim at, never a guardrail (goal_map.build's off_map).
  const off_map = baseline
    .filter((e) => e.status === "confirmed" && !onMap.has(e.id) && typeof e.attrs.target !== "number" && !e.attrs.guardrail)
    .map((e) => ({ id: e.id, key: e.key, name: goalName(e.title, e.key) }));
  return { ...map, goals: inGoalOrder(map.goals, baseline), gaps, unplaced, off_map };
}

function goalStatus(current: number | null, target: number): GmStatus {
  if (current === null) return "not_measured";
  if (current >= target) return "met";
  return current >= 0.75 * target ? "on_track" : "at_risk";
}

/** A gate read again from its goal's days (goal_map.gate_status). */
function gateStatus(m: GmMilestone, today: string): GmStatus {
  if (m.threshold === null) return "no_gate";
  if (m.current === null) return "not_measured";
  if (m.days.every((v) => v !== null && v >= m.threshold!)) return "met";
  const [mon, day] = (m.due ?? "").split(" ");
  const [tm, td] = today.split(" ");
  if (m.due && MONTHS.indexOf(mon) * 40 + Number(day) < MONTHS.indexOf(tm) * 40 + Number(td) && MONTHS.indexOf(mon) >= 9) return "missed";
  return m.current >= 0.75 * m.threshold ? "on_track" : "at_risk";
}

/** As the API orders them: by what each comes after, then as added. */
function ordered(milestones: GmMilestone[]): GmMilestone[] {
  const by = new Map(milestones.map((m) => [m.id, m]));
  const depth = (m: GmMilestone, seen: Set<string> = new Set()): number => {
    const up = m.depends[0] ? by.get(m.depends[0]) : undefined;
    return !up || seen.has(up.id) ? 0 : 1 + depth(up, new Set([...seen, m.id]));
  };
  return milestones.map((m, i) => ({ m, i, d: depth(m) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.m);
}

/** The milestone picked to come after: on the map, never itself or one after it. */
function afterOf(map: GoalMap, m: GmMilestone | null, after: string | null): GmMilestone | null | Response {
  if (!after) return null;
  const up = map.milestones.find((x) => x.id === after);
  if (!up) return json(422, { detail: "Pick a milestone it comes after" });
  for (let step: GmMilestone | undefined = up, n = 0; m && step && n < 100; step = map.milestones.find((x) => x.id === step!.depends[0]), n++)
    if (step.id === m.id) return json(422, { detail: "A milestone cannot come after one that comes after it" });
  return up;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DAY_WORDS = "Nov 3, 2026";

/** As the API's goal_map.amount (goal-figure-words): "$20,000", "1,200 shops"; a count to one decimal. */
function amount(v: number, unit: string): string {
  return goalFigure(CURRENCY_SIGNS[unit.trim().toLowerCase()] ? v : Math.round(v * 10) / 10, unit);
}

/**
 * Who changes a roadmap's milestone directly, as the API's drafts.can_edit: an owner; the roadmap's
 * decider; with no decider, its track owner while an approver (the mock has no track owners, so an
 * approver reads false until a decider is set: db.goal_map_decider).
 */
export function mayChangeMilestone(me: { id?: string; role: string }, decider: string | null | undefined, trackOwner = false): boolean {
  if (me.role === "owner") return true;
  if (decider) return me.id === decider;
  return trackOwner && me.role === "approver";
}

/** milestone-rename: the map's milestones are its roadmap's own (TrackMilestone rows in the API): while
 * the Simple roadmap reads them (map_milestones), who changes that roadmap changes them (drafts.can_edit),
 * as its other milestones; else as mayChangeMilestone. */
type MapRightsDb = { goal_map_decider?: string | null; simple_roadmap?: SimpleDb };
export function mapCanChange(db: MapRightsDb, me: { id?: string; role: string }): boolean {
  const on = db.simple_roadmap?.map_milestones?.roadmap;
  if (db.goal_map_decider || !on || !me.id) return mayChangeMilestone(me, db.goal_map_decider);
  return me.role !== "viewer" && me.role !== "commenter" && canEditRoadmap(db.simple_roadmap!, on, { id: me.id, role: me.role as Schemas["Me"]["role"] });
}

/** /v1/simple/goal-map and its edits; null for any other path. Edits need approver and up. */
export async function routeGoalMap(
  db: { goal_map?: GoalMap; goal_map_decider?: string | null; goal_map_places?: Record<string, Record<string, [number, number]>>; simple_roadmap?: SimpleDb },
  scenario: string | null,
  me: { role: string; name: string; id?: string },
  req: Request,
  p: string[],
  /** A Simple roadmap item by id (any item can be attached, not only those on the map). */
  item: (id: string) => { title: string; section?: string | null; feature_id?: string | null; trashed?: boolean; merged_into?: string } | null = () => null,
  /** The Simple roadmap's items as the reader sees them (the unplaced features). */
  items: () => Promise<{ id: string; title: string; code?: string | null; status: string }[]> = async () => [],
  /** The Baseline goals (the goals left off the map; the map's own goal names). */
  baseline: () => BaselineGoal[] = () => [],
  /** goal-map-editing: whether a goal is in Trash (its milestones and their links leave the map). */
  goalTrashed: (id: string) => boolean = () => false,
): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "goal-map") return null;
  const map = (db.goal_map ??= seedGoalMap(scenario));
  const canEdit = me.role === "owner" || me.role === "approver";
  // goal-ladder place_card: each person's own places of cards, for features on the map and (Free
  // canvas) the unplaced ones.
  const mine = ((db.goal_map_places ??= {})[me.id ?? me.name] ??= {});
  // trash-features-goals: a feature in Trash is off the map (and so is its place); goal-map-editing:
  // so is a goal in Trash, a milestone in Trash or of such a goal, and a link to one of them.
  const live = () => {
    const goals = map.goals.filter((g) => !goalTrashed(g.id));
    // goal_map._on_map: a PRD's milestone only while its plan holds it, as the roadmap reads it.
    const milestones = map.milestones.filter((m) => !(m as Held).trashed && !(m as Held).out_of_plan && goals.some((g) => g.id === m.goal)).map((m) => {
        const { trashed, prd, prd_code, out_of_plan, ...rest } = m as Held;
        void [trashed, prd, prd_code, out_of_plan];
        return { ...rest, can_change: mapCanChange(db, me) };
      });
    const on = new Set(milestones.map((m) => m.id));
    // panel-menu (goal_map.build): a feature merged into another is no longer one of the map's.
    const features = map.features.filter((f) => !item(f.id)?.trashed && !item(f.id)?.merged_into).flatMap((f) => {
      const links = f.links.filter((l) => on.has(l.milestone));
      // QA goal map codes: its item's name as the roadmap reads it, without a leading code of its own.
      const it = item(f.id);
      const fc = (k: string) => db.simple_roadmap?.feature_codes?.[k];
      const name = it ? shownTitle(it, fc) : codedTitle(f.name, null)[1];
      // Its code as the roadmap reads it (GmFeature.code; "" for none).
      const code = (it ? shownCode(it, fc) : codedTitle(f.name, null)[0]) ?? "";
      return links.length ? [{ ...f, name, code, milestones: f.milestones.filter((m) => on.has(m)), links }] : [];
    });
    return { goals, milestones, features };
  };
  const read = async () => finish({ ...map, ...live(), can_edit: canEdit }, await items(), baseline());
  // goal_map.build's places: of a feature on the map or (Free canvas) an unplaced one.
  const carded = (m: GoalMap) => new Set([...m.features, ...m.unplaced].map((f) => f.id));
  const out = async () => {
    const m = await read();
    const on = carded(m);
    return json(200, { ...m, places: Object.entries(mine).flatMap(([feature, [x, y]]) => (on.has(feature) ? [{ feature, x, y }] : [])) });
  };
  if (req.method === "GET" && !p[3]) return out();
  const body = JSON.parse((await req.text()) || "null");
  if (req.method === "POST" && p[3] === "place-card") {
    // Viewers too: a place is the person's own view and never changes data.
    // Free canvas (goal_map.place_card): an unplaced feature is placed too; an unknown id or one in Trash is not.
    if (!carded(await read()).has(body?.feature)) return json(404, { detail: "No such feature on the map" });
    if (body.x == null || body.y == null) delete mine[body.feature];
    else mine[body.feature] = [Number(body.x), Number(body.y)];
    return out();
  }
  if (req.method === "DELETE" && p[3] === "places") {
    for (const k of Object.keys(mine)) delete mine[k];
    return out();
  }
  if (!canEdit) return json(403, { detail: "Only owners and approvers can change the goal map" });
  if (req.method === "POST" && p[3] === "links" && p[4] === "move") return moveMapLink(map, body ?? {}) ?? out();
  if (req.method === "POST" && p[3] === "links" && p[4] === "detach") {
    // goal-map-editing: the feature no longer serves the milestone (goal_map.detach).
    const f = map.features.find((x) => x.id === body?.feature);
    if (!f || !f.milestones.includes(body?.milestone)) return json(404, { detail: "No such feature on that milestone" });
    f.milestones = f.milestones.filter((m) => m !== body.milestone);
    f.links = f.links.filter((l) => l.milestone !== body.milestone);
    if (!f.milestones.length) map.features = map.features.filter((x) => x !== f);
    return out();
  }
  if (req.method === "POST" && p[3] === "areas" && !p[4]) {
    const name = String(body?.name ?? "").trim();
    if (!name) return json(422, { detail: "Name the area" });
    map.areas.push({ id: crypto.randomUUID(), name, lever: String(body?.lever ?? "").trim() });
    return out();
  }
  if (req.method === "PUT" && p[3] === "areas" && p[4] === "order") {
    const ids: string[] = body?.ids ?? [];
    const by = new Map(map.areas.map((a) => [a.id, a]));
    if (ids.length !== by.size || new Set(ids).size !== ids.length || ids.some((x) => !by.has(x))) return json(422, { detail: "Send every area once, in the new order" });
    map.areas = ids.map((x) => by.get(x)!);
    return out();
  }
  if (req.method === "POST" && p[3] === "goals" && p[4] && p[5] === "metric") {
    const g = map.goals.find((x) => x.id === p[4]);
    if (!g) return json(404, { detail: "No such goal" });
    const c = g.choices.find((x) => x.id === body?.metric);
    // A metric the company does not have: 404, as the API (goal_map.pick_metric).
    const known = map.goals.some((x) => x.metric?.id === body?.metric || x.choices.some((y) => y.id === body?.metric));
    if (!known) return json(404, { detail: "No such metric" });
    if (!c) return json(422, { detail: "Pick an output metric in the goal's unit" });
    // The goal's old metric lets go: it can be picked again.
    const old = g.metric ? [{ ...g.metric, last: null }] : [];
    g.metric = { id: c.id, title: c.title };
    for (const x of map.goals) x.choices = x.choices.filter((y) => y.id !== c.id);
    g.choices.push(...old);
    if (c.last !== null) {
      // Its weekly value becomes the goal's reading (on the week's last day, Nov 1).
      g.current = c.last;
      g.read_on = READ_ON;
      g.status = goalStatus(c.last, g.target);
      for (const m of map.milestones.filter((x) => x.goal === g.id)) {
        Object.assign(m, { current: c.last, days: [null, null, null, null, c.last, null, null] });
        m.status = gateStatus(m, map.today);
      }
    }
    return out();
  }
  if (req.method === "PATCH" && p[3] === "goals" && p[4]) {
    const g = map.goals.find((x) => x.id === p[4]);
    if (!g) return json(404, { detail: "No such goal" });
    const t = Number(body?.target);
    if (!(t > 0)) return json(422, { detail: "The target must be above 0" });
    g.history = [{ date: DAY_WORDS, text: `Target ${amount(g.target, g.unit)} → ${amount(t, g.unit)}`, by: me.name }, ...g.history];
    g.target = t;
    // One store: the Baseline goal's number moves with it.
    const e = baseline().find((x) => x.id === g.id);
    if (e) e.attrs = { ...e.attrs, target: t };
    return out();
  }
  if (req.method === "POST" && p[3] === "milestones") {
    const g = map.goals.find((x) => x.id === body?.goal);
    if (!g) return json(422, { detail: "Pick a goal" });
    const name = String(body?.name ?? "").trim();
    if (!(Number(body?.threshold) > 0)) return json(422, { detail: "The threshold must be above 0" });
    // Not sent: it comes after the goal's last milestone.
    const after = body && "after" in body ? afterOf(map, null, body.after) : [...map.milestones].reverse().find((m) => m.goal === g.id) ?? null;
    if (after instanceof Response) return after;
    const areas: string[] = body?.areas ?? [];
    if (areas.some((a) => !map.areas.some((x) => x.id === a))) return json(422, { detail: "Pick areas of this map" });
    if (map.milestones.some((m) => m.name === name)) return json(409, { detail: "A milestone with this name is already on the roadmap" });
    const days = DAYS_BACK.map((i) => (g.current === null ? null : Math.round((g.current - i * 0.6) * 10) / 10));
    map.milestones.push({
      id: crypto.randomUUID(), name, goal: g.id, measure: g.measure, threshold: Number(body?.threshold), unit: g.unit, current: g.current,
      status: g.current === null ? "not_measured" : "on_track", areas, depends: after ? [after.id] : [], month: "Nov", due: null, due_on: null, days, confirmed: null, confirmed_on: null, proposed: true, can_change: false,
    });
    map.milestones = ordered(map.milestones);
    return out();
  }
  if (req.method === "PATCH" && p[3] === "milestones" && p[4]) {
    const m = map.milestones.find((x) => x.id === p[4]);
    if (!m) return json(404, { detail: "No such milestone" });
    if (body?.threshold != null && !(Number(body.threshold) > 0)) return json(422, { detail: "The threshold must be above 0" });
    if (body && "after" in body) {
      const after = afterOf(map, m, body.after);
      if (after instanceof Response) return after;
      m.depends = after ? [after.id] : [];
    }
    if (body?.threshold != null) {
      if (m.threshold === null) Object.assign(m, { status: m.current === null ? "not_measured" : "on_track", proposed: !m.confirmed });
      m.threshold = Number(body.threshold);
    }
    if (body?.confirm) {
      if (m.threshold === null) return json(422, { detail: "Set a threshold before confirming the gate" });
      Object.assign(m, { confirmed: me.name, confirmed_on: "Nov 3", proposed: false });
    }
    map.milestones = ordered(map.milestones);
    return out();
  }
  if (req.method === "POST" && p[3] === "links") return attachMapLink(map, body ?? {}, item) ?? out();
  return json(404, { detail: "Not found" });
}

/** goal_map.attach (POST /links): a feature put on a milestone in an area's cell; null when done. */
export function attachMapLink(
  map: GoalMap,
  body: { feature?: unknown; milestone?: unknown; area?: unknown; expected?: unknown; confidence?: unknown },
  item: (id: string) => { title: string } | null,
): Response | null {
  const m = map.milestones.find((x) => x.id === body.milestone);
  const known = map.features.find((x) => x.id === body.feature);
  const it = known ? null : item(String(body.feature));
  if (!m || (!known && !it)) return json(404, { detail: "No such feature or milestone" });
  const area = map.areas.find((a) => a.id === body.area);
  if (!area) return json(422, { detail: "Pick an area of this map" });
  const expected = String(body.expected ?? "").trim();
  const confidence = ({ high: "High", medium: "Medium", low: "Low" } as const)[body.confidence as "high" | "medium" | "low"] ?? "Medium";
  const link: GmLink = { milestone: m.id, expected, confidence, measured: null, lift: "not_measured", shipped_on: null, before: null, after: null };
  if (known) {
    if (!known.milestones.includes(m.id)) {
      known.milestones.push(m.id);
      known.links.push(link);
    }
    // A feature sits in one area: attached from another area's cell, it moves there.
    Object.assign(known, { area: area.id, lever: area.lever });
  } else {
    map.features.push({ id: String(body.feature), name: it!.title, code: "", area: area.id, milestones: [m.id], lever: area.lever, expected, confidence, released: false, measured: null, lift: "not_measured", links: [link] });
  }
  return null;
}

/** goal_map.move_link (POST /links/move): a feature's link moved to another milestone (onto one it
 * serves: the old link goes); null when done. */
export function moveMapLink(map: GoalMap, body: { feature?: unknown; from_milestone?: unknown; to_milestone?: unknown }): Response | null {
  const f = map.features.find((x) => x.id === body.feature);
  const to = map.milestones.find((x) => x.id === body.to_milestone);
  const from = String(body.from_milestone ?? "");
  if (!f || !to || !f.milestones.includes(from)) return json(404, { detail: "No such feature or milestone" });
  if (from !== to.id) {
    if (f.milestones.includes(to.id)) {
      f.milestones = f.milestones.filter((m) => m !== from);
      f.links = f.links.filter((l) => l.milestone !== from);
    } else {
      f.milestones = f.milestones.map((m) => (m === from ? to.id : m));
      f.links = f.links.map((l) => (l.milestone === from ? { ...l, milestone: to.id } : l));
    }
  }
  return null;
}

/**
 * A map milestone as the db keeps it: `trashed` while it is in Settings › Trash; a PRD's own (`prd`,
 * its plan's code `prd_code`; `out_of_plan` once the PRD's plan no longer holds it: the roadmap
 * read leaves it out, goal_milestones.list_for_roadmaps).
 */
type Held = GmMilestone & { trashed?: boolean; prd?: { id: string; slug: string; title: string }; prd_code?: string; out_of_plan?: boolean };

/** goal_milestones.put_back (trash.goal_in_trash): a milestone whose goal is in Trash is not restored,
 * by its own restore or Trash's (409); the words say which goal to restore first. Null: it may come back. */
export function milestoneGoalInTrash(db: { goal_map?: GoalMap } & MapRightsDb, milestoneId: string): string | null {
  const m = db.goal_map?.milestones.find((x) => x.id === milestoneId);
  const g = m && db.simple_roadmap?.goal_buckets?.goals.find((x) => x.id === m.goal && x.trashed);
  return g ? `Its goal ${goalName(g.title, g.key)} is in Trash: restore the goal first` : null;
}

/** goal-map-editing (trash.service.delete_milestone): a map milestone goes to Settings › Trash. */
function trashMapMilestone(m: Held, me: { id: string; name: string }, trash: TrashDb, at: string): void {
  m.trashed = true;
  const row: TrashEntryRow = {
    out: {
      id: crypto.randomUUID(),
      root: { type: "milestone", id: m.id, slug: null, title: m.name, kind: "Milestone", code: null, features: null, meeting: null },
      items: [], deleted_by: me.id, deleted_by_name: me.name, deleted_at: at, reason: null,
      published: false, purge_after: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
    },
    documents: [], versions: [], runs: [], intakes: [],
  };
  trash.entries.push(row);
}

/**
 * goal-map-editing: the map's milestones are Simple Roadmap's own goal milestones (one record in
 * the API, track_milestones): PATCH (its goal, name or date), DELETE to Settings › Trash and
 * POST .../restore under /v1/simple/roadmap/milestones/{id}, as goal_milestones.py. Who may
 * change the roadmap (an owner here) does it; others get the API's 403. Null for any other id.
 */
export async function routeLadderMilestone(
  db: { goal_map?: GoalMap } & MapRightsDb,
  me: { id: string; role: string; name: string },
  req: Request,
  p: string[],
  trash: TrashDb,
  now: () => string,
): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "roadmap" || p[3] !== "milestones" || !p[4] || !db.goal_map) return null;
  const map = db.goal_map;
  const m = map.milestones.find((x) => x.id === p[4]) as Held | undefined;
  if (!m) return null;
  const out = (status = 200) =>
    json(status, { id: m.id, roadmap_id: id("roadmap"), code: "", name: m.name, date: m.due_on ?? null, goal_id: m.goal, item_ids: [], counts_when: "", progress: "not_started", prd: null, prd_owner: null, pending: null, can_change: mapCanChange(db, me), can_propose: !mapCanChange(db, me) && me.role !== "viewer", carried_from: null });
  if (!mapCanChange(db, me)) return json(403, { detail: "Only an owner or the roadmap's decider (with none, its owner) changes its milestones" });
  if (req.method === "POST" && p[5] === "restore") {
    if (!m.trashed) return json(404, { detail: "No such deleted milestone" });
    const refused = milestoneGoalInTrash(db, m.id);
    if (refused) return json(409, { detail: refused });
    m.trashed = false;
    trash.entries = trash.entries.filter((e) => !(e.out.root.type === "milestone" && e.out.root.id === m.id));
    return out();
  }
  if (m.trashed || p[5]) return json(404, { detail: "No such milestone" });
  if (req.method === "DELETE" && m.prd) return json(409, { detail: "A PRD's milestone is not deleted here" });
  if (req.method === "DELETE") {
    trashMapMilestone(m, me, trash, now());
    return new Response(null, { status: 204 });
  }
  if (req.method === "PATCH") {
    const body = JSON.parse((await req.text()) || "{}") as { goal_id?: string | null; name?: string; date?: string | null };
    if ("goal_id" in body) {
      const g = map.goals.find((x) => x.id === body.goal_id);
      if (!g) return json(422, { detail: "goal_id: a goal" });
      Object.assign(m, { goal: g.id, measure: g.measure, unit: g.unit });
    }
    if (body.name) m.name = body.name;
    if ("date" in body) m.due_on = body.date ?? null;
    return out();
  }
  return json(405, { detail: "Method not allowed" });
}

/**
 * every-field-editable: the map's key results as Simple's change engine reads them (an
 * edit_goal_milestone proposal names one, as goal_milestones._value; the decider accepts it).
 */
/** roadmap-milestone-codes: the map's live milestones as its roadmap's goal milestones (the API's are one record), each with its goal's place in the map's order. */
export function goalMapMilestones(map: GoalMap): { id: string; name: string; date: string | null; goal_id: string; rank: number; code?: string; prd?: { id: string; slug: string; title: string } }[] {
  const rank = new Map(map.goals.map((g, n) => [g.id, n]));
  return (map.milestones as Held[])
    .filter((m) => !m.trashed && !m.out_of_plan)
    .map((m) => ({ id: m.id, name: m.name, date: m.due_on ?? null, goal_id: m.goal, rank: rank.get(m.goal) ?? map.goals.length, ...(m.prd ? { code: m.prd_code ?? "", prd: m.prd } : {}) }));
}

export function ladderMilestones(db: { goal_map?: GoalMap } & MapRightsDb, me: { id: string; role: string; name?: string }, trash?: TrashDb, at?: () => string): LadderMilestones {
  const live = (id: string) => (db.goal_map?.milestones as Held[] | undefined)?.find((x) => x.id === id && !x.trashed);
  // milestone-rename: a proposal on one is its roadmap's, sent to that roadmap's decider.
  const on = db.simple_roadmap?.map_milestones?.roadmap ?? null;
  return {
    find: (id) => {
      const m = live(id);
      if (!m) return null;
      const decider = db.goal_map_decider ?? (on ? db.simple_roadmap?.deciders?.[on] : null) ?? null;
      return { value: { name: m.name, date: m.due_on ?? null, goal_id: m.goal, item_ids: [], counts_when: "" }, can_change: mapCanChange(db, me), name: m.name, decider, roadmap: on };
    },
    // milestone-rename: an accepted proposal's name, date and goal.
    write: (id, after) => {
      const m = live(id);
      if (!m) return;
      // An accepted removal sends it to Trash, as the decider's own Move to Trash does.
      if (after === null) {
        if (trash) trashMapMilestone(m, { id: me.id, name: me.name ?? "" }, trash, at ? at() : new Date().toISOString());
        else m.trashed = true;
        return;
      }
      if (typeof after.name === "string" && after.name.trim()) m.name = after.name.trim();
      if ("date" in after) m.due_on = (after.date as string | null) ?? null;
      const g = db.goal_map?.goals.find((x) => x.id === after.goal_id);
      if (g) Object.assign(m, { goal: g.id, measure: g.measure, unit: g.unit });
    },
    links: db.goal_map ? mapLinks(db, db.goal_map, live) : undefined,
  };
}

/** goal-map-link-asks (oracle.simple.goal_map_asks): the map's links as a link_goal_map change
 * reads them, and the Goal map's own attach and move (POST /links, /links/move) to apply one. */
function mapLinks(db: MapRightsDb, map: GoalMap, live: (id: string) => Held | undefined): NonNullable<LadderMilestones["links"]> {
  const item = (id: string) => {
    const rm = db.simple_roadmap;
    const key = rm && Object.keys(rm.ids).find((k) => rm.ids[k] === id);
    return rm?.items.find((i) => i.key === key) ?? null;
  };
  return {
    feature: (id) => {
      const f = map.features.find((x) => x.id === id);
      if (f) return { title: f.name, milestones: [...f.milestones], area: f.area };
      const it = item(id);
      return it && !it.trashed ? { title: it.title, milestones: [], area: null } : null;
    },
    milestone: (id) => {
      const m = live(id);
      return m ? { name: m.name, areas: m.areas.filter((a) => map.areas.some((x) => x.id === a)) } : null;
    },
    firstArea: () => map.areas[0]?.id ?? null,
    attach: (feature, milestone, area) => attachMapLink(map, { feature, milestone, area }, item),
    move: (feature, from, to) => moveMapLink(map, { feature, from_milestone: from, to_milestone: to }),
  };
}

/** Days back from today for a new milestone's 7 readings, oldest first. */
const DAYS_BACK = [6, 5, 4, 3, 2, 1, 0];

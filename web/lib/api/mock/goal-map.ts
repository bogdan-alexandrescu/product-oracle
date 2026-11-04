/**
 * Simple Goal map (build-goal-map): GET /v1/simple/goal-map and its edits (POST /areas,
 * PUT /areas/order, PATCH /goals/{id}, POST /milestones, PATCH /milestones/{id}, POST
 * /links), as the API
 * (api/oracle/simple/goal_map.py). Invented data: three goals, a guardrail, four areas,
 * seven gated milestones and twelve features. The "goal-map-hard" scenario
 * (MOCK_SCENARIO_KEY) gives the hard case: 5 areas, 12 milestones, 40 features, one
 * milestone missed, revenue not measured yet. Invented people, products and numbers only.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";

export type GoalMap = Schemas["GoalMapOut"];
export type GmGoal = Schemas["GmGoal"];
export type GmArea = Schemas["GmArea"];
export type GmMilestone = Schemas["GmMilestone"];
export type GmFeature = Schemas["GmFeature"];
export type GmGuardrail = Schemas["GmGuardrail"];
export type GmStatus = GmMilestone["status"];
export type GmLift = GmFeature["lift"];

/** The mock's ids: stable UUIDs, as the API's. */
const id = (k: string) => stableUuid(`goal-map/${k}`);
/** The Simple roadmap items the first features are (so their item panel opens). */
const ITEM_KEYS = ["alert-rules", "alert-digest", "alert-mobile", "alert-export", "alert-sso", "setup-checklist", "setup-import", "setup-tour", "setup-video", "setup-ideas"];
const fid = (k: string) => {
  const n = Number(k.slice(1));
  return k.startsWith("f") && n <= ITEM_KEYS.length ? stableUuid(`simple-item/${ITEM_KEYS[n - 1]}`) : id(k);
};

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
const by = ["Priya Okafor", "Marco Lindqvist", "Dana Whitlock", "Sam Ferreira"];

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
    days,
    confirmed: status === "met" ? by[id.length % by.length] : null,
    confirmed_on: status === "met" ? "Nov 2" : null,
    proposed: false,
  };
}

const MILESTONES: GmMilestone[] = [
  ms("m1", "25 sign-ups per rep", "signups", 25, 31, "met", ["scale"], [], "Oct"),
  ms("m2", "50 sign-ups per rep", "signups", 50, 31, "on_track", ["scale", "onboard"], ["m1"], "Nov"),
  ms("m3", "3 paid conversions per rep", "conversions", 3, 5.6, "met", ["conv"], ["m1"], "Oct"),
  ms("m4", "6 paid conversions per rep", "conversions", 6, 5.6, "at_risk", ["conv", "safety"], ["m3"], "Nov"),
  ms("m5", "$12k revenue per day", "revenue", 12000, 11200, "on_track", ["onboard"], ["m3"], "Nov", "$"),
  ms("m6", "10 paid conversions per rep", "conversions", 10, 5.6, "at_risk", ["conv", "onboard"], ["m2", "m4"], "Dec"),
  ms("m7", "$20k revenue per day", "revenue", 20000, 11200, "at_risk", ["onboard", "scale"], ["m5", "m6"], "Jan"),
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
  return { id, name, area, milestones, lever, expected, confidence, released, measured, lift, links: milestones.map((m) => ({ milestone: m, expected, confidence, measured, lift })) };
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
  ft("f10", "Annual plan offer", "onboard", ["m5", "m7"], "Value per conversion", "+$90 each", "Low", "not_measured", null, false),
  ft("f11", "Team invite at sign-up", "onboard", ["m7"], "Value per conversion", "+$30 each", "Medium", "not_measured", null, false), // serves the revenue milestone
  ft("f12", "Rep daily scoreboard", "scale", ["m7"], "Sign-ups per rep", "+3 a day", "Medium", "not_measured", null, false),
];

/** The hard case: 5 areas, 12 milestones, 40 features, one milestone missed, one goal not measured yet. */
function hard(): GoalMap {
  const goals: GmGoal[] = GOALS.map((g) => ({ ...g, history: [...g.history] }));
  goals[2] = { ...goals[2], current: null, status: "not_measured" };
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
  return { goals, areas, guardrail: GUARDRAIL, milestones, features: [...FEATURES, ...more], today: "Nov 3", reps: 9, approver: APPROVER, can_edit: true };
}

function plain(): GoalMap {
  return {
    goals: GOALS.map((g) => ({ ...g, history: [...g.history] })),
    areas: [...AREAS],
    guardrail: GUARDRAIL,
    milestones: MILESTONES.map((m) => ({ ...m })),
    features: FEATURES.map((f) => ({ ...f })),
    today: "Nov 3",
    reps: 10,
    approver: APPROVER,
    can_edit: true,
  };
}

/** The data above with the API's ids (UUIDs) in place of its short names. */
function withIds(map: GoalMap): GoalMap {
  const fe = (k: string) => fid(k);
  return {
    ...map,
    goals: map.goals.map((g) => ({ ...g, id: id(g.id), builds_on: g.builds_on.map(id) })),
    areas: map.areas.map((a) => ({ ...a, id: id(a.id) })),
    milestones: map.milestones.map((m) => ({ ...m, id: id(m.id), goal: id(m.goal), areas: m.areas.map(id), depends: m.depends.map(id) })),
    features: map.features.map((f) => ({ ...f, id: fe(f.id), area: f.area ? id(f.area) : null, milestones: f.milestones.map(id), links: f.links.map((l) => ({ ...l, milestone: id(l.milestone) })) })),
  };
}

export function seedGoalMap(scenario: string | null): GoalMap {
  return withIds(scenario === "goal-map-hard" ? hard() : plain());
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DAY_WORDS = "Nov 3, 2026";

function amount(v: number, unit: string): string {
  if (unit === "$") return v >= 1000 ? `$${Math.round(v / 100) / 10}k` : `$${v}`;
  return `${Math.round(v * 10) / 10}`;
}

/** /v1/simple/goal-map and its edits; null for any other path. Edits need approver and up. */
export async function routeGoalMap(
  db: { goal_map?: GoalMap },
  scenario: string | null,
  me: { role: string; name: string },
  req: Request,
  p: string[],
  /** A Simple roadmap item by id (any item can be attached, not only those on the map). */
  item: (id: string) => { title: string } | null = () => null,
): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "goal-map") return null;
  const map = (db.goal_map ??= seedGoalMap(scenario));
  const canEdit = me.role === "owner" || me.role === "approver";
  const out = () => json(200, { ...map, can_edit: canEdit });
  if (req.method === "GET" && !p[3]) return out();
  if (!canEdit) return json(403, { detail: "Only owners and approvers can change the goal map" });
  const body = JSON.parse((await req.text()) || "null");
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
  if (req.method === "PATCH" && p[3] === "goals" && p[4]) {
    const g = map.goals.find((x) => x.id === p[4]);
    if (!g) return json(404, { detail: "No such goal" });
    const t = Number(body?.target);
    if (!(t > 0)) return json(422, { detail: "The target must be above 0" });
    g.history = [{ date: DAY_WORDS, text: `Target ${amount(g.target, g.unit)} → ${amount(t, g.unit)}`, by: me.name }, ...g.history];
    g.target = t;
    return out();
  }
  if (req.method === "POST" && p[3] === "milestones") {
    const g = map.goals.find((x) => x.id === body?.goal);
    if (!g) return json(422, { detail: "Pick a goal" });
    const name = String(body?.name ?? "").trim();
    if (map.milestones.some((m) => m.name === name)) return json(409, { detail: "A milestone with this name is already on the track" });
    const after = body?.after ? map.milestones.find((m) => m.id === body.after) : undefined;
    if (body?.after && !after) return json(422, { detail: "Pick a milestone it comes after" });
    const days = DAYS_BACK.map((i) => (g.current === null ? null : Math.round((g.current - i * 0.6) * 10) / 10));
    map.milestones.push({
      id: crypto.randomUUID(), name, goal: g.id, measure: g.measure, threshold: Number(body?.threshold), unit: g.unit, current: g.current,
      status: g.current === null ? "not_measured" : "on_track", areas: body?.areas ?? [], depends: after ? [after.id] : [], month: "Nov", due: null, days, confirmed: null, confirmed_on: null, proposed: true,
    });
    return out();
  }
  if (req.method === "PATCH" && p[3] === "milestones" && p[4]) {
    const m = map.milestones.find((x) => x.id === p[4]);
    if (!m) return json(404, { detail: "No such milestone" });
    if (body?.threshold != null) m.threshold = Number(body.threshold);
    if (body?.confirm) Object.assign(m, { confirmed: me.name, confirmed_on: "Nov 3", proposed: false });
    return out();
  }
  if (req.method === "POST" && p[3] === "links") {
    const m = map.milestones.find((x) => x.id === body?.milestone);
    const known = map.features.find((x) => x.id === body?.feature);
    const it = known ? null : item(String(body?.feature));
    if (!m || (!known && !it)) return json(404, { detail: "No such feature or milestone" });
    const area = map.areas.find((a) => a.id === body?.area);
    if (!area) return json(422, { detail: "Pick an area of this map" });
    const expected = String(body?.expected ?? "").trim();
    const confidence = ({ high: "High", medium: "Medium", low: "Low" } as const)[body?.confidence as "high" | "medium" | "low"] ?? "Medium";
    const link = { milestone: m.id, expected, confidence, measured: null, lift: "not_measured" as const };
    if (known) {
      if (!known.milestones.includes(m.id)) {
        known.milestones.push(m.id);
        known.links.push(link);
      }
      known.area ??= area.id;
    } else {
      map.features.push({ id: String(body.feature), name: it!.title, area: area.id, milestones: [m.id], lever: area.lever, expected, confidence, released: false, measured: null, lift: "not_measured", links: [link] });
    }
    return out();
  }
  return json(404, { detail: "Not found" });
}

/** Days back from today for a new milestone's 7 readings, oldest first. */
const DAYS_BACK = [6, 5, 4, 3, 2, 1, 0];

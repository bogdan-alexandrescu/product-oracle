/**
 * Goal buckets in Simple Priorities (api/oracle/simple/goal_buckets.py): the goals in order with
 * their measure, target and date, each feature's goal links (the one it moves most first), and
 * adding, editing and archiving a goal or moving a feature, each with Undo. Seeded from the
 * plan's invented goals and features.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";
import { planGoalNames, planSlices } from "./simple-plan";

type Goal = { id: string; title: string; order: number; measure: string | null; target: string | null; due: string | null; archived: boolean };
type Feature = { id: string; key: string; title: string; goal_ids: string[] };
export type GoalBucketsDb = { goals: Goal[]; features: Feature[] };
type Undo = Schemas["GoalBucketsUndo"];

/** Invented measures for the plan's goals. */
const MEASURES: Record<string, [string, string, string]> = {
  Reliability: ["Setups that finish without an error", "99.9%", "2027-02-12"],
  Growth: ["Weekly active teams", "600 teams", "2027-02-12"],
  Activation: ["Teams that finish setup in a day", "65%", "2027-01-29"],
  Revenue: ["Monthly recurring revenue", "$20,000", "2027-02-26"],
};

export function seedGoalBuckets(): GoalBucketsDb {
  const goals = planGoalNames().map((title, i) => {
    const [measure, target, due] = MEASURES[title] ?? [null, null, null];
    return { id: stableUuid(`goal-bucket/${title}`), title, order: i + 1, measure, target, due, archived: false };
  });
  const features: Feature[] = [];
  for (const s of planSlices()) {
    if (features.some((f) => f.key === s.feature_code)) continue;
    const goal = goals.find((g) => g.title === s.goal);
    features.push({ id: stableUuid(`feature-bucket/${s.feature_code}`), key: s.feature_code, title: s.name.replace(/, part \d+ of \d+$/, ""), goal_ids: goal ? [goal.id] : [] });
  }
  // One feature serves a second goal too, so its row reads "+1 goal".
  const second = features.find((f) => f.key === "F-14");
  const growth = goals.find((g) => g.title === "Growth");
  if (second && growth && !second.goal_ids.includes(growth.id)) second.goal_ids.push(growth.id);
  return { goals, features };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function out(db: GoalBucketsDb, edits: boolean): Schemas["GoalBucketsOut"] {
  const live = db.goals.filter((g) => !g.archived);
  const ids = new Set(live.map((g) => g.id));
  return {
    can_edit: edits,
    goals: live.map((g) => ({ id: g.id, title: g.title, order: g.order, measure: g.measure, target: g.target, due: g.due, can_edit: edits })),
    features: db.features.map((f) => ({ id: f.id, key: f.key, title: f.title, goal_ids: f.goal_ids.filter((g) => ids.has(g)) })),
  };
}

const goalOut = (g: Goal): Schemas["GoalBucketGoal"] => ({ id: g.id, title: g.title, order: g.order, measure: g.measure, target: g.target, due: g.due, can_edit: true });
const goalSnap = (g: Goal) => ({ id: g.id, title: g.title, status: g.archived ? "rejected" : "confirmed", attrs: { metric: g.measure, target_text: g.target, due: g.due, position: g.order } });
// The mock keeps links in order: the snapshot's contribution is 3 for the first, then 2.
const featureSnap = (f: Feature) => ({ feature_id: f.id, links: f.goal_ids.map((goal_id, i) => ({ goal_id, contribution: i ? 2 : 3 })) });

type GoalIn = { title?: string; measure?: string; target?: string; due?: string };
const complete = (b: GoalIn) => !!(b.title?.trim() && b.measure?.trim() && b.target?.trim() && b.due && /^\d{4}-\d{2}-\d{2}$/.test(b.due));

/** /v1/simple/goal-buckets... (as the API: approvers and owners write; anyone reads). */
export async function routeGoalBuckets(simple: { goal_buckets?: GoalBucketsDb }, role: string, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "goal-buckets") return null;
  const db = (simple.goal_buckets ??= seedGoalBuckets());
  const edits = role === "owner" || role === "approver";
  const m = req.method;
  if (!p[3] && m === "GET") return json(200, out(db, edits));
  if (!edits) return json(403, { detail: "Requires the approver role" });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (p[3] === "goals" && !p[4] && m === "POST") {
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const order = Math.max(0, ...db.goals.map((g) => g.order)) + 1;
    const g: Goal = { id: crypto.randomUUID(), title: b.title!.trim(), order, measure: b.measure!.trim(), target: b.target!.trim(), due: b.due!, archived: false };
    db.goals.push(g);
    return json(201, { goal: goalOut(g), undo: { goals: [], features: [], added_goal_id: g.id } });
  }
  if (p[3] === "goals" && p[4] && !p[5] && m === "PATCH") {
    const g = db.goals.find((x) => x.id === p[4] && !x.archived);
    if (!g) return json(404, { detail: "No such goal" });
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const undo = { goals: [goalSnap(g)], features: [], added_goal_id: null };
    Object.assign(g, { title: b.title!.trim(), measure: b.measure!.trim(), target: b.target!.trim(), due: b.due! });
    return json(200, { goal: goalOut(g), undo });
  }
  if (p[3] === "goals" && p[5] === "archive" && m === "POST") {
    const g = db.goals.find((x) => x.id === p[4] && !x.archived);
    if (!g) return json(404, { detail: "No such goal" });
    const to = (body.to_goal_id as string | null | undefined) ?? null;
    if (to && !db.goals.some((x) => x.id === to && !x.archived && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
    const held = db.features.filter((f) => f.goal_ids.includes(g.id));
    const undo = { goals: [goalSnap(g)], features: held.map(featureSnap), added_goal_id: null };
    for (const f of held) {
      const rest = f.goal_ids.filter((x) => x !== g.id);
      f.goal_ids = f.goal_ids[0] === g.id && !rest.length && to ? [to] : rest;
    }
    g.archived = true;
    return json(200, { goal: null, undo });
  }
  if (p[3] === "features" && p[5] === "move" && m === "POST") {
    const f = db.features.find((x) => x.id === p[4]);
    const to = body.to_goal_id as string;
    if (!f) return json(404, { detail: "No such feature" });
    if (!db.goals.some((x) => x.id === to)) return json(404, { detail: "No such goal" });
    const undo = { goals: [], features: [featureSnap(f)], added_goal_id: null };
    f.goal_ids = [to, ...f.goal_ids.filter((x) => x !== to && x !== body.from_goal_id)];
    return json(200, { goal: null, undo });
  }
  if (p[3] === "undo" && m === "POST") {
    const u = body as unknown as Undo;
    for (const s of u.goals ?? []) {
      const g = db.goals.find((x) => x.id === s.id);
      if (!g) continue;
      const a = s.attrs as Record<string, string | number | null>;
      Object.assign(g, { title: s.title, archived: s.status === "rejected", measure: a.metric ?? null, target: a.target_text ?? null, due: a.due ?? null });
    }
    for (const s of u.features ?? []) {
      const f = db.features.find((x) => x.id === s.feature_id);
      if (f) f.goal_ids = [...s.links].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).map((l) => l.goal_id);
    }
    if (u.added_goal_id) {
      const g = db.goals.find((x) => x.id === u.added_goal_id);
      if (g) g.archived = true;
    }
    return json(200, out(db, edits));
  }
  return null;
}

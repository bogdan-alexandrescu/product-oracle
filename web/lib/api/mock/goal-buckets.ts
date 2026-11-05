/**
 * Goal buckets in Simple Priorities (api/oracle/simple/goal_buckets.py): the goals in order with
 * their measure, target and date, each feature's goal links (the one it moves most first), and
 * adding, editing and archiving a goal or moving a feature, each with Undo. Seeded from the
 * plan's invented goals and features.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";
import { planGoalNames, planSlices } from "./simple-plan";
import { roadmapGoal, roadmapGoalKey, type RoadmapGoalFields } from "./simple-roadmap";

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
  // Some features serve a second goal too, so their rows read "+1 goal" (mk-goalbuckets gb1-a-result:
  // one in each of the first two buckets, and Plan limits in Revenue, then Growth).
  const alsoServes: [string, string][] = [["F-14", "Growth"], ["F-06", "Activation"], ["F-05", "Activation"]];
  for (const [key, title] of alsoServes) {
    const feature = features.find((f) => f.key === key);
    const goal = goals.find((g) => g.title === title);
    if (feature && goal && !feature.goal_ids.includes(goal.id)) feature.goal_ids.push(goal.id);
  }
  return { goals, features };
}

/**
 * GB2 "goal-buckets-hard" (mk-goalbuckets gb2-a-hard): a fifth goal, Grow partner network, holds
 * all 15 of the plan's features that fall only in M2 and M3 (the plan's F-07..F-20 confined to
 * those two, plus F-22, the scenario's extra one), four of which also serve Growth. Invented data.
 */
export function seedGoalBucketsHard(): GoalBucketsDb {
  const base = seedGoalBuckets();
  const bigId = stableUuid("goal-bucket/grow-partner-network");
  const big: Goal = { id: bigId, title: "Grow partner network", order: base.goals.length + 1, measure: "Live partner integrations", target: "40 partners", due: "2027-03-31", archived: false };
  const growth = base.goals.find((g) => g.title === "Growth")!;
  const codes = ["F-07", "F-08", "F-09", "F-10", "F-11", "F-12", "F-13", "F-14", "F-15", "F-16", "F-17", "F-18", "F-19", "F-20", "F-22"];
  const also = new Set(["F-09", "F-12", "F-15", "F-19"]);
  const features = base.features.map((f) => (codes.includes(f.key) ? { ...f, goal_ids: also.has(f.key) ? [bigId, growth.id] : [bigId] } : f));
  if (!features.some((f) => f.key === "F-22")) features.push({ id: stableUuid("feature-bucket/F-22"), key: "F-22", title: "Partner directory listing", goal_ids: [bigId] });
  return { goals: [...base.goals, big], features };
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
// The mock keeps links in order, and Undo puts that order back; each link is snapshotted whole, as the API does.
const featureSnap = (f: Feature) => ({
  feature_id: f.id,
  links: f.goal_ids.map((goal_id, i) => ({ goal_id, contribution: i ? 2 : 3, id: `${f.id}:${goal_id}`, attrs: { contribution: i ? 2 : 3 }, status: "confirmed", origin: "user", created_at: "2026-01-05T00:00:00Z" })),
});
// The API signs each undo and refuses one it did not give; the mock signs with a plain hash of the rest.
const sigOf = (u: Omit<Undo, "sig">) => {
  let h = 2166136261;
  for (const c of JSON.stringify({ goals: u.goals ?? [], features: u.features ?? [], added_goal_id: u.added_goal_id ?? null })) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `mock-${h.toString(16)}`;
};
const signed = (u: Omit<Undo, "sig">): Undo => ({ ...u, sig: sigOf(u) });

type GoalIn = { title?: string; measure?: string; target?: string; due?: string };
const complete = (b: GoalIn) => !!(b.title?.trim() && b.measure?.trim() && b.target?.trim() && b.due && /^\d{4}-\d{2}-\d{2}$/.test(b.due));

/** /v1/simple/goal-buckets... (as the API: approvers and owners write; anyone reads). */
export async function routeGoalBuckets(simple: { goal_buckets?: GoalBucketsDb; goal_edits?: Record<string, RoadmapGoalFields> }, role: string, req: Request, p: string[]): Promise<Response | null> {
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
    return json(201, { goal: goalOut(g), undo: signed({ goals: [], features: [], added_goal_id: g.id }) });
  }
  if (p[3] === "goals" && p[4] && !p[5] && m === "PATCH") {
    const g = db.goals.find((x) => x.id === p[4] && !x.archived);
    // one-feature-panel: a roadmap item's goal is edited here too (the API's one goal entity).
    const key = g ? null : roadmapGoalKey(p[4]);
    if (key) {
      const b = body as GoalIn;
      if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
      const was = roadmapGoal(simple, key);
      const undo = signed({ goals: [{ id: p[4], title: was.title, status: "confirmed", attrs: { metric: was.metric, target_text: was.target, due: was.due } }], features: [], added_goal_id: null });
      const now = { title: b.title!.trim(), metric: b.measure!.trim(), target: b.target!.trim(), due: b.due! };
      (simple.goal_edits ??= {})[key] = now;
      return json(200, { goal: { id: p[4], title: now.title, order: 1, measure: now.metric, target: now.target, due: now.due, can_edit: true }, undo });
    }
    if (!g) return json(404, { detail: "No such goal" });
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const undo = signed({ goals: [goalSnap(g)], features: [], added_goal_id: null });
    Object.assign(g, { title: b.title!.trim(), measure: b.measure!.trim(), target: b.target!.trim(), due: b.due! });
    return json(200, { goal: goalOut(g), undo });
  }
  if (p[3] === "goals" && p[5] === "archive" && m === "POST") {
    const g = db.goals.find((x) => x.id === p[4] && !x.archived);
    if (!g) return json(404, { detail: "No such goal" });
    const to = (body.to_goal_id as string | null | undefined) ?? null;
    if (to && !db.goals.some((x) => x.id === to && !x.archived && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
    const held = db.features.filter((f) => f.goal_ids.includes(g.id));
    const undo = signed({ goals: [goalSnap(g)], features: held.map(featureSnap), added_goal_id: null });
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
    const undo = signed({ goals: [], features: [featureSnap(f)], added_goal_id: null });
    f.goal_ids = [to, ...f.goal_ids.filter((x) => x !== to && x !== body.from_goal_id)];
    return json(200, { goal: null, undo });
  }
  if (p[3] === "undo" && m === "POST") {
    const u = body as unknown as Undo;
    if (!u.sig || u.sig !== sigOf(u)) return json(400, { detail: "This Undo is not one Oracle gave" });
    for (const s of u.goals ?? []) {
      const g = db.goals.find((x) => x.id === s.id);
      const a = s.attrs as Record<string, string | number | null>;
      const key = g ? null : roadmapGoalKey(s.id);
      if (key) (simple.goal_edits ??= {})[key] = { title: s.title, metric: (a.metric as string | null) ?? null, target: (a.target_text as string | null) ?? null, due: (a.due as string | null) ?? null };
      if (!g) continue;
      Object.assign(g, { title: s.title, archived: s.status === "rejected", measure: a.metric ?? null, target: a.target_text ?? null, due: a.due ?? null });
    }
    for (const s of u.features ?? []) {
      const f = db.features.find((x) => x.id === s.feature_id);
      if (f) f.goal_ids = s.links.map((l) => l.goal_id);
    }
    if (u.added_goal_id) {
      const g = db.goals.find((x) => x.id === u.added_goal_id);
      if (g) g.archived = true;
    }
    return json(200, out(db, edits));
  }
  return null;
}

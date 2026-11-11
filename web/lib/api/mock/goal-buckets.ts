/**
 * Goal buckets in Simple Priorities (api/oracle/simple/goal_buckets.py): the goals in order with
 * their measure, target and date, each feature's goal links (the one it moves most first), and
 * adding, editing and archiving a goal or moving a feature, each with Undo. Seeded from the
 * plan's invented goals and features.
 */
import type { Schemas } from "@/lib/api/client";

import { MOCK_SCENARIO_KEY, stableUuid } from "./ids";
import { entryOut, mayRestore, restoreFromTrash, type TrashDb, type TrashEntryRow } from "./trash";
import { planGoalNames, planSlices } from "./simple-plan";
import { GOALS, goalPositionOf, goalRank, goalInTrash, roadmapGoal, roadmapGoalKey, roadmapGoalSeed, writeRoadmapGoal, type RoadmapGoalFields } from "./simple-roadmap";

// trash-features-goals: `trashed` while in Settings › Trash (left out of every read, kept for Restore).
// `key`: the Entity.key the API gives a goal at creation (goal_buckets._slug), named in its Trash entry.
// edit-goals-prds EG1: a goal's owner (a member's id; seeded by email, matched to the member on first read) and when it was archived.
// goal-order: `position`, the place Move up and Move down store on it (attrs.position, as the API's goals).
type Goal = { id: string; key: string; title: string; order: number; measure: string | null; target: string | null; due: string | null; archived: boolean; trashed?: boolean; owner_id?: string | null; owner_email?: string; archived_at?: string | null; position?: number | null; on_roadmap?: boolean };
/** assumed_goal_ids: the links whose contribution is assumed (an approved order's, api ASSUMED_LINK). */
type Feature = { id: string; key: string; title: string; goal_ids: string[]; assumed_goal_ids?: string[] };
/** lazy: the default goals, seeded by the first route that read them rather than by the scenario. */
export type GoalBucketsDb = { goals: Goal[]; features: Feature[]; lazy?: string[] };
type Undo = Schemas["GoalBucketsUndo"];

const keyOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "goal";

/** Invented measures for the plan's goals. */
const MEASURES: Record<string, [string, string, string]> = {
  Reliability: ["Setups that finish without an error", "99.9%", "2027-02-12"],
  Growth: ["Weekly active teams", "600 teams", "2027-02-12"],
  Activation: ["Teams that finish setup in a day", "65%", "2027-01-29"],
  Revenue: ["Monthly recurring revenue", "$20,000", "2027-02-26"],
};

/** Invented owners for the plan's goals: the mock's members, by email. */
const OWNERS: Record<string, string> = {
  Reliability: "approver@example.com",
  Growth: "admin@example.com",
  Activation: "commenter@example.com",
  Revenue: "approver@example.com",
};

/** EG1 (eg1-a-rest): goals archived before, shut in the "Archived goals" fold. Invented. */
const ARCHIVED: [string, string, string][] = [
  ["Cut support tickets in half", "approver@example.com", "2026-10-14T15:00:00Z"],
  ["Launch in two new regions", "commenter@example.com", "2026-09-30T15:00:00Z"],
  ["Faster first report", "admin@example.com", "2026-08-22T15:00:00Z"],
];

export function seedGoalBuckets(): GoalBucketsDb {
  const goals: Goal[] = planGoalNames().map((title, i) => {
    const [measure, target, due] = MEASURES[title] ?? [null, null, null];
    return { id: stableUuid(`goal-bucket/${title}`), key: keyOf(title), title, order: i + 1, measure, target, due, archived: false, owner_email: OWNERS[title] };
  });
  const live = goals.length;
  ARCHIVED.forEach(([title, owner_email, archived_at], i) => {
    goals.push({ id: stableUuid(`goal-bucket/${title}`), key: keyOf(title), title, order: live + i + 1, measure: null, target: null, due: null, archived: true, owner_email, archived_at });
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
  // Sample data import joined from an approved order naming its goal with no contribution: assumed until a person sets it.
  const sample = features.find((f) => f.key === "F-02");
  if (sample) sample.assumed_goal_ids = sample.goal_ids.slice(0, 1);
  return { goals, features };
}

/**
 * GB2 "goal-buckets-hard" (mk-goalbuckets gb2-a-hard): a fifth goal, Grow partner network, holds
 * all 15 of the plan's features that fall only in M2 and M3 (the plan's F-07..F-20 confined to
 * those two, plus F-22, the scenario's extra one), four of which also serve Growth. Invented data.
 */
/** The default goals for a route that reads them first; the roadmap's goal targets leave them out (lazy), so a
 * roadmap read is the same before and after another page seeds them. */
export function lazyGoalBuckets(): GoalBucketsDb {
  const db = seedGoalBuckets();
  return { ...db, lazy: db.goals.map((g) => g.id) };
}

export function seedGoalBucketsHard(): GoalBucketsDb {
  const base = seedGoalBuckets();
  const bigId = stableUuid("goal-bucket/grow-partner-network");
  const big: Goal = { id: bigId, key: keyOf("Grow partner network"), title: "Grow partner network", order: base.goals.filter((g) => !g.archived).length + 1, measure: "Live partner integrations", target: "40 partners", due: "2027-03-31", archived: false, owner_email: "viewer@example.com" };
  const growth = base.goals.find((g) => g.title === "Growth")!;
  const codes = ["F-07", "F-08", "F-09", "F-10", "F-11", "F-12", "F-13", "F-14", "F-15", "F-16", "F-17", "F-18", "F-19", "F-20", "F-22"];
  const also = new Set(["F-09", "F-12", "F-15", "F-19"]);
  const features = base.features.map((f) => (codes.includes(f.key) ? { ...f, goal_ids: also.has(f.key) ? [bigId, growth.id] : [bigId] } : f));
  if (!features.some((f) => f.key === "F-22")) features.push({ id: stableUuid("feature-bucket/F-22"), key: "F-22", title: "Partner directory listing", goal_ids: [bigId] });
  return { goals: [...base.goals, big], features };
}

/**
 * The goal buckets as the API lists them for a roadmap's company: every live goal (the plan's, then
 * the roadmap's own, by name: Grow retention, ...) and every feature with an item, the plan's and
 * the roadmap's, each linked to the goals its item serves. Drafts are no feature yet. Invented data.
 */
export function seedGoalBucketsWith(
  base: GoalBucketsDb,
  goalNames: string[],
  items: { key: string; title: string; goals: string[] }[],
): GoalBucketsDb {
  const goals = [...base.goals];
  const goalOf = (name: string): string => {
    let g = goals.find((x) => x.title.toLowerCase() === name.toLowerCase());
    if (!g) {
      // One goal store: a roadmap goal's bucket starts from its measure, target and date.
      const seed = roadmapGoalSeed(keyOf(name));
      g = { id: stableUuid(`goal-bucket/${name}`), key: keyOf(name), title: name, order: goals.filter((x) => !x.archived).length + 1, measure: seed.metric, target: seed.target, due: seed.due, archived: false };
      goals.push(g);
    }
    return g.id;
  };
  for (const name of goalNames) goalOf(name);
  const features = [...base.features];
  for (const i of items) {
    if (features.some((f) => f.key.toLowerCase() === i.key.toLowerCase())) continue;
    features.push({ id: stableUuid(`feature-bucket/${i.key}`), key: i.key, title: i.title, goal_ids: [...new Set(i.goals.map(goalOf))] });
  }
  return { goals, features };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The members a goal's owner is one of, and who the company's owners are (an ask goes to them). */
export type GoalPeople = { id: string; name: string; email: string; role: string; disabled?: boolean }[];

function out(db: GoalBucketsDb, edits: boolean, people: GoalPeople = []): Schemas["GoalBucketsOut"] {
  // goal-order: the goals in the one goal order, as the API lists them (the Ground Truth's, then the rest as they were).
  const live = db.goals.filter((g) => !g.archived && !g.trashed).sort((a, b) => goalRank(orderKey(a)) - goalRank(orderKey(b)));
  const ids = new Set(live.map((g) => g.id));
  const archived = db.goals.filter((g) => g.archived && !g.trashed).sort((a, b) => ((a.archived_at ?? "") < (b.archived_at ?? "") ? 1 : -1));
  return {
    can_edit: edits,
    goals: live.map((g) => ({ ...goalOut(g, people), can_edit: edits })),
    features: db.features.map((f) => ({ id: f.id, key: f.key, title: f.title, goal_ids: f.goal_ids.filter((g) => ids.has(g)), assumed_goal_ids: (f.assumed_goal_ids ?? []).filter((g) => ids.has(g)) })),
    archived: archived.map((g) => ({ id: g.id, title: g.title, owner_name: nameOf(people, g.owner_id), archived_at: g.archived_at ?? null })),
    asks_to: people.filter((x) => x.role === "owner" && !x.disabled).map((x) => x.name),
  };
}

const nameOf = (people: GoalPeople, id: string | null | undefined) => (id ? (people.find((x) => x.id === id)?.name ?? null) : null);
const goalOut = (g: Goal, people: GoalPeople = []): Schemas["GoalBucketGoal"] => ({ id: g.id, title: g.title, order: goalPositionOf(orderKey(g)) ?? g.order, measure: g.measure, target: g.target, due: g.due, can_edit: true, owner_id: g.owner_id ?? null, owner_name: nameOf(people, g.owner_id), on_roadmap: g.on_roadmap ?? true });
const goalSnap = (g: Goal) => ({ id: g.id, title: g.title, status: g.archived ? "rejected" : "confirmed", attrs: { metric: g.measure, target_text: g.target, due: g.due, position: g.order, owner: g.owner_id ?? null, archived_at: g.archived_at ?? null }, on_roadmap: g.on_roadmap ?? true });
// The mock keeps links in order, and Undo puts that order back; each link is snapshotted whole, as the API does.
const featureSnap = (f: Feature) => ({
  feature_id: f.id,
  links: f.goal_ids.map((goal_id, i) => {
    const attrs = f.assumed_goal_ids?.includes(goal_id) ? { contribution: 1, contribution_assumed: true } : { contribution: i ? 2 : 3 };
    return { goal_id, contribution: attrs.contribution, id: `${f.id}:${goal_id}`, attrs, status: "confirmed", origin: "user", created_at: "2026-01-05T00:00:00Z" };
  }),
});
// The API signs each undo and refuses one it did not give; the mock signs with a plain hash of the rest.
const sigOf = (u: Omit<Undo, "sig">) => {
  let h = 2166136261;
  for (const c of JSON.stringify({ goals: u.goals ?? [], features: u.features ?? [], added_goal_id: u.added_goal_id ?? null })) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `mock-${h.toString(16)}`;
};
const signed = (u: Omit<Undo, "sig">): Undo => ({ ...u, sig: sigOf(u) });

type GoalIn = { title?: string; measure?: string; target?: string; due?: string; owner_id?: string | null };
/** EG1: the owner a goal's form sends: left out, as it was; null clears it; else a member (422 when not). */
const ownerIn = (b: GoalIn, people: GoalPeople): { ok: boolean; set: boolean; id: string | null } => {
  if (!("owner_id" in b)) return { ok: true, set: false, id: null };
  if (b.owner_id == null) return { ok: true, set: true, id: null };
  return { ok: people.some((x) => x.id === b.owner_id && !x.disabled), set: true, id: b.owner_id };
};
const complete = (b: GoalIn) => !!(b.title?.trim() && b.measure?.trim() && b.target?.trim() && b.due && /^\d{4}-\d{2}-\d{2}$/.test(b.due));

/** Archive and a delete to Trash: the goal's features leave it; those that serve another goal
 * keep it (now first), the rest go to `to` or to no goal. */
function moveOff(db: GoalBucketsDb, g: Goal, to: string | null): Feature[] {
  const held = db.features.filter((f) => f.goal_ids.includes(g.id));
  const before = held.map((f) => ({ ...f, goal_ids: [...f.goal_ids], assumed_goal_ids: f.assumed_goal_ids && [...f.assumed_goal_ids] }));
  for (const f of held) {
    const rest = f.goal_ids.filter((x) => x !== g.id);
    const first = f.goal_ids[0] === g.id;
    f.goal_ids = first && !rest.length && to ? [to] : rest;
    // The link that becomes first gets its contribution set (the API's TOP): no longer assumed.
    if (first) f.assumed_goal_ids = f.assumed_goal_ids?.filter((x) => x !== f.goal_ids[0]);
  }
  return before;
}

/** A roadmap item's own goals (the API's RoadmapItem.goal_ids): the one it moves most, then the others. */
type ItemGoals = { key: string; roadmap?: string; goal?: string; goals?: string[] };
const itemGoals = (s: ItemGoals) => [...(s.goal ? [s.goal] : []), ...(s.goals ?? [])];

/** trash_items.trash_goal: the items that name the goal as their own serve `to` instead (first,
 * unless they serve it already); their goals as they were, for Restore. */
function moveItemsOff(items: ItemGoals[], g: Goal, to: Goal): NonNullable<TrashEntryRow["item_goals"]> {
  const from = itemGoalKey(g) ?? g.key;
  const toKey = itemGoalKey(to) ?? to.key;
  const was: NonNullable<TrashEntryRow["item_goals"]> = [];
  for (const s of items) {
    const ids = itemGoals(s);
    if (!ids.includes(from)) continue;
    was.push({ key: s.key, roadmap: s.roadmap, goals: ids, from, to: toKey });
    const rest = ids.filter((k) => k !== from);
    const next = rest.includes(toKey) ? rest : [toKey, ...rest];
    s.goal = next[0];
    s.goals = next.slice(1);
  }
  return was;
}

/** The item goal key of a bucket goal: the roadmap's goal of that name. */
const itemGoalKey = (g: Goal | undefined) => (g ? Object.keys(GOALS).find((k) => GOALS[k].toLowerCase() === g.title.toLowerCase()) : undefined);
/** goal-order: a bucket goal's key in the one goal order: the roadmap's goal of that name, else its name. */
const orderKey = (g: Goal) => itemGoalKey(g) ?? g.title.toLowerCase();

/**
 * goal-order: the bucket goals the Ground Truth does not hold, each with the place stored on it, so the
 * one goal order (simple-roadmap knowCompanyGoals) ranks them as the API ranks every goal. With no
 * place they come after the Ground Truth's goals, in the buckets' own order (each made after the last).
 */
export function bucketGoalsInOrder(simple: { goal_buckets?: GoalBucketsDb }, baselineKeys: Set<string>): { id: string; key: string; title: string; position: number | null; created_at: string }[] {
  return (simple.goal_buckets?.goals ?? [])
    .filter((g) => !g.trashed && !baselineKeys.has(orderKey(g)))
    .map((g, i) => ({ id: g.id, key: orderKey(g), title: g.title, position: g.position ?? null, created_at: `9999-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }));
}

/**
 * goal-order: each live goal's place stored as it is listed (1 = first), on the bucket goal and on
 * the Ground Truth's goal of the same key, so the goal buckets, Priorities and the Roadmap's goal rows
 * read one order from the start (a scenario's seed).
 */
export function placeBucketGoals(db: GoalBucketsDb, baseline: { key: string; type: string; attrs?: Record<string, unknown> | null }[]): void {
  for (const g of db.goals.filter((x) => !x.archived && !x.trashed)) {
    g.position = g.order;
    const e = baseline.find((x) => x.type === "goal" && x.key === orderKey(g));
    if (e) e.attrs = { ...e.attrs, position: g.order };
  }
}

/**
 * goal-order: PATCH /v1/baseline/entities/{id} naming a bucket goal (the API's buckets are the
 * Ground Truth's goals): its attrs.position is its place in the one goal order, and the Ground Truth's goal
 * of the same key takes it too, so every page follows. Approvers and owners, as the API.
 */
export async function placeBucketGoal(simple: { goal_buckets?: GoalBucketsDb }, role: string, req: Request, p: string[], baseline: { id?: string; key: string; type: string; attrs?: Record<string, unknown> | null }[]): Promise<Response | null> {
  if (p[1] !== "baseline" || p[2] !== "entities" || !p[3] || p[4] || req.method !== "PATCH") return null;
  const g = simple.goal_buckets?.goals.find((x) => x.id === p[3]);
  if (!g) return null;
  if (role !== "owner" && role !== "approver") return json(403, { detail: "Requires the approver role" });
  const body = (await req.json().catch(() => ({}))) as { attrs?: { position?: unknown } };
  const at = body.attrs?.position;
  if (at != null && !(typeof at === "number" && Number.isInteger(at) && at >= 1)) return json(422, { detail: "A goal's position is a whole number of 1 or more" });
  g.position = (at as number | null | undefined) ?? null;
  // goal-map-editing: or the Ground Truth goal of the same id (goal-ladder's goals are both).
  const e = baseline.find((x) => x.type === "goal" && (x.key === orderKey(g) || x.id === g.id));
  if (e) e.attrs = { ...e.attrs, position: g.position };
  return json(200, { applied: true, entity: { id: g.id, type: "goal", key: orderKey(g), title: g.title, status: g.archived ? "rejected" : "confirmed", attrs: { ...(e?.attrs ?? {}), position: g.position } }, proposal: null });
}
/** trash-features-goals (oracle.simple.trash_items): Settings › Trash and who writes there;
 * `propose`: a commenter's goal delete as a `delete_goal` change (./simple-changes.ts). */
export type GoalBucketsTrash = {
  trash: TrashDb;
  id: string;
  name: string | null;
  now: () => string;
  people?: GoalPeople;
  propose?: (goal: { id: string; title: string }, to: string | null, reason: string | null) => unknown;
  /** every-field: why the restore is refused (trash_items.before_restore, which every restore goes through), else null. */
  refuseRestore?: (entry: TrashEntryRow) => string | null;
};

/** Archive (goal_buckets.archive), also an accepted Ask to archive: the Undo, or an error. */
export function archiveGoal(db: GoalBucketsDb, id: string, to: string | null, now: string): Undo | Response {
  const g = db.goals.find((x) => x.id === id && !x.archived && !x.trashed);
  if (!g) return json(404, { detail: "No such goal" });
  if (to && !db.goals.some((x) => x.id === to && !x.archived && !x.trashed && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
  const undo = signed({ goals: [goalSnap(g)], features: moveOff(db, g, to).map(featureSnap), added_goal_id: null });
  g.archived = true;
  g.archived_at = now;
  return undo;
}

/** Restore an archived goal (goal_buckets.unarchive), also an accepted Ask to restore: the Undo, or an error. */
export function unarchiveGoal(db: GoalBucketsDb, id: string): { g: Goal; undo: Undo } | Response {
  const g = db.goals.find((x) => x.id === id && !x.trashed);
  if (!g) return json(404, { detail: "No such goal" });
  if (!g.archived) return json(409, { detail: `${g.title} is not archived` });
  const undo = signed({ goals: [goalSnap(g)], features: [], added_goal_id: null });
  g.archived = false;
  g.archived_at = null;
  return { g, undo };
}

/** trash_items.trash_goal, also an accepted Ask to delete: the goal to Trash. With no `to` nothing
 * is rewritten (the reads leave the trashed goal out of every feature's links); with `to` its
 * features move there as Archive moves them, and their links as they were are kept on the entry
 * for Restore (its Undo). A proposal to delete it is closed, "Already in Trash". */
export function trashGoal(db: GoalBucketsDb, bin: GoalBucketsTrash, id: string, to: string | null, reason: string | null, simple?: { changes?: { op: string; status: string; target: Record<string, unknown> }[]; items?: ItemGoals[] }): TrashEntryRow | Response {
  const g = db.goals.find((x) => x.id === id && !x.trashed);
  if (!g) return json(404, { detail: "No such goal" });
  if (to && !db.goals.some((x) => x.id === to && !x.archived && !x.trashed && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
  // G-4: the features that served it, which Trash says come back with it.
  const features = db.features.filter((f) => f.goal_ids.includes(g.id)).length;
  const before = to ? moveOff(db, g, to) : [];
  const item_goals = to ? moveItemsOff(simple?.items ?? [], g, db.goals.find((x) => x.id === to)!) : [];
  g.trashed = true;
  const at = bin.now();
  for (const c of simple?.changes ?? []) {
    if (c.op === "delete_goal" && c.status === "proposed" && c.target.goal_id === g.id) {
      Object.assign(c, { status: "declined", decided_by: bin.id, decided_at: at, decision_reason: "Already in Trash" });
    }
  }
  const row: TrashEntryRow = {
    out: {
      id: crypto.randomUUID(),
      root: { type: "goal", id: g.id, slug: g.key, title: g.title, kind: "goal", code: null, features, meeting: null },
      items: [], deleted_by: bin.id, deleted_by_name: bin.name, deleted_at: at, reason,
      published: false, purge_after: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
    },
    documents: [], versions: [], runs: [], intakes: [],
    goal_links: before.map((f) => ({ id: f.id, goal_ids: f.goal_ids, left: [...(db.features.find((x) => x.id === f.id)?.goal_ids ?? [])] })),
    item_goals,
  };
  bin.trash.entries.push(row);
  return row;
}

/**
 * kr-in-priorities, the "goal-key-results" scenario (server.ts): as the API lists them, every goal its roadmap's items
 * serve, KR 1 among them with its own measure and target, and each item's feature linked to its goal, so the key
 * result's feature has its weeks and grip in its goal's bucket. Invented data.
 */
function goalKeyResultsBuckets(simple: { items?: { key: string; title: string; goal?: string; draft?: boolean }[] }): GoalBucketsDb | undefined {
  if (typeof localStorage === "undefined" || localStorage.getItem(MOCK_SCENARIO_KEY) !== "goal-key-results" || !simple.items) return undefined;
  const items = simple.items.filter((i) => !i.draft && i.goal);
  const name = (k: string) => GOALS[k] ?? k;
  const db = seedGoalBucketsWith(seedGoalBuckets(), [...new Set(items.map((i) => name(i.goal!)))], items.map((i) => ({ key: i.key, title: i.title, goals: [name(i.goal!)] })));
  const kr = db.goals.find((g) => g.title === name("kr-setup-day"));
  if (kr) Object.assign(kr, { measure: "New teams set up in one day", target: "50%", due: "2027-01-29" });
  return db;
}

/** The goal buckets' db, its seeded owners matched to the members by email. */
export function goalBucketsDb(simple: { goal_buckets?: GoalBucketsDb; items?: { key: string; title: string; goal?: string; draft?: boolean }[] }, people: GoalPeople = []): GoalBucketsDb {
  const db = (simple.goal_buckets ??= goalKeyResultsBuckets(simple) ?? lazyGoalBuckets());
  for (const g of db.goals) {
    if (g.owner_email && g.owner_id === undefined) g.owner_id = people.find((x) => x.email === g.owner_email)?.id ?? null;
  }
  return db;
}

/** /v1/simple/goal-buckets... (as the API: approvers and owners write; anyone reads). */
export async function routeGoalBuckets(simple: { goal_buckets?: GoalBucketsDb; goal_edits?: Record<string, RoadmapGoalFields> }, role: string, req: Request, p: string[], bin?: GoalBucketsTrash): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "goal-buckets") return null;
  const people = bin?.people ?? [];
  const db = goalBucketsDb(simple, people);
  const edits = role === "owner" || role === "approver";
  const m = req.method;
  if (!p[3] && m === "GET") return json(200, out(db, edits, people));
  // trash-features-goals: a goal's restore, by an owner or whoever deleted it (mayRestore).
  if (bin && p[3] === "goals" && p[4] && p[5] === "restore" && m === "POST") {
    if (role === "viewer") return json(403, { detail: "Requires the commenter role" });
    const entry = bin.trash.entries.find((e) => e.out.root.type === "goal" && e.out.root.id === p[4]);
    if (!entry) return json(404, { detail: "goal not found in Trash" });
    if (!mayRestore(entry, { id: bin.id, role })) {
      return json(403, { detail: "Only an owner, or whoever deleted it, restores this" });
    }
    const refused = bin.refuseRestore?.(entry) ?? null;
    if (refused) return json(409, { detail: refused });
    return json(200, restoreFromTrash(bin.trash, entry, bin.now(), { items: [], goal_buckets: db }));
  }
  // trash-features-goals: DELETE .../goals/{id}?to_goal_id=: approvers and owners delete it (and
  // restore it); a commenter proposes it to the owners; viewers are refused.
  if (bin && p[3] === "goals" && p[4] && !p[5] && m === "DELETE") {
    if (role === "viewer") return json(403, { detail: "Requires the commenter role" });
    const g = db.goals.find((x) => x.id === p[4] && !x.trashed);
    if (!g) return json(404, { detail: "No such goal" });
    const q = new URL(req.url).searchParams;
    const to = q.get("to_goal_id");
    if (to && !db.goals.some((x) => x.id === to && !x.archived && !x.trashed && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
    if (!edits) {
      const change = bin.propose?.(g, to, q.get("reason"));
      if (!change) return json(403, { detail: "Requires the approver role" });
      if (change instanceof Response) return change;
      return json(200, { entry: null, change, can_restore: false });
    }
    const row = trashGoal(db, bin, g.id, to, q.get("reason"), simple as { changes?: [] });
    if (row instanceof Response) return row;
    return json(200, { entry: entryOut(row, row.out.deleted_at, true), change: null, can_restore: true });
  }
  if (!edits) return json(403, { detail: "Requires the approver role" });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (p[3] === "goals" && !p[4] && m === "POST") {
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const owner = ownerIn(b, people);
    if (!owner.ok) return json(422, { detail: "Pick a member as its owner" });
    const order = Math.max(0, ...db.goals.filter((g) => !g.archived && !g.trashed).map((g) => g.order)) + 1;
    const g: Goal = { id: crypto.randomUUID(), key: keyOf(b.title!.trim()), title: b.title!.trim(), order, measure: b.measure!.trim(), target: b.target!.trim(), due: b.due!, archived: false, owner_id: owner.id };
    db.goals.push(g);
    return json(201, { goal: goalOut(g, people), undo: signed({ goals: [], features: [], added_goal_id: g.id }) });
  }
  if (p[3] === "goals" && p[4] && !p[5] && m === "PATCH") {
    // one-feature-panel: a roadmap item's goal is edited here too, as its goal bucket when it has one (the API's one goal entity).
    const key = roadmapGoalKey(p[4], simple);
    // An archived goal, or one in Trash, is not edited (as the API).
    const g = db.goals.find((x) => x.id === p[4] || (!!key && x.key === key));
    const b = body as GoalIn & { seen?: { title?: string | null; measure?: string | null; target?: string | null; due?: string | null } | null };
    if (g ? g.archived || g.trashed : !key || goalInTrash(simple, key)) return json(404, { detail: "No such goal" });
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    // goal_buckets._changed_since: the values the form read, when sent, must still be the goal's.
    const was = g ? { title: g.title, metric: g.measure, target: g.target, due: g.due } : roadmapGoal(simple, key!);
    const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ") || null;
    if (b.seen && (norm(b.seen.title) !== norm(was.title) || norm(b.seen.measure) !== norm(was.metric) || norm(b.seen.target) !== norm(was.target) || norm(b.seen.due) !== norm(was.due))) {
      return json(409, { detail: "This goal changed since you opened it. Look again and save." });
    }
    if (!g) {
      // milestone-kinds: a roadmap goal's on_roadmap (goal_buckets._fields), kept by its key.
      const shown = (simple as { goal_on_roadmap?: Record<string, boolean> }).goal_on_roadmap ??= {};
      const undo = signed({ goals: [{ id: p[4], title: was.title, status: "confirmed", attrs: { metric: was.metric, target_text: was.target, due: was.due }, on_roadmap: shown[key!] ?? true }], features: [], added_goal_id: null });
      const now = { title: b.title!.trim(), metric: b.measure!.trim(), target: b.target!.trim(), due: b.due! };
      writeRoadmapGoal(simple, key!, now);
      const onRoadmap = (b as { on_roadmap?: boolean | null }).on_roadmap;
      if (onRoadmap != null) shown[key!] = onRoadmap;
      return json(200, { goal: { id: p[4], title: now.title, order: 1, measure: now.metric, target: now.target, due: now.due, can_edit: true, on_roadmap: shown[key!] ?? true }, undo });
    }
    const owner = ownerIn(b, people);
    if (!owner.ok) return json(422, { detail: "Pick a member as its owner" });
    const undo = signed({ goals: [goalSnap(g)], features: [], added_goal_id: null });
    Object.assign(g, { title: b.title!.trim(), measure: b.measure!.trim(), target: b.target!.trim(), due: b.due! });
    if (owner.set) g.owner_id = owner.id;
    const onRoadmap = (b as { on_roadmap?: boolean | null }).on_roadmap;
    if (onRoadmap != null) g.on_roadmap = onRoadmap;
    return json(200, { goal: { ...goalOut(g, people), id: p[4] }, undo });
  }
  if (p[3] === "goals" && p[5] === "archive" && m === "POST") {
    const undo = archiveGoal(db, p[4], (body.to_goal_id as string | null | undefined) ?? null, bin?.now() ?? new Date().toISOString());
    if (undo instanceof Response) return undo;
    return json(200, { goal: null, undo });
  }
  // edit-goals-prds EG1: Restore an archived goal to the buckets, with Undo.
  if (p[3] === "goals" && p[5] === "unarchive" && m === "POST") {
    const done = unarchiveGoal(db, p[4]);
    if (done instanceof Response) return done;
    return json(200, { goal: goalOut(done.g, people), undo: done.undo });
  }
  if (p[3] === "features" && p[5] === "move" && m === "POST") {
    const f = db.features.find((x) => x.id === p[4]);
    const to = body.to_goal_id as string;
    if (!f) return json(404, { detail: "No such feature" });
    if (!db.goals.some((x) => x.id === to)) return json(404, { detail: "No such goal" });
    const undo = signed({ goals: [], features: [featureSnap(f)], added_goal_id: null });
    f.goal_ids = [to, ...f.goal_ids.filter((x) => x !== to && x !== body.from_goal_id)];
    // The goal it is dropped on gets its contribution set (the API's TOP): no longer assumed.
    f.assumed_goal_ids = f.assumed_goal_ids?.filter((x) => x !== to && x !== body.from_goal_id);
    return json(200, { goal: null, undo });
  }
  if (p[3] === "undo" && m === "POST") {
    const u = body as unknown as Undo;
    if (!u.sig || u.sig !== sigOf(u)) return json(400, { detail: "This Undo is not one Oracle gave" });
    for (const s of u.goals ?? []) {
      const g = db.goals.find((x) => x.id === s.id);
      const a = s.attrs as Record<string, string | number | null>;
      const key = g ? null : roadmapGoalKey(s.id, simple);
      if (key) writeRoadmapGoal(simple, key, { title: s.title, metric: (a.metric as string | null) ?? null, target: (a.target_text as string | null) ?? null, due: (a.due as string | null) ?? null });
      // goal_buckets undo: the goal's on_roadmap as it was (GoalSnap.on_roadmap).
      if (key) ((simple as { goal_on_roadmap?: Record<string, boolean> }).goal_on_roadmap ??= {})[key] = s.on_roadmap ?? true;
      if (!g) continue;
      Object.assign(g, { title: s.title, archived: s.status === "rejected", measure: a.metric ?? null, target: a.target_text ?? null, due: a.due ?? null, owner_id: a.owner ?? null, archived_at: a.archived_at ?? null, on_roadmap: s.on_roadmap ?? true });
    }
    for (const s of u.features ?? []) {
      const f = db.features.find((x) => x.id === s.feature_id);
      if (f) {
        f.goal_ids = s.links.map((l) => l.goal_id);
        f.assumed_goal_ids = s.links.filter((l) => (l.attrs as Record<string, unknown> | null)?.contribution_assumed === true).map((l) => l.goal_id);
      }
    }
    if (u.added_goal_id) {
      const g = db.goals.find((x) => x.id === u.added_goal_id);
      if (g) g.archived = true;
    }
    return json(200, out(db, edits, people));
  }
  return null;
}

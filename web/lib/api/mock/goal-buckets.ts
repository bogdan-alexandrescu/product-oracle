/**
 * Goal buckets in Simple Priorities (api/oracle/simple/goal_buckets.py): the goals in order with
 * their measure, target and date, each feature's goal links (the one it moves most first), and
 * adding, editing and archiving a goal or moving a feature, each with Undo. Seeded from the
 * plan's invented goals and features.
 */
import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";
import { entryOut, mayRestore, restoreFromTrash, type TrashDb, type TrashEntryRow } from "./trash";
import { planGoalNames, planSlices } from "./simple-plan";
import { GOALS, goalId, goalPositionOf, goalRank, type SeedItem } from "./simple-roadmap";

// trash-features-goals: `trashed` while in Settings › Trash (left out of every read, kept for Restore).
// edit-goals-prds EG1: a goal's owner (a member's id; seeded by email, matched to the member on first read) and when it was archived.
// goal-order: `position`, the place Move up and Move down store on it (attrs.position, as the API's goals).
type Goal = { id: string; title: string; order: number; measure: string | null; target: string | null; due: string | null; archived: boolean; trashed?: boolean; owner_id?: string | null; owner_email?: string; archived_at?: string | null; position?: number | null };
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
    return { id: stableUuid(`goal-bucket/${title}`), title, order: i + 1, measure, target, due, archived: false, owner_email: OWNERS[title] };
  });
  const live = goals.length;
  ARCHIVED.forEach(([title, owner_email, archived_at], i) => {
    goals.push({ id: stableUuid(`goal-bucket/${title}`), title, order: live + i + 1, measure: null, target: null, due: null, archived: true, owner_email, archived_at });
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
  const big: Goal = { id: bigId, title: "Grow partner network", order: base.goals.filter((g) => !g.archived).length + 1, measure: "Live partner integrations", target: "40 partners", due: "2027-03-31", archived: false, owner_email: "viewer@example.com" };
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
      g = { id: stableUuid(`goal-bucket/${name}`), title: name, order: goals.filter((x) => !x.archived).length + 1, measure: null, target: null, due: null, archived: false };
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
  // goal-order: the goals in the one goal order, as the API lists them (the baseline's, then the rest as they were).
  const live = db.goals.filter((g) => !g.archived && !g.trashed).sort((a, b) => goalRank(orderKey(a)) - goalRank(orderKey(b)));
  const ids = new Set(live.map((g) => g.id));
  const archived = db.goals.filter((g) => g.archived && !g.trashed).sort((a, b) => ((a.archived_at ?? "") < (b.archived_at ?? "") ? 1 : -1));
  return {
    can_edit: edits,
    goals: live.map((g) => ({ ...goalOut(g, people), can_edit: edits })),
    features: db.features.map((f) => ({ id: f.id, key: f.key, title: f.title, goal_ids: f.goal_ids.filter((g) => ids.has(g)) })),
    archived: archived.map((g) => ({ id: g.id, title: g.title, owner_name: nameOf(people, g.owner_id), archived_at: g.archived_at ?? null })),
    asks_to: people.filter((x) => x.role === "owner" && !x.disabled).map((x) => x.name),
  };
}

const nameOf = (people: GoalPeople, id: string | null | undefined) => (id ? (people.find((x) => x.id === id)?.name ?? null) : null);
const goalOut = (g: Goal, people: GoalPeople = []): Schemas["GoalBucketGoal"] => ({ id: g.id, title: g.title, order: goalPositionOf(orderKey(g)) ?? g.order, measure: g.measure, target: g.target, due: g.due, can_edit: true, owner_id: g.owner_id ?? null, owner_name: nameOf(people, g.owner_id) });
const goalSnap = (g: Goal) => ({ id: g.id, title: g.title, status: g.archived ? "rejected" : "confirmed", attrs: { metric: g.measure, target_text: g.target, due: g.due, position: g.order, owner: g.owner_id ?? null, archived_at: g.archived_at ?? null } });
// The mock keeps links in order, and Undo puts that order back; each link is snapshotted whole, as the API does.
const featureSnap = (f: Feature) => ({
  feature_id: f.id,
  links: f.goal_ids.map((goal_id, i) => ({ goal_id, contribution: i ? 2 : 3, id: `${f.id}:${goal_id}`, attrs: { contribution: i ? 2 : 3 }, status: "confirmed", origin: "user", created_at: "2026-01-05T00:00:00Z" })),
});
// The API signs each undo and refuses one it did not give; the mock signs with a plain hash of the rest.
const sigOf = (u: Omit<Undo, "sig">) => {
  let h = 2166136261;
  for (const c of JSON.stringify({ goals: u.goals ?? [], features: u.features ?? [], items: u.items ?? [], added_goal_id: u.added_goal_id ?? null })) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
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
  const before = held.map((f) => ({ ...f, goal_ids: [...f.goal_ids] }));
  for (const f of held) {
    const rest = f.goal_ids.filter((x) => x !== g.id);
    f.goal_ids = f.goal_ids[0] === g.id && !rest.length && to ? [to] : rest;
  }
  return before;
}

/** The roadmap items whose own goal a goal's delete takes off (SimpleDb's items and ids). */
export type GoalBucketsItems = { items: SeedItem[]; ids: Record<string, string> };
type ItemSnap = Schemas["ItemGoalsSnap"];
/** The item goal key of a bucket goal: the roadmap's goal of that name. */
const itemGoalKey = (g: Goal | undefined) => (g ? Object.keys(GOALS).find((k) => GOALS[k].toLowerCase() === g.title.toLowerCase()) : undefined);
/** goal-order: a bucket goal's key in the one goal order: the roadmap's goal of that name, else its name. */
const orderKey = (g: Goal) => itemGoalKey(g) ?? g.title.toLowerCase();

/**
 * goal-order: the bucket goals the baseline does not hold, each with the place stored on it, so the
 * one goal order (simple-roadmap knowCompanyGoals) ranks them as the API ranks every goal. With no
 * place they come after the baseline's goals, in the buckets' own order (each made after the last).
 */
export function bucketGoalsInOrder(simple: { goal_buckets?: GoalBucketsDb }, baselineKeys: Set<string>): { id: string; key: string; title: string; position: number | null; created_at: string }[] {
  return (simple.goal_buckets?.goals ?? [])
    .filter((g) => !g.trashed && !baselineKeys.has(orderKey(g)))
    .map((g, i) => ({ id: g.id, key: orderKey(g), title: g.title, position: g.position ?? null, created_at: `9999-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }));
}

/**
 * goal-order: each live goal's place stored as it is listed (1 = first), on the bucket goal and on
 * the baseline's goal of the same key, so the goal buckets, Priorities and the Roadmap's goal rows
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
 * baseline's goals): its attrs.position is its place in the one goal order, and the baseline's goal
 * of the same key takes it too, so every page follows. Approvers and owners, as the API.
 */
export async function placeBucketGoal(simple: { goal_buckets?: GoalBucketsDb }, role: string, req: Request, p: string[], baseline: { key: string; type: string; attrs?: Record<string, unknown> | null }[]): Promise<Response | null> {
  if (p[1] !== "baseline" || p[2] !== "entities" || !p[3] || p[4] || req.method !== "PATCH") return null;
  const g = simple.goal_buckets?.goals.find((x) => x.id === p[3]);
  if (!g) return null;
  if (role !== "owner" && role !== "approver") return json(403, { detail: "Requires the approver role" });
  const body = (await req.json().catch(() => ({}))) as { attrs?: { position?: unknown } };
  const at = body.attrs?.position;
  if (at != null && !(typeof at === "number" && Number.isInteger(at) && at >= 1)) return json(422, { detail: "A goal's position is a whole number of 1 or more" });
  g.position = (at as number | null | undefined) ?? null;
  const e = baseline.find((x) => x.type === "goal" && x.key === orderKey(g));
  if (e) e.attrs = { ...e.attrs, position: g.position };
  return json(200, { applied: true, entity: { id: g.id, type: "goal", key: orderKey(g), title: g.title, status: g.archived ? "rejected" : "confirmed", attrs: { ...(e?.attrs ?? {}), position: g.position } }, proposal: null });
}
/** An item's own goals (keys), first first, as goalIdsOf reads them, and writing them back. */
const keysOf = (s: SeedItem): string[] => (s.own_goal !== undefined ? (s.own_goal ? [s.own_goal] : []) : [...new Set([...(s.goal ? [s.goal] : []), ...(s.goals ?? [])])]);
function setKeys(s: SeedItem, keys: string[]): void {
  if (s.own_goal !== undefined) s.own_goal = keys[0] ?? "";
  else {
    s.goal = keys[0];
    s.goals = keys.slice(1);
  }
}

/** As trash_goal: each live item naming the goal as its own loses it, and gets `to` first if it lacks it; what was done, for Undo. */
function itemsOff(simple: GoalBucketsItems | undefined, db: GoalBucketsDb, g: Goal, to: string | null): ItemSnap[] {
  const key = itemGoalKey(g);
  if (!simple || !key) return [];
  const toKey = to ? itemGoalKey(db.goals.find((x) => x.id === to)) : undefined;
  const out: ItemSnap[] = [];
  for (const s of simple.items.filter((x) => !x.trashed && keysOf(x).includes(key))) {
    const before = keysOf(s);
    const rest = before.filter((k) => k !== key);
    const added = toKey && !rest.includes(toKey) ? toKey : null;
    out.push({ item_id: simple.ids[s.key], goal_id: goalId(key), index: before.indexOf(key), added_goal_id: added ? goalId(added) : null });
    setKeys(s, added ? [added, ...rest] : rest);
  }
  return out;
}

/** goal_buckets._goal_back: the goal a delete added off, the goal it took off back in its place. */
function itemsBack(simple: GoalBucketsItems | undefined, snaps: ItemSnap[]): void {
  const keyOf = (id: string | null | undefined) => (id ? Object.keys(GOALS).find((k) => goalId(k) === id) : undefined);
  for (const it of snaps) {
    const s = simple?.items.find((x) => simple.ids[x.key] === it.item_id);
    const key = keyOf(it.goal_id);
    if (!s || !key) continue;
    const added = keyOf(it.added_goal_id);
    const keys = keysOf(s).filter((k) => k !== added);
    if (!keys.includes(key)) keys.splice(Math.min(it.index ?? 0, keys.length), 0, key);
    setKeys(s, keys);
  }
}

/** trash-features-goals (oracle.simple.trash_items): Settings › Trash and who writes there. */
export type GoalBucketsTrash = { trash: TrashDb; id: string; name: string | null; now: () => string; people?: GoalPeople };

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

/** A goal to Trash (trash_items.trash_goal), also an accepted Ask to delete: the Trash row and the Undo for its links, or an error. */
export function trashGoal(db: GoalBucketsDb, bin: GoalBucketsTrash, id: string, to: string | null, reason: string | null, simple?: GoalBucketsItems): { row: TrashEntryRow; undo: Undo } | Response {
  const g = db.goals.find((x) => x.id === id && !x.trashed);
  if (!g) return json(404, { detail: "No such goal" });
  if (to && !db.goals.some((x) => x.id === to && !x.archived && !x.trashed && x.id !== g.id)) return json(422, { detail: "Pick another goal" });
  const undo = signed({ goals: [], features: moveOff(db, g, to).map(featureSnap), items: itemsOff(simple, db, g, to), added_goal_id: null });
  g.trashed = true;
  const at = bin.now();
  const row: TrashEntryRow = {
    out: {
      id: crypto.randomUUID(),
      root: { type: "goal", id: g.id, slug: null, title: g.title, kind: "goal", code: null },
      items: [], deleted_by: bin.id, deleted_by_name: bin.name, deleted_at: at, reason,
      published: false, purge_after: new Date(Date.parse(at) + 30 * 86_400_000).toISOString(),
    },
    documents: [], versions: [], runs: [], intakes: [],
  };
  bin.trash.entries.push(row);
  return { row, undo };
}

const itemsIn = (simple: Partial<GoalBucketsItems>): GoalBucketsItems | undefined => (simple.items && simple.ids ? { items: simple.items, ids: simple.ids } : undefined);

/** The goal buckets' db, its seeded owners matched to the members by email. */
export function goalBucketsDb(simple: { goal_buckets?: GoalBucketsDb }, people: GoalPeople = []): GoalBucketsDb {
  const db = (simple.goal_buckets ??= seedGoalBuckets());
  for (const g of db.goals) {
    if (g.owner_email && g.owner_id === undefined) g.owner_id = people.find((x) => x.email === g.owner_email)?.id ?? null;
  }
  return db;
}

/** /v1/simple/goal-buckets... (as the API: approvers and owners write; anyone reads). */
export async function routeGoalBuckets(simple: { goal_buckets?: GoalBucketsDb } & Partial<GoalBucketsItems>, role: string, req: Request, p: string[], bin?: GoalBucketsTrash): Promise<Response | null> {
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
    return json(200, restoreFromTrash(bin.trash, entry, bin.now(), { items: [], goal_buckets: db }));
  }
  if (!edits) return json(403, { detail: "Requires the approver role" });
  // trash-features-goals: DELETE .../goals/{id}?to_goal_id= (approvers and owners): whoever deletes it restores it.
  if (bin && p[3] === "goals" && p[4] && !p[5] && m === "DELETE") {
    const q = new URL(req.url).searchParams;
    const done = trashGoal(db, bin, p[4], q.get("to_goal_id"), q.get("reason"), itemsIn(simple));
    if (done instanceof Response) return done;
    return json(200, { entry: entryOut(done.row, done.row.out.deleted_at, true), change: null, can_restore: true, undo: done.undo });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (p[3] === "goals" && !p[4] && m === "POST") {
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const owner = ownerIn(b, people);
    if (!owner.ok) return json(422, { detail: "Pick a member as its owner" });
    const order = Math.max(0, ...db.goals.filter((g) => !g.archived && !g.trashed).map((g) => g.order)) + 1;
    const g: Goal = { id: crypto.randomUUID(), title: b.title!.trim(), order, measure: b.measure!.trim(), target: b.target!.trim(), due: b.due!, archived: false, owner_id: owner.id };
    db.goals.push(g);
    return json(201, { goal: goalOut(g, people), undo: signed({ goals: [], features: [], added_goal_id: g.id }) });
  }
  if (p[3] === "goals" && p[4] && !p[5] && m === "PATCH") {
    const g = db.goals.find((x) => x.id === p[4] && !x.archived);
    if (!g) return json(404, { detail: "No such goal" });
    const b = body as GoalIn;
    if (!complete(b)) return json(422, { detail: "A goal needs a measure, a target and a date" });
    const owner = ownerIn(b, people);
    if (!owner.ok) return json(422, { detail: "Pick a member as its owner" });
    const undo = signed({ goals: [goalSnap(g)], features: [], added_goal_id: null });
    Object.assign(g, { title: b.title!.trim(), measure: b.measure!.trim(), target: b.target!.trim(), due: b.due! });
    if (owner.set) g.owner_id = owner.id;
    return json(200, { goal: goalOut(g, people), undo });
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
    return json(200, { goal: null, undo });
  }
  if (p[3] === "undo" && m === "POST") {
    const u = body as unknown as Undo;
    if (!u.sig || u.sig !== sigOf(u)) return json(400, { detail: "This Undo is not one Oracle gave" });
    for (const s of u.goals ?? []) {
      const g = db.goals.find((x) => x.id === s.id);
      if (!g) continue;
      const a = s.attrs as Record<string, string | number | null>;
      Object.assign(g, { title: s.title, archived: s.status === "rejected", measure: a.metric ?? null, target: a.target_text ?? null, due: a.due ?? null, owner_id: a.owner ?? null, archived_at: a.archived_at ?? null });
    }
    for (const s of u.features ?? []) {
      const f = db.features.find((x) => x.id === s.feature_id);
      if (f) f.goal_ids = s.links.map((l) => l.goal_id);
    }
    itemsBack(itemsIn(simple), u.items ?? []);
    if (u.added_goal_id) {
      const g = db.goals.find((x) => x.id === u.added_goal_id);
      if (g) g.archived = true;
    }
    return json(200, out(db, edits, people));
  }
  return null;
}

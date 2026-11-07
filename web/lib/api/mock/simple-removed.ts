/**
 * Mock of Simple's removed list and tracks (oracle.simple.removed, oracle.simple.plan_changes):
 * GET /v1/simple/removed, GET /v1/simple/tracks, and the change ops restore_goal_milestone,
 * add_track, edit_track and delete_track through POST /v1/simple/changes. A cut feature is put
 * back with the engine's own "restore" op, an archived goal with the goal asks' unarchive_goal
 * (./simple-changes.ts).
 */
import type { Schemas } from "@/lib/api/client";

import { mockNowMs } from "./clock";
import { seedGoalBuckets } from "./goal-buckets";
import { stableUuid } from "./ids";
import { canDecideItem, canEditRoadmap, closed, deciderIds, GOALS, ROADMAPS, TRACKS, type SimpleDb } from "./simple-roadmap";
import type { MockMilestone } from "./simple-milestones";
import type { TrashEntryRow } from "./trash";

type Role = "owner" | "approver" | "commenter" | "viewer";
type Status = "active" | "paused" | "closed";
export interface RemovedCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
}
/** Who removed what and when (key: "feature:<key>", "goal:<id>", "milestone:<id>"). */
type Log = Record<string, { at: string; by: string }>;
interface TrackState {
  status: Status;
  prd: string;
}
type Db = SimpleDb & {
  removed_log?: Log;
  track_state?: Record<string, TrackState>;
  /** A track in Trash: its title, state and the items that were on it. */
  /** Applied plan changes, for Undo: what to put back (an undone change's after, when it says more). */
  plan_done?: Record<string, () => Record<string, unknown> | void>;
  /** Plan changes proposed and not decided, for Withdraw. */
  plan_proposed?: string[];
  /** Track names as Simple changed them (TRACKS is the module's; it is rebuilt on a reload). */
  track_titles?: Record<string, string>;
  trashed_tracks?: Record<string, { title: string; state: TrackState; owner?: string; items: string[] }>;
};

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const now = () => new Date(mockNowMs()).toISOString();
const daysAgo = (n: number) => new Date(mockNowMs() - n * 86_400_000).toISOString();
const trackId = (key: string) => stableUuid(`simple-track/${key}`);
const prdId = (title: string) => stableUuid(`simple-prd-ref/${title}`);
const ARCHIVED_GOAL = "Fewer support tickets about billing";
const REMOVED_MILESTONE = "Private beta for 20 teams";

/** Seeds, once: an archived goal and a removed goal milestone, and who cut the cut features. */
function seed(db: Db, ctx: RemovedCtx): Log {
  if (db.removed_log) return db.removed_log;
  const log: Log = {};
  const owner = ctx.owners[0] ?? ctx.id;
  const other = Object.keys(ctx.names).find((x) => x !== owner) ?? owner;
  db.items.filter((s) => s.status === "cut").forEach((s, n) => (log[`feature:${s.key}`] = { at: daysAgo(15 + 7 * n), by: n % 2 ? other : owner }));
  const gb = (db.goal_buckets ??= seedGoalBuckets());
  const gid = stableUuid(`goal-bucket/${ARCHIVED_GOAL}`);
  if (!gb.goals.some((g) => g.id === gid)) gb.goals.push({ id: gid, key: "fewer-billing-tickets", title: ARCHIVED_GOAL, order: gb.goals.length + 1, measure: "Billing tickets a month", target: "Under 40", due: "2027-06-30", archived: true });
  log[`goal:${gid}`] = { at: daysAgo(17), by: other };
  const ms = (db.goal_milestones ??= []) as MockMilestone[];
  const mid = stableUuid(`simple-milestone/removed-beta`);
  if (!ms.some((m) => m.id === mid))
    ms.push({ id: mid, roadmap: "alerts-roadmap", code: "", name: REMOVED_MILESTONE, date: "2027-02-15", goal: "grow-retention", gates: [], counts_when: "all", progress: { done: 0, total: 0 } as never, deleted: true } as MockMilestone);
  log[`milestone:${mid}`] = { at: daysAgo(16), by: owner };
  return (db.removed_log = log);
}

/** TRACKS as this db has them: names changed or added in Simple, those in Trash left out. */
export function syncTracks(db: Db): void {
  for (const [k, t] of Object.entries(db.track_titles ?? {})) TRACKS[k] = t;
  for (const k of Object.keys(db.trashed_tracks ?? {})) delete TRACKS[k];
}
const setTitle = (db: Db, k: string, title: string) => {
  TRACKS[k] = title;
  (db.track_titles ??= {})[k] = title;
};

const trackStates = (db: Db): Record<string, TrackState> => {
  db.track_state ??= {};
  for (const k of Object.keys(TRACKS)) {
    const on = db.items.find((s) => s.track === k);
    db.track_state[k] ??= { status: k === "welcome" ? "paused" : "active", prd: on ? ROADMAPS[on.roadmap]?.prd ?? "" : "" };
  }
  return db.track_state;
};

function change(ctx: RemovedCtx, body: Schemas["SimpleChangeIn"], applied: boolean, route: string[], words: string): Schemas["SimpleChangeResult"] {
  const c = {
    id: crypto.randomUUID(), session_id: null, document_id: null, draft_ids: [], op: body.op, target: body.target ?? {}, before: body.before ?? {}, after: body.after ?? {},
    status: applied ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? null, at: now(), decided_by: null, decided_at: null, reason: null, decision_reason: null,
    routed_to: applied ? [] : route, undoes_id: null, undone: false, can_decide: applied, can_undo: applied, words, from_meeting: null, off_agenda: false,
  };
  return { change: c as unknown as Schemas["SimpleChangeOut"], flags: [] } as unknown as Schemas["SimpleChangeResult"];
}

const OPS = new Set(["restore_goal_milestone", "add_track", "edit_track", "delete_track"]);

/** GET /v1/simple/removed, GET /v1/simple/tracks and the plan ops; null when not one of them. */
/**
 * routeRemoved's reach past Simple's own db: whether anything else references a track (a track
 * milestone, tracker record or alert, a launch or an outcome), as the API's _holds_anything.
 */
export type HeldElsewhere = (trackId: string) => boolean;

export async function routeRemoved(db: Db, ctx: RemovedCtx, req: Request, p: string[], trash: () => TrashEntryRow[], heldElsewhere: HeldElsewhere = () => false): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  syncTracks(db);
  const m = req.method;
  const owner = ctx.role === "owner";
  const deciderName = ctx.names[ctx.owners[0] ?? ""] ?? null;
  // The removed list's own seed (an archived goal, a removed milestone) once it is read, so
  // no other Simple read changes.
  const log = p[2] === "removed" ? seed(db, ctx) : (db.removed_log ?? {});
  const name = (id: string | undefined) => (id ? (ctx.names[id] ?? null) : null);
  const states = trackStates(db);
  if (p[2] === "removed" && m === "GET" && !p[3]) {
    const items: Schemas["SimpleRemovedItem"][] = [];
    for (const s of db.items.filter((x) => x.status === "cut")) {
      // As removed._who_cut: a cut, a cut with its dependents, or the panel's Status set to cut.
      const cuts = (c: { op: string; after: { [key: string]: unknown } }) => c.op === "cut" || c.op === "cut_with_dependents" || (c.op === "set_status" && c.after.status === "cut");
      const cut = [...(db.changes ?? [])].reverse().find((c) => c.status === "applied" && cuts(c) && JSON.stringify(c.target).includes(db.ids[s.key]));
      const l = cut ? { at: cut.at, by: cut.by } : log[`feature:${s.key}`];
      // As service.can_decide and decider_ids: the item's deciders, else the company's owners.
      const decides = canDecideItem(db, s, ctx);
      const route = deciderIds(db, s)[0];
      items.push({ kind: "feature", id: db.ids[s.key], title: s.title, where: ROADMAPS[s.roadmap]?.title ?? "", at: l?.at ?? null, by_name: name(l?.by), can_decide: decides, decider_name: decides ? null : (name(route) ?? deciderName), roadmap_id: stableUuid(`simple-doc/${s.roadmap}`) });
    }
    // An archived goal comes back through the goal asks' unarchive_goal (./simple-changes.ts):
    // an approver or owner restores it, anyone else asks the owners (oracle.simple.goal_asks).
    const restores = RANK[ctx.role] >= RANK.approver;
    for (const g of (db.goal_buckets ?? seedGoalBuckets()).goals.filter((x) => x.archived && !x.trashed)) {
      const l = log[`goal:${g.id}`];
      items.push({ kind: "goal", id: g.id, title: g.title, where: "Goals", at: l?.at ?? g.archived_at ?? null, by_name: name(l?.by), can_decide: restores, decider_name: restores ? null : deciderName, roadmap_id: null });
    }
    for (const ms of ((db.goal_milestones ?? []) as MockMilestone[]).filter((x) => x.deleted)) {
      const l = log[`milestone:${ms.id}`];
      // As drafts.can_edit: who changes the milestone's roadmap puts it back.
      const decides = canEditRoadmap(db, ms.roadmap, ctx);
      items.push({ kind: "milestone", id: ms.id, title: ms.name, where: ms.goal ? (GOALS[ms.goal] ?? ms.goal) : "", at: l?.at ?? null, by_name: name(l?.by), can_decide: decides, decider_name: decides ? null : deciderName, roadmap_id: stableUuid(`simple-doc/${ms.roadmap}`) });
    }
    items.sort((a, b) => ((b.at ?? "") > (a.at ?? "") ? 1 : -1));
    return json(200, { items });
  }
  if (p[2] === "tracks" && m === "GET" && !p[3]) {
    const tracks = Object.entries(TRACKS).map(([k, title]) => {
      const own = db.track_owners?.[k];
      const decides = owner || (own === ctx.id && RANK[ctx.role] >= RANK.approver);
      const st = states[k];
      return { id: trackId(k), title, status: st.status, owner_id: own ?? null, owner_name: name(own), prd_id: prdId(st.prd), prd_title: st.prd || null, can_decide: decides, decider_name: decides ? null : (name(own) ?? deciderName), feature_count: db.items.filter((s) => s.track === k && !closed(s)).length, moves_count: db.items.filter((s) => s.track === k).length };
    });
    // As free_prds: only PRDs with no track (one in Trash takes its PRD too).
    const taken = new Set([...Object.keys(TRACKS).map((k) => states[k].prd), ...Object.values(db.trashed_tracks ?? {}).map((x) => x.state.prd)]);
    const prds = [...new Set(Object.values(ROADMAPS).map((r) => r.prd))]
      .filter((t) => !taken.has(t))
      .sort()
      .map((t) => ({ id: prdId(t), title: t }));
    const people = Object.entries(ctx.names).map(([id, n]) => ({ id, name: n }));
    return json(200, { tracks, can_add: owner, add_decider_name: owner ? null : deciderName, people, prds });
  }
  if (p[2] === "changes" && m === "POST" && p[4] === "undo" && db.plan_done?.[p[3]]) {
    const after = db.plan_done[p[3]]() ?? {};
    delete db.plan_done[p[3]];
    return json(201, { change: { id: crypto.randomUUID(), status: "undone", after }, flags: [] });
  }
  if (p[2] === "changes" && m === "POST" && p[4] === "withdraw" && db.plan_proposed?.includes(p[3])) {
    db.plan_proposed.splice(db.plan_proposed.indexOf(p[3]), 1);
    return json(200, { change: { id: p[3], status: "declined" }, flags: [] });
  }
  if (p[2] !== "changes" || m !== "POST" || p[3]) return null;
  const body = (await req.clone().json().catch(() => ({}))) as Schemas["SimpleChangeIn"];
  if (!OPS.has(body.op)) return null;
  if (ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  const t = (body.target ?? {}) as Record<string, string>;
  const a = (body.after ?? {}) as Record<string, string | null>;
  const done = (res: Schemas["SimpleChangeResult"], back: () => Record<string, unknown> | void) => {
    if (res.change.status === "applied") (db.plan_done ??= {})[res.change.id] = back;
    else (db.plan_proposed ??= []).push(res.change.id);
    return json(201, res);
  };
  /** A track to Settings › Trash: its features go to no track, kept for a restore (as the API's Trash list, no item ids and no items of its own). */
  const trashTrack = (k: string) => {
    const title = TRACKS[k];
    const own = db.track_owners?.[k];
    const items = db.items.filter((s) => s.track === k);
    for (const s of items) s.track = undefined;
    (db.trashed_tracks ??= {})[k] = { title, state: states[k], owner: own, items: items.map((s) => s.key) };
    delete TRACKS[k];
    const at = now();
    trash().push({
      out: { id: crypto.randomUUID(), root: { type: "track", id: trackId(k), slug: null, title, kind: "Track" }, items: [], deleted_by: ctx.id, deleted_by_name: ctx.names[ctx.id] ?? null, deleted_at: at, reason: null, published: false, purge_after: new Date(Date.parse(at) + 30 * 86_400_000).toISOString() } as never,
      documents: [], versions: [], runs: [], intakes: [], released: { track: k },
    });
  };
  const keyOf = (id: string) => Object.keys(TRACKS).find((k) => trackId(k) === id);
  if (body.op === "restore_goal_milestone") {
    const ms = ((db.goal_milestones ?? []) as MockMilestone[]).find((x) => x.id === t.milestone_id && x.deleted);
    if (!ms) return json(404, { detail: "No such removed milestone" });
    const edits = canEditRoadmap(db, ms.roadmap, ctx);
    if (edits) ms.deleted = false;
    return done(change(ctx, body, edits, ctx.owners, `restored the milestone ${ms.name}`), () => void (ms.deleted = true));
  }
  if (body.op === "add_track") {
    const title = (a.title ?? "").trim();
    if (!title) return json(422, { detail: "A track needs a name" });
    const prd = Object.values(ROADMAPS).find((r) => prdId(r.prd) === a.prd_id)?.prd;
    if (!prd) return json(422, { detail: "Pick the track's PRD" });
    let added = "";
    if (owner) {
      const k = (added = `added-${Object.keys(TRACKS).length + 1}`);
      setTitle(db, k, title);
      states[k] = { status: "active", prd };
      if (a.owner_id) (db.track_owners ??= {})[k] = a.owner_id;
    }
    // Undo removes the track while it holds nothing; one that anything references since goes to Trash.
    return done(change(ctx, body, owner, ctx.owners, `added the track ${title}`), () => {
      if (!(added in TRACKS)) return;
      if (db.items.some((s) => s.track === added) || heldElsewhere(trackId(added))) return (trashTrack(added), { in_trash: true });
      delete TRACKS[added];
      delete db.track_titles?.[added];
      delete states[added];
      delete db.track_owners?.[added];
    });
  }
  const k = keyOf(t.track_id ?? "");
  if (!k) return json(404, { detail: "No such track" });
  const own = db.track_owners?.[k];
  const decides = owner || (own === ctx.id && RANK[ctx.role] >= RANK.approver);
  const route = own && own !== ctx.id ? [own] : ctx.owners;
  const title = TRACKS[k];
  if (body.op === "delete_track") {
    if (decides) trashTrack(k);
    return done(change(ctx, body, decides, route, `moved the track ${title} to Trash`), () => {
      const e = trash().find((x) => (x.released as { track?: string } | undefined)?.track === k);
      if (e && restoreTrack(db, e.released)) trash().splice(trash().indexOf(e), 1);
    });
  }
  if (body.op === "edit_track") {
    const words =
      a.title != null ? `renamed the track ${title} to ${a.title}` : a.status != null ? `${a.status === "active" ? "resumed" : a.status === "paused" ? "paused" : "closed"} the track ${title}` : `set ${title}'s owner to ${name(a.owner_id ?? undefined) ?? "no one"}`;
    const was = { title, status: states[k].status, owner: own };
    const back = () => {
      if (!(k in TRACKS)) return;
      setTitle(db, k, was.title);
      states[k].status = was.status;
      if (was.owner) (db.track_owners ??= {})[k] = was.owner;
      else delete db.track_owners?.[k];
    };
    if (decides) {
      if (a.title != null && a.title.trim()) setTitle(db, k, a.title.trim());
      if (a.status != null) states[k].status = a.status as Status;
      if ("owner_id" in a) {
        db.track_owners ??= {};
        if (a.owner_id) db.track_owners[k] = a.owner_id;
        else delete db.track_owners[k];
      }
    }
    return done(change(ctx, body, decides, route, words), back);
  }
  return null;
}

/** Settings › Trash's Restore of a track: it and the features that were on it come back. */
export function restoreTrack(db: Db, released: unknown): boolean {
  const k = (released as { track?: string } | undefined)?.track;
  const t = k ? db.trashed_tracks?.[k] : undefined;
  if (!k || !t) return false;
  setTitle(db, k, t.title);
  (db.track_state ??= {})[k] = t.state;
  if (t.owner) (db.track_owners ??= {})[k] = t.owner;
  for (const s of db.items) if (t.items.includes(s.key) && !s.track) s.track = k;
  delete db.trashed_tracks![k];
  return true;
}

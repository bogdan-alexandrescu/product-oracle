/**
 * Mock of Simple's removed list and tracks (oracle.simple.removed, oracle.simple.plan_changes):
 * GET /v1/simple/removed, GET /v1/simple/tracks, and the change ops restore_goal_milestone,
 * add_track, edit_track, move_track and delete_track through POST /v1/simple/changes. A cut feature is put
 * back with the engine's own "restore" op, an archived goal with the goal asks' unarchive_goal
 * (./simple-changes.ts).
 */
import type { Schemas } from "@/lib/api/client";

import { mockNowMs } from "./clock";
import { lazyGoalBuckets, seedGoalBuckets } from "./goal-buckets";
import { stableUuid } from "./ids";
import { canDecideItem, canEditRoadmap, closed, deciderIds, GOALS, readerDb, ROADMAPS, TRACKS, trackGoal, trackKeys, trackPlace, type SimpleDb } from "./simple-roadmap";
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
  /** Its PRD's title; "" when it has none (tracks-goal: a track's PRD is optional). */
  prd: string;
  /** tracks-goal (owner Nov 9): its further PRDs, after its first (a track holds many; a PRD is on one track). */
  more?: string[];
  /** tracks-goal: the company goal it is tied to (a goal bucket's id). */
  goal?: string | null;
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
  /** `published`: per open draft, the keys of its published items that were on the track (trash.delete_track clears both). */
  trashed_tracks?: Record<string, { title: string; state: TrackState; owner?: string; items: string[]; published?: Record<string, string[]> }>;
  /** tracks-goal: the PRD Oracle suggests a track for in the Inbox ("" none). */
  track_suggestion?: string;
};

/** tracks-goal (owner Nov 9): the open proposed track change that puts this PRD (an id) on a track, if any (as plan_changes.waiting_for). */
function askedFor(db: Db, prd: string): Schemas["SimpleChangeOut"] | undefined {
  return (db.changes ?? []).find((c) => c.status === "proposed" && (c.op === "add_track" || c.op === "edit_track") && ((c.after as { add_prd_id?: string }).add_prd_id === prd || ((c.after as { prd_ids?: string[] }).prd_ids ?? []).includes(prd)));
}
/** tracks-goal: PRDs (ids) put on a track directly close the open proposals that asked to put them on one: declined by who placed them (as plan_changes._close_asked). */
const closeAsked = (db: Db, by: string, prds: string[]) => {
  for (const p of prds) {
    const c = askedFor(db, p);
    if (c) Object.assign(c, { status: "declined", decided_by: by, decided_at: now(), can_decide: false });
  }
};
/** A proposed track change for any of these PRDs (ids), not decided yet (plan_changes._asked; a removal counts too). */
const asked = (db: Db, prds: string[]) => prds.some((p) => askedFor(db, p) || (db.changes ?? []).some((c) => c.status === "proposed" && c.op === "edit_track" && (c.after as { remove_prd_id?: string }).remove_prd_id === p));

/** The company's goals a track may be tied to: neither archived nor in Trash, in their order. */
const liveGoals = (db: Db) => (db.goal_buckets ??= lazyGoalBuckets()).goals.filter((g) => !g.archived && !g.trashed).sort((a, b) => a.order - b.order);
/** tracks-goal: a track's PRDs, its first one first. */
export const prdsOf = (st: TrackState | undefined): string[] => (st ? [st.prd, ...(st.more ?? [])].filter(Boolean) : []);
const setPrds = (st: TrackState, titles: string[]) => {
  st.prd = titles[0] ?? "";
  st.more = titles.slice(1);
};
/** The accepted PRDs, by title. */
const allPrds = () => [...new Set(Object.values(ROADMAPS).map((r) => r.prd))].filter(Boolean).sort();
/** The live track a PRD is on, if any. */
const trackOfPrd = (states: Record<string, TrackState>, title: string) => Object.keys(TRACKS).find((k) => prdsOf(states[k]).includes(title));
/** A PRD a track may take (as takeable_prds: accepted, not on a track in Trash; one on another track moves from it). */
const takeablePrd = (db: Db, id: string): string | undefined => {
  const trashed = new Set(Object.values(db.trashed_tracks ?? {}).flatMap((x) => prdsOf(x.state)));
  return allPrds().find((t) => prdId(t) === id && !trashed.has(t));
};
/** The PRD a roadmap item belongs to: its own, else its roadmap's. */
const prdOfItem = (s: SimpleDb["items"][number]) => s.prd_doc?.title ?? ROADMAPS[s.roadmap]?.prd ?? "";

/**
 * tracks-goal (owner Nov 9): "Oracle suggests, person confirms". An accepted PRD on no track, whose
 * features read under No track, gets one Inbox item for the company's owners (the mock's PRD owners):
 * the track that fits it best (the first live one), Confirm, Pick a track, New track. Seeded once,
 * for the first such PRD (the "track-suggestion" scenario); it leaves the Inbox once the PRD is on a track.
 */
export function trackSuggestionRows(db: Db, ctx: RemovedCtx, seen: string | null | undefined, seeded: boolean, prdOwners: string[] = ctx.owners): Schemas["InboxSimpleTrackSuggestion"][] {
  if (!prdOwners.includes(ctx.id) || (!seeded && !db.track_suggestion)) return [];
  const states = trackStates(db);
  db.track_suggestion ??= allPrds().find((t) => !trackOfPrd(states, t) && db.items.some((s) => !s.track && prdOfItem(s) === t)) ?? "";
  const prd = db.track_suggestion;
  if (!prd || trackOfPrd(states, prd)) return [];
  const live = Object.keys(TRACKS)
    .filter((k) => states[k].status !== "closed")
    .map((k) => ({ id: trackId(k), title: TRACKS[k] }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const at = daysAgo(1);
  // A track someone else decides was asked for: it waits for them (no actions, not counted).
  const c = askedFor(db, prdId(prd));
  const onto = c ? live.find((t) => t.id === (c.target as { track_id?: string }).track_id) : undefined;
  const proposed = c ? { change_id: c.id, track: onto ?? null, title: onto?.title ?? String((c.after as { title?: string }).title ?? ""), to_name: c.routed_to.map((x) => ctx.names[x]).filter(Boolean).join(", ") || null } : null;
  return [{ id: stableUuid(`simple-track-suggestion/${prd}`), prd: { id: prdId(prd), title: prd }, track: live[0] ?? null, tracks: live, at, state: !seen || at > seen ? "new" : "open", proposed }];
}

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
  const gb = (db.goal_buckets ??= lazyGoalBuckets());
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
    // The PRD of its first item: the item's own (prd_doc), else its roadmap's; one company roadmap holds many PRDs' items.
    const on = db.items.find((s) => s.track === k);
    db.track_state[k] ??= { status: k === "welcome" ? "paused" : "active", prd: on ? (on.prd_doc?.title ?? ROADMAPS[on.roadmap]?.prd ?? "") : "" };
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

/** replaced-prd-history (company.history_track_ids): a replaced PRD's own track and its roadmap's track are history, not in Tracks. */
function historyKeys(db: Db, states: Record<string, TrackState>): Set<string | undefined> {
  const history = new Set(db.history_roadmaps ?? []);
  const replaced = new Set(db.replaced_prd_titles ?? []);
  return new Set([
    ...Object.entries(db.extra_roadmaps ?? {}).filter(([slug]) => history.has(slug)).map(([, r]) => r.track),
    ...Object.keys(TRACKS).filter((k) => replaced.has(states[k]?.prd)),
  ]);
}

const OPS = new Set(["restore_goal_milestone", "add_track", "edit_track", "move_track", "delete_track"]);

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
      const cuts = (c: { op: string; after: { [key: string]: unknown } }) => c.op === "cut" || c.op === "cut_with_dependents" || (c.op === "set_status" && c.after.cut === true);
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
    // replaced-prd-history (company.history_track_ids): a replaced PRD's own track and its
    // roadmap's track are history.
    const gone = historyKeys(db, states);
    // Roadmap Nov 10 (removed.list_simple_tracks): a track's counts are what the reader's
    // Roadmap shows, the working draft for one who reads it, else the published items.
    const shown = readerDb(db, ctx).items;
    // Tracks sheet review (Nov 11): Move to Trash also clears the published items the reader's draft moved
    // off the track; moves_count counts them (each once), draft_off_count names them.
    const shownKeys = new Set(shown.map((s) => s.key));
    const drafted = new Set(openDrafts(db).map((d) => d.roadmap));
    const published = [...db.items.filter((s) => !drafted.has(s.roadmap)), ...openDrafts(db).flatMap((d) => d.published.items)];
    const offOf = (k: string) => {
      const on = new Set(shown.filter((s) => s.track === k).map((s) => s.key));
      return new Set(published.filter((s) => s.track === k && shownKeys.has(s.key) && !on.has(s.key)).map((s) => s.key)).size;
    };
    // track-order: in the company's track order (order, 1 = first).
    const tracks = trackKeys(db).filter((k) => !gone.has(k)).map((k) => {
      const title = TRACKS[k];
      const own = db.track_owners?.[k];
      const decides = owner || (own === ctx.id && RANK[ctx.role] >= RANK.approver);
      const st = states[k];
      return { id: trackId(k), title, status: st.status, owner_id: own ?? null, owner_name: name(own), prd_id: st.prd ? prdId(st.prd) : null, prd_title: st.prd || null, prds: prdsOf(st).map((t) => ({ id: prdId(t), title: t })), ...trackGoal(db, k), can_decide: decides, decider_name: decides ? null : (name(own) ?? deciderName), feature_count: shown.filter((s) => s.track === k && !closed(s)).length, moves_count: shown.filter((s) => s.track === k).length + offOf(k), draft_off_count: offOf(k), order: trackPlace(db, k) };
    });
    // As takeable_prds: every accepted PRD not on a track in Trash, with the track it is on now.
    const prds = allPrds()
      .filter((t) => takeablePrd(db, prdId(t)))
      .map((t) => {
        const on = trackOfPrd(states, t);
        return { id: prdId(t), title: t, track_id: on ? trackId(on) : null, track_title: on ? TRACKS[on] : null };
      });
    const people = Object.entries(ctx.names).map(([id, n]) => ({ id, name: n }));
    // tracks-goal: the company's live goals a track may be tied to (goal_buckets._goals).
    const goals = liveGoals(db).map((g) => ({ id: g.id, name: g.title }));
    return json(200, { tracks, can_add: owner, add_decider_name: owner ? null : deciderName, people, prds, goals });
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
  // tracks-goal (owner Nov 9): accepting a proposed track change (in the decider's Inbox) applies it as it is then, putting on or
  // taking off only its PRD; ./simple-changes.ts then marks it accepted.
  const proposal = p[2] === "changes" && m === "POST" && p[4] === "accept" ? (db.changes ?? []).find((c) => c.id === p[3] && c.status === "proposed" && (c.op === "add_track" || c.op === "edit_track" || c.op === "move_track")) : undefined;
  if (proposal && ctx.role !== "owner" && !proposal.routed_to.includes(ctx.id)) return null;
  if (!proposal && (p[2] !== "changes" || m !== "POST" || p[3])) return null;
  const body = (proposal ? { op: proposal.op, target: proposal.target, before: {}, after: proposal.after } : await req.clone().json().catch(() => ({}))) as Schemas["SimpleChangeIn"];
  if (!OPS.has(body.op)) return null;
  if (ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  const t = (body.target ?? {}) as Record<string, string>;
  const a = (body.after ?? {}) as Record<string, string | null>;
  const ids = (body.after ?? {}) as { prd_ids?: string[]; add_prd_id?: string };
  /** Every track's PRDs and every item's track as now, for an Undo that puts moved PRDs back. */
  const snapshot = () => {
    const prds = Object.fromEntries(Object.entries(states).map(([k, st]) => [k, prdsOf(st)]));
    const tracks = db.items.map((s) => s.track);
    return () => {
      for (const [k, list] of Object.entries(prds)) if (states[k]) setPrds(states[k], list);
      db.items.forEach((s, n) => (s.track = tracks[n]));
    };
  };
  /** Puts PRDs on track k (each moves from the track it was on); its features on no track take k, as ensure_track adopts them. */
  const putPrds = (k: string, titles: string[]) => {
    for (const t of titles) {
      const from = trackOfPrd(states, t);
      if (from && from !== k) setPrds(states[from], prdsOf(states[from]).filter((x) => x !== t));
    }
    setPrds(states[k], titles);
    for (const s of db.items) if (!s.track && titles.includes(prdOfItem(s))) s.track = k;
  };
  const done = (res: Schemas["SimpleChangeResult"], back: () => Record<string, unknown> | void, waits = false) => {
    if (res.change.status === "applied") (db.plan_done ??= {})[res.change.id] = back;
    else (db.plan_proposed ??= []).push(res.change.id);
    // tracks-goal (owner Nov 9): it waits in its decider's Inbox (simple_proposals), to accept or decline there.
    if (res.change.status === "proposed" && waits) (db.changes ??= []).push(res.change);
    return json(201, res);
  };
  /** A track to Settings › Trash: its features go to no track, kept for a restore (as the API's Trash list, no item ids and no items of its own). */
  const trashTrack = (k: string) => {
    const title = TRACKS[k];
    const own = db.track_owners?.[k];
    const items = db.items.filter((s) => s.track === k);
    for (const s of items) s.track = undefined;
    // As trash.delete_track: the published items on it go to no track as well as the open drafts' ones.
    const published: Record<string, string[]> = {};
    for (const d of openDrafts(db)) {
      const on = d.published.items.filter((s) => s.track === k);
      for (const s of on) s.track = undefined;
      if (on.length) published[d.out.id] = on.map((s) => s.key);
    }
    (db.trashed_tracks ??= {})[k] = { title, state: states[k], owner: own, items: items.map((s) => s.key), published };
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
    // tracks-goal: its PRD and goal are optional; a PRD has at most one track.
    const want = ids.prd_ids ?? (a.prd_id ? [a.prd_id] : []);
    const titles = want.map((id) => takeablePrd(db, id));
    if (titles.some((x) => x === undefined)) return json(409, { detail: "That PRD is not accepted yet, or its track is in Trash" });
    if (a.goal_id && !liveGoals(db).some((g) => g.id === a.goal_id)) return json(422, { detail: "after.goal_id: not one of this company's goals" });
    if (!proposal && !owner && asked(db, want)) return json(409, { detail: "A change to that PRD's track waits for a decision already" });
    let added = "";
    const putBack = snapshot();
    const make = () => {
      const k = (added = `added-${Object.keys(TRACKS).length + 1}`);
      setTitle(db, k, title);
      states[k] = { status: "active", prd: "", goal: a.goal_id || null };
      putPrds(k, titles as string[]);
      if (a.owner_id) (db.track_owners ??= {})[k] = a.owner_id;
    };
    if (proposal) return (make(), null);
    if (owner) {
      make();
      closeAsked(db, ctx.id, want);
    }
    // Undo removes the track while it holds nothing; one that anything references since goes to Trash.
    return done(change(ctx, body, owner, ctx.owners, `added the track ${title}`), () => {
      if (!(added in TRACKS)) return;
      putBack();
      if (db.items.some((s) => s.track === added) || heldElsewhere(trackId(added))) return (trashTrack(added), { in_trash: true });
      delete TRACKS[added];
      delete db.track_titles?.[added];
      delete states[added];
      delete db.track_owners?.[added];
    }, titles.length > 0);
  }
  const k = keyOf(t.track_id ?? "");
  if (!k) return json(404, { detail: "No such track" });
  const own = db.track_owners?.[k];
  const decides = owner || (own === ctx.id && RANK[ctx.role] >= RANK.approver);
  const route = own && own !== ctx.id ? [own] : ctx.owners;
  const title = TRACKS[k];
  if (body.op === "move_track") {
    // track-order (plan_changes.move_track): one step up or down the company's track order, not past either end; Undo puts the order back.
    const to = a.to;
    if (to !== "up" && to !== "down") return json(422, { detail: "after.to: up or down" });
    const all = trackKeys(db);
    const shown = all.filter((x) => !historyKeys(db, states).has(x));
    const at = shown.indexOf(k);
    const next = to === "up" ? at - 1 : at + 1;
    if (next < 0 || next >= shown.length) return json(proposal ? 409 : 422, { detail: `${proposal ? "outdated: " : ""}the track is ${to === "up" ? "first" : "last"} already` });
    const was = db.track_order ? [...db.track_order] : undefined;
    const step = () => {
      // As plan_changes._place: the listed tracks swap places; every track keeps a place number.
      const [i, j] = [all.indexOf(shown[at]), all.indexOf(shown[next])];
      [all[i], all[j]] = [all[j], all[i]];
      db.track_order = all;
    };
    if (proposal) return (step(), null);
    if (decides) step();
    return done(change(ctx, { ...body, target: { ...t, title } }, decides, route, `moved the track ${title} ${to}`), () => void (db.track_order = was), true);
  }
  if (body.op === "delete_track") {
    if (decides) trashTrack(k);
    return done(change(ctx, body, decides, route, `moved the track ${title} to Trash`), () => {
      const e = trash().find((x) => (x.released as { track?: string } | undefined)?.track === k);
      if (e && restoreTrack(db, e.released)) trash().splice(trash().indexOf(e), 1);
    });
  }
  if (body.op === "edit_track" && (ids.add_prd_id || (a as { remove_prd_id?: string }).remove_prd_id)) {
    // tracks-goal (owner Nov 9): one PRD put on (add_prd_id) or taken off (remove_prd_id); the change holds only it, so accepting it later leaves the track's other PRDs as they are then.
    const adding = !!ids.add_prd_id;
    const prd = takeablePrd(db, (ids.add_prd_id ?? (a as { remove_prd_id?: string }).remove_prd_id)!);
    if (!prd) return json(409, { detail: "That PRD is not accepted yet, or its track is in Trash" });
    if (adding === prdsOf(states[k]).includes(prd)) return json(proposal ? 409 : 422, { detail: proposal ? "outdated: that PRD's track changed since" : `that PRD is ${adding ? "on" : "not on"} the track already` });
    if (proposal) return (putPrds(k, adding ? [...prdsOf(states[k]), prd] : prdsOf(states[k]).filter((x) => x !== prd)), null);
    if (!decides && asked(db, [prdId(prd)])) return json(409, { detail: "A change to that PRD's track waits for a decision already" });
    const putBack = snapshot();
    if (decides) putPrds(k, adding ? [...prdsOf(states[k]), prd] : prdsOf(states[k]).filter((x) => x !== prd));
    if (decides && adding) closeAsked(db, ctx.id, [prdId(prd)]);
    const res = change(ctx, { ...body, target: { ...t, title, prd_titles: { [prdId(prd)]: prd } } }, decides, route, `${adding ? "put" : "took"} ${prd} ${adding ? "on" : "off"} ${title}`);
    return done(res, putBack, true);
  }
  if (body.op === "edit_track") {
    // tracks-goal: a PRD set is a free one; a goal a live one.
    // tracks-goal (owner Nov 9): prd_ids is its PRDs (prd_id one); one on another track moves from it.
    const want = ids.prd_ids ?? ("prd_id" in a ? (a.prd_id ? [a.prd_id] : []) : undefined);
    const titles = want?.map((id) => takeablePrd(db, id));
    if (titles?.some((x) => x === undefined)) return json(409, { detail: "That PRD is not accepted yet, or its track is in Trash" });
    const was0 = prdsOf(states[k]);
    const put = (titles ?? []).filter((x) => x && !was0.includes(x)) as string[];
    const off = titles ? was0.filter((x) => !titles.includes(x)) : [];
    const goal = a.goal_id ? liveGoals(db).find((g) => g.id === a.goal_id) : undefined;
    if (a.goal_id && !goal) return json(422, { detail: "after.goal_id: not one of this company's goals" });
    const words =
      a.title != null
        ? `renamed the track ${title} to ${a.title}`
        : a.status != null
          ? `${a.status === "active" ? "resumed" : a.status === "paused" ? "paused" : "closed"} the track ${title}`
          : "goal_id" in a
            ? goal ? `tied ${title} to the goal ${goal.title}` : `took the goal off ${title}`
            : titles
              ? put.length ? `put ${put.join(", ")} on ${title}` : off.length ? `took ${off.join(", ")} off ${title}` : `kept ${title}'s PRDs`
              : `set ${title}'s owner to ${name(a.owner_id ?? undefined) ?? "no one"}`;
    const was = { title, status: states[k].status, owner: own, goal: states[k].goal ?? null };
    const putBack = snapshot();
    const back = () => {
      if (!(k in TRACKS)) return;
      setTitle(db, k, was.title);
      states[k].status = was.status;
      putBack();
      states[k].goal = was.goal;
      if (was.owner) (db.track_owners ??= {})[k] = was.owner;
      else delete db.track_owners?.[k];
    };
    if (decides) {
      if ("goal_id" in a) states[k].goal = goal?.id ?? null;
      if (titles) putPrds(k, titles as string[]);
      closeAsked(db, ctx.id, put.map(prdId));
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
/** The roadmaps' open drafts (drafts.OPEN), each holding its published items. */
const openDrafts = (db: SimpleDb) => (db.drafts ?? []).filter((d) => ["working", "submitted"].includes(d.out.status));

export function restoreTrack(db: Db, released: unknown): boolean {
  const k = (released as { track?: string } | undefined)?.track;
  const t = k ? db.trashed_tracks?.[k] : undefined;
  if (!k || !t) return false;
  setTitle(db, k, t.title);
  (db.track_state ??= {})[k] = t.state;
  if (t.owner) (db.track_owners ??= {})[k] = t.owner;
  for (const s of db.items) if (t.items.includes(s.key) && !s.track) s.track = k;
  for (const d of openDrafts(db)) for (const s of d.published.items) if (t.published?.[d.out.id]?.includes(s.key) && !s.track) s.track = k;
  delete db.trashed_tracks![k];
  return true;
}

// build-milestones-on-roadmap: a roadmap's milestones per goal, as the API has them
// (api/oracle/simple/goal_milestones.py: rows of track_milestones with a roadmap and a goal).
// Invented goals, items and people only.

import type { components } from "../schema";

import { stableUuid } from "./ids";

type Schemas = components["schemas"];
export type Progress = Schemas["SimpleGoalMilestone"]["progress"];

export interface MockMilestone {
  id: string;
  roadmap: string;
  code: string;
  name: string;
  date: string | null;
  goal: string | null;
  /** The item keys it waits on. */
  gates: string[];
  counts_when: string;
  progress: Progress;
  /** The PRD it comes from (slug), drawn hollow; a change to it asks the PRD's owner. */
  prd?: { slug: string; title: string; owner: string } | null;
  pending?: Schemas["SimpleMilestonePending"] | null;
  deleted?: boolean;
  /** old-milestones: carried onto the company roadmap (its copy's id), or dropped by an owner. */
  carried_to?: string;
  dropped?: boolean;
  /** Its copy on the company roadmap: the older roadmap it came from (slug). */
  carried_from?: string;
}

/** What the old-milestones read and routes need of the roadmap db (./simple-roadmap.ts). */
export interface OldCtx {
  company: string | undefined;
  /** The company roadmap's items (key -> title), as Simple shows them. */
  companyItems: Map<string, string>;
  roadmapTitle: (slug: string) => string;
  goalTitle: (key: string) => string | null;
}

/** old-milestones (api/oracle/simple/old_milestones.py): the older roadmaps' own goal milestones not on the company roadmap yet. */
const stillOld = (list: MockMilestone[], ctx: OldCtx) => (ctx.company ? list.filter((m) => m.roadmap !== ctx.company && !m.prd && !m.deleted && !m.carried_to && !m.dropped) : []);
const leftOn = (m: MockMilestone, ctx: OldCtx) => m.gates.filter((k) => ctx.companyItems.has(k));
const needsCall = (m: MockMilestone, ctx: OldCtx) => m.gates.length > 0 && leftOn(m, ctx).length === 0;

/** SimpleRoadmapOut.old_milestones: an owner's alone (anyone else reads nothing to act on). */
export function oldMilestonesOut(list: MockMilestone[], role: string, ctx: OldCtx): Schemas["SimpleOldMilestones"] {
  if (role !== "owner") return { can_act: false, moves: [], needs_call: [] };
  const rows = stillOld(list, ctx).sort((a, b) => ((a.date ?? "9999") < (b.date ?? "9999") ? -1 : (a.date ?? "9999") > (b.date ?? "9999") ? 1 : a.name.localeCompare(b.name)));
  const out = (m: MockMilestone): Schemas["SimpleOldMilestone"] => ({
    id: m.id,
    name: m.name,
    date: m.date,
    goal_id: m.goal ? stableUuid(`simple-goal/${m.goal}`) : null,
    goal_title: m.goal ? ctx.goalTitle(m.goal) : null,
    from_roadmap: { id: stableUuid(`simple-doc/${m.roadmap}`), slug: m.roadmap, title: ctx.roadmapTitle(m.roadmap) },
    items: leftOn(m, ctx).map((k) => ctx.companyItems.get(k)!),
  });
  return { can_act: true, moves: rows.filter((m) => !needsCall(m, ctx)).map(out), needs_call: rows.filter((m) => needsCall(m, ctx)).map(out) };
}

/** POST /v1/simple/roadmap/milestones/carry-over and /{id}/keep|drop (owner only). */
function routeOld(list: MockMilestone[], me: { role: string }, req: Request, p: string[], ctx: OldCtx): Response | null {
  const carry = p[4] === "carry-over" && !p[5];
  const decide = !!p[4] && (p[5] === "keep" || p[5] === "drop");
  if (req.method !== "POST" || !(carry || decide)) return null;
  if (me.role !== "owner") return json(403, { detail: "Requires the owner role" });
  const copy = (m: MockMilestone, gates: string[]): string => {
    const n = list.filter((x) => x.roadmap === ctx.company && x.goal === m.goal && !x.prd && !x.deleted).reduce((a, x) => Math.max(a, Number(x.code.slice(1)) || 0), 0);
    const id = stableUuid(`simple-gm-carried/${m.id}`);
    list.push({ id, roadmap: ctx.company!, code: `M${n + 1}`, name: m.name, date: m.date, goal: m.goal, gates, counts_when: m.counts_when, progress: m.progress, carried_from: m.roadmap });
    m.carried_to = id;
    return id;
  };
  const done = (carried: string[]) => json(200, { carried, old_milestones: oldMilestonesOut(list, me.role, ctx) });
  if (carry) return done(stillOld(list, ctx).filter((m) => !needsCall(m, ctx)).map((m) => copy(m, leftOn(m, ctx))));
  const m = stillOld(list, ctx).find((x) => x.id === p[4]);
  if (!m) return list.some((x) => x.id === p[4]) ? json(409, { detail: "That milestone is not waiting on a call" }) : json(404, { detail: "No such milestone" });
  if (!needsCall(m, ctx)) return json(409, { detail: "That milestone still has items: bring it over with the rest" });
  if (p[5] === "keep") return done([copy(m, [])]);
  m.dropped = true;
  return done([]);
}


/** The roadmap's own milestones on the goals' ladders (the "simple-milestones" scenario). */
export function seedOwnMilestones(): MockMilestone[] {
  return [
    { id: stableUuid("simple-gm/m1"), roadmap: "alerts-roadmap", code: "M1", name: "Alerts live for 50 teams", date: "2026-11-20", goal: "grow-retention", gates: ["alert-rules"], counts_when: "Holds 7 days in a row", progress: "on_track" },
    { id: stableUuid("simple-gm/m2"), roadmap: "alerts-roadmap", code: "M2", name: "60% of teams active at day 90", date: "2026-12-22", goal: "grow-retention", gates: ["alert-digest", "alert-mobile"], counts_when: "Holds 14 days in a row on all teams", progress: "at_risk" },
    { id: stableUuid("simple-gm/a1"), roadmap: "onboarding-roadmap", code: "M1", name: "First alert within a day", date: "2026-12-04", goal: "faster-activation", gates: ["setup-checklist", "setup-import"], counts_when: "Holds 7 days in a row", progress: "on_track" },
  ];
}

/** A PRD's own milestones ("Usage alerts"), dated from its approved roadmap version; one has no date. */
export function seedPrdMilestones(): MockMilestone[] {
  const prd = { slug: "usage-alerts", title: "Usage alerts", owner: "Nora Vance" };
  return [
    ...seedOwnMilestones().filter((m) => m.goal !== "grow-retention"),
    { id: stableUuid("simple-gm/p1"), roadmap: "alerts-roadmap", code: "M1", name: "Rules in beta", date: "2026-11-27", goal: "grow-retention", gates: ["alert-rules"], counts_when: "10 beta teams use it for a week", progress: "on_track", prd },
    { id: stableUuid("simple-gm/p2"), roadmap: "alerts-roadmap", code: "M2", name: "Digest for all teams", date: "2026-12-15", goal: "grow-retention", gates: ["alert-digest"], counts_when: "Sent to every team 2 weeks in a row", progress: "at_risk", prd },
    { id: stableUuid("simple-gm/p3"), roadmap: "alerts-roadmap", code: "M3", name: "Push on phones", date: "2027-01-12", goal: "grow-retention", gates: ["alert-mobile"], counts_when: "Live on both phone apps", progress: "not_started", prd },
    { id: stableUuid("simple-gm/p4"), roadmap: "alerts-roadmap", code: "M4", name: "Routing by team", date: "2027-03-01", goal: "grow-retention", gates: ["alert-sso"], counts_when: "Used by 20 teams", progress: "not_started", prd },
    { id: stableUuid("simple-gm/p5"), roadmap: "alerts-roadmap", code: "M5", name: "Alerts in the admin app", date: null, goal: "grow-retention", gates: [], counts_when: "", progress: "not_started", prd },
  ];
}

/**
 * old-milestones ("old-milestones" scenario, on top of "one-roadmap"): the older Trust plan
 * roadmap's own goal milestones, not on the company roadmap yet. Two still have items there
 * (one only part of them); "Seller badge pilot" waits on the badge alone, which is not.
 */
export function seedOldMilestones(oldRoadmap: string): MockMilestone[] {
  const at = (n: string, code: string, name: string, date: string, goal: string, gates: string[]): MockMilestone => ({ id: stableUuid(`simple-gm/old/${n}`), roadmap: oldRoadmap, code, name, date, goal, gates, counts_when: "Holds 7 days in a row", progress: "not_started" });
  return [
    at("safety", "M1", "Safety tools in beta", "2026-11-27", "grow-retention", ["report-button", "block-list"]),
    at("scale", "M2", "Ready for twice the load", "2026-12-11", "grow-retention", ["read-replicas", "trusted-badge"]),
    at("badge", "M1", "Seller badge pilot", "2026-11-20", "faster-activation", ["trusted-badge"]),
  ];
}

export function milestoneOut(m: MockMilestone, ids: Record<string, string>, canChange: boolean, titleOf: (slug: string) => string = (slug) => slug): Schemas["SimpleGoalMilestone"] {
  return {
    id: m.id,
    roadmap_id: stableUuid(`simple-doc/${m.roadmap}`),
    code: m.code,
    name: m.name,
    date: m.date,
    goal_id: m.goal ? stableUuid(`simple-goal/${m.goal}`) : null,
    item_ids: m.gates.map((k) => ids[k]).filter(Boolean),
    counts_when: m.counts_when,
    progress: m.progress,
    prd: m.prd ? { id: stableUuid(`simple-doc/${m.prd.slug}`), slug: m.prd.slug, title: m.prd.title } : null,
    prd_owner: m.prd?.owner ?? null,
    pending: m.pending ?? null,
    can_change: canChange,
    carried_from: m.carried_from ? { id: stableUuid(`simple-doc/${m.carried_from}`), slug: m.carried_from, title: titleOf(m.carried_from) } : null,
  };
}

const json = (status: number, body: unknown): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** POST/PATCH/DELETE /v1/simple/roadmap/milestones[/{id}[/restore]], as oracle.simple.router. */
export async function routeMilestones(
  db: { goal_milestones?: MockMilestone[]; ids: Record<string, string> },
  me: { role: string; name?: string },
  req: Request,
  p: string[],
  slugOf: (id: string) => string | null,
  canEdit: (roadmap: string) => boolean,
  isHistory: (roadmap: string) => boolean = () => false,
  old?: OldCtx,
): Promise<Response | null> {
  if (p[3] !== "milestones") return null;
  const list = (db.goal_milestones ??= []);
  const carried = old ? routeOld(list, me, req, p, old) : null;
  if (carried) return carried;
  const keyOf = (id: string) => Object.keys(db.ids).find((k) => db.ids[k] === id);
  const goalKey = (id: string | null | undefined, goals: string[]) => (id ? (goals.find((g) => stableUuid(`simple-goal/${g}`) === id) ?? null) : null);
  const GOAL_KEYS = ["grow-retention", "faster-activation", "quiet-alerts"];
  // A viewer changes nothing (Commenter); a commenter only asks a PRD's owner (goal_milestones._may_propose).
  if (me.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  const history = json(409, { detail: "That roadmap is history" });
  if (!p[4] && req.method === "POST") {
    const b = (await req.json()) as Schemas["SimpleGoalMilestoneIn"];
    const roadmap = slugOf(b.roadmap_id);
    if (!roadmap) return json(404, { detail: "No such roadmap" });
    if (isHistory(roadmap)) return history;
    if (!canEdit(roadmap)) return json(403, { detail: "Only the roadmap's owners change its milestones" });
    const goal = goalKey(b.goal_id, GOAL_KEYS);
    const n = list.filter((m) => m.roadmap === roadmap && m.goal === goal && !m.prd).reduce((a, m) => Math.max(a, Number(m.code.slice(1)) || 0), 0);
    const m: MockMilestone = { id: stableUuid(`simple-gm/${roadmap}/${goal}/${list.length}/${b.name}`), roadmap, code: `M${n + 1}`, name: b.name, date: b.date, goal, gates: (b.item_ids ?? []).map(keyOf).filter((k): k is string => !!k), counts_when: b.counts_when ?? "", progress: "not_started" };
    list.push(m);
    return json(201, milestoneOut(m, db.ids, true));
  }
  const m = list.find((x) => x.id === p[4]);
  if (!m) return json(404, { detail: "No such milestone" });
  if (!p[5] && req.method === "PATCH") {
    if (m.deleted) return json(404, { detail: "No such milestone" });
    if (isHistory(m.roadmap)) return history;
    const b = (await req.json()) as Schemas["SimpleGoalMilestonePatch"];
    if (m.prd) {
      // Its name, goal and items are the PRD's own: only date and counts_when are proposed.
      const sent = Object.keys(b);
      if (sent.some((k) => k === "name" || k === "goal_id" || k === "item_ids") || !sent.some((k) => k === "date" || k === "counts_when"))
        return json(422, { detail: "A PRD's milestone: only date and counts_when may be proposed (name, goal and items are the roadmap's own)" });
      // A change to the PRD's milestone asks its owner (a proposed change to the PRD); it stays put.
      m.pending = b.date === m.date && !b.counts_when ? null : { date: b.date ?? m.date, counts_when: b.counts_when ?? null, asked_of: m.prd.owner, change_id: stableUuid(`simple-gm-change/${m.id}/${b.date}`) };
      return json(200, milestoneOut(m, db.ids, true));
    }
    if (!canEdit(m.roadmap)) return json(403, { detail: "Only the roadmap's owners change its milestones" });
    if (b.name != null) m.name = b.name;
    if (b.date != null) m.date = b.date;
    if (b.goal_id !== undefined) m.goal = goalKey(b.goal_id, GOAL_KEYS);
    if (b.item_ids != null) m.gates = b.item_ids.map(keyOf).filter((k): k is string => !!k);
    if (b.counts_when != null) m.counts_when = b.counts_when;
    return json(200, milestoneOut(m, db.ids, true));
  }
  if (!p[5] && req.method === "DELETE" && m.prd) return json(409, { detail: "This milestone is the PRD's: it changes in the PRD" });
  if (!canEdit(m.roadmap)) return json(403, { detail: "Only the roadmap's owners change its milestones" });
  if (p[5] === "restore" && req.method === "POST") {
    m.deleted = false;
    return json(200, milestoneOut(m, db.ids, true));
  }
  if (!p[5] && req.method === "DELETE") {
    m.deleted = true;
    return json(204, null);
  }
  return null;
}

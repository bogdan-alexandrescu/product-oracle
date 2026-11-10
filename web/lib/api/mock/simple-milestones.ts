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
  /** The PRD it comes from (slug), drawn hollow; a change to it asks the PRD's owners (its tracks' owners). */
  prd?: { slug: string; title: string } | null;
  pending?: Schemas["SimpleMilestonePending"] | null;
  deleted?: boolean;
  /** old-milestones: carried onto the company roadmap (its copy's id), or dropped by an owner. */
  carried_to?: string;
  dropped?: boolean;
  /** Its copy on the company roadmap: the older roadmap it came from (slug). */
  carried_from?: string;
  /** tb-mk (goal_milestones, migration 0125): its kind and that kind's fields; none: a delivery point. */
  k?: Partial<MockKindFields>;
}

/** tb-mk: the kind fields a milestone stores (SimpleGoalMilestonePatch's). */
export interface MockKindFields {
  kind: Schemas["SimpleGoalMilestone"]["kind"];
  done_when_line: string;
  status_set: Schemas["SimpleGoalMilestone"]["status"] | null;
  status_reason: string | null;
  measure: string | null;
  baseline: number | null;
  target: number | null;
  current: number | null;
  sub_goal_of_id: string | null;
  /** tb-mk (migration 0126): the track it sits on, the panel's Track. */
  home_track_id: string | null;
  from_track_id: string | null;
  to_track_id: string | null;
}
const KIND_KEYS = ["kind", "done_when_line", "status_set", "status_reason", "measure", "baseline", "target", "current", "sub_goal_of_id", "home_track_id", "from_track_id", "to_track_id"] as const;
const kindDefaults = (m: MockMilestone): MockKindFields => ({ kind: m.prd ? "delivery" : m.goal ? "sub_goal" : "delivery", status_set: null, status_reason: null, done_when_line: "", measure: null, baseline: null, target: null, current: null, sub_goal_of_id: null, home_track_id: null, from_track_id: null, to_track_id: null, ...m.k });
/** Writes the kind fields a body names (a status_set of null clears the override and its reason). */
export function writeKind(m: MockMilestone, b: Record<string, unknown>): void {
  for (const key of KIND_KEYS) if (key in b) (m.k ??= {})[key] = b[key] as never;
  if ("status_set" in b && b.status_set == null && !("status_reason" in b && b.status_reason)) (m.k ??= {}).status_reason = null;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (d: string) => `${MONTH[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** tb-mk (goal_milestones.status_of): a person's status wins; a measure at its target is hit, past its
 * date missed; else at risk when work that serves it ends after its date, else on track. */
export function withKindStatus(
  out: Schemas["SimpleGoalMilestone"],
  all: Schemas["SimpleGoalMilestone"][],
  item: (id: string) => { title: string; end: string } | undefined,
  today: string,
  trackTitle: (id: string) => string | null,
): Schemas["SimpleGoalMilestone"] {
  const k = out;
  let status: Schemas["SimpleGoalMilestone"]["status"] = "on_track";
  let reason = "Every piece of work ends by its date";
  const measured = k.kind === "goal" || k.kind === "sub_goal";
  if (k.status_set) {
    status = k.status_set;
    reason = k.status_reason || "Set by a person";
  } else if (measured && k.current != null && k.target != null && (k.target >= (k.baseline ?? -Infinity) ? k.current >= k.target : k.current <= k.target)) {
    status = "hit";
    reason = `Reached ${k.current} on its target ${k.target}`;
  } else if (measured && k.date && today > k.date) {
    status = "missed";
    reason = `Not reached by ${md(k.date)}`;
  } else {
    const late = k.date ? out.item_ids.map(item).find((i) => !!i && i.end > k.date!) : undefined;
    if (late) {
      status = "at_risk";
      reason = `${late.title} ends ${md(late.end)}, after its date ${md(k.date!)}`;
    }
  }
  return { ...out, status, status_reason: reason, home_track_name: k.home_track_id ? trackTitle(k.home_track_id) : null, from_track_name: k.from_track_id ? trackTitle(k.from_track_id) : null, to_track_name: k.to_track_id ? trackTitle(k.to_track_id) : null, sub_goal_ids: all.filter((x) => x.sub_goal_of_id === out.id).map((x) => x.id) };
}

/** What the old-milestones read and routes need of the roadmap db (./simple-roadmap.ts). */
export interface OldCtx {
  company: string | undefined;
  /** The company roadmap's items (key -> title), as Simple shows them. */
  companyItems: Map<string, string>;
  /** The PRDs (slugs) with an item on the company roadmap: their own milestones are read from their plan there. */
  feedingPrds: Set<string>;
  /** An older roadmap's item (roadmap, item key) -> the company item's key it is there: the
   * one with the same feature first, else the same item key (old_milestones._plan). */
  companyKey: (roadmap: string, key: string) => string | undefined;
  roadmapTitle: (slug: string) => string;
  goalTitle: (key: string) => string | null;
}

/** old-milestones (api/oracle/simple/old_milestones.py): the older roadmaps' own goal milestones not on the company roadmap yet. */
const byDate = (a: MockMilestone, b: MockMilestone) => ((a.date ?? "9999") < (b.date ?? "9999") ? -1 : (a.date ?? "9999") > (b.date ?? "9999") ? 1 : a.name.localeCompare(b.name));
const stillOld = (list: MockMilestone[], ctx: OldCtx) => (ctx.company ? list.filter((m) => m.roadmap !== ctx.company && (!m.prd || !ctx.feedingPrds.has(m.prd.slug)) && !m.deleted && !m.carried_to && !m.dropped).sort(byDate) : []);
/** The rows to bring, a PRD milestone held by several older roadmaps once (its first), and each first's twins. */
function firsts(list: MockMilestone[], ctx: OldCtx): { rows: MockMilestone[]; twins: Map<string, MockMilestone[]> } {
  const seen = new Map<string, MockMilestone>();
  const twins = new Map<string, MockMilestone[]>();
  const rows: MockMilestone[] = [];
  for (const m of stillOld(list, ctx)) {
    const first = m.prd ? seen.get(`${m.prd.slug}/${m.code}`) : undefined;
    if (first) twins.set(first.id, [...(twins.get(first.id) ?? []), m]);
    else {
      if (m.prd) seen.set(`${m.prd.slug}/${m.code}`, m);
      rows.push(m);
    }
  }
  return { rows, twins };
}
const leftOn = (m: MockMilestone, ctx: OldCtx) => [...new Set(m.gates.flatMap((k) => ctx.companyKey(m.roadmap, k) ?? []))];
const needsCall = (m: MockMilestone, ctx: OldCtx) => m.gates.length > 0 && leftOn(m, ctx).length === 0;

/** SimpleRoadmapOut.old_milestones: an owner's alone (anyone else reads nothing to act on). */
export function oldMilestonesOut(list: MockMilestone[], role: string, ctx: OldCtx): Schemas["SimpleOldMilestones"] {
  if (role !== "owner") return { can_act: false, moves: [], needs_call: [] };
  const { rows } = firsts(list, ctx);
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
    // Every coded milestone of that goal there, a PRD's too (goal_milestones._next_code).
    const n = list.filter((x) => x.roadmap === ctx.company && x.goal === m.goal && !x.deleted).reduce((a, x) => Math.max(a, Number(x.code.slice(1)) || 0), 0);
    const id = stableUuid(`simple-gm-carried/${m.id}`);
    list.push({ id, roadmap: ctx.company!, code: `M${n + 1}`, name: m.name, date: m.date, goal: m.goal, gates, counts_when: m.counts_when, progress: m.progress, carried_from: m.roadmap });
    for (const x of [m, ...(twins.get(m.id) ?? [])]) x.carried_to = id;
    return id;
  };
  const done = (carried: string[]) => json(200, { carried, old_milestones: oldMilestonesOut(list, me.role, ctx) });
  const { rows, twins } = firsts(list, ctx);
  if (carry) return done(rows.filter((m) => !needsCall(m, ctx)).map((m) => copy(m, leftOn(m, ctx))));
  // A twin's id answers through its first copy.
  const m = rows.find((x) => x.id === p[4] || (twins.get(x.id) ?? []).some((t) => t.id === p[4]));
  if (!m) return list.some((x) => x.id === p[4]) ? json(409, { detail: "That milestone is not waiting on a call" }) : json(404, { detail: "No such milestone" });
  if (!needsCall(m, ctx)) return json(409, { detail: "That milestone still has items: bring it over with the rest" });
  if (p[5] === "keep") return done([copy(m, [])]);
  for (const x of [m, ...(twins.get(m.id) ?? [])]) x.dropped = true;
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
  const prd = { slug: "usage-alerts", title: "Usage alerts" };
  return [
    ...seedOwnMilestones().filter((m) => m.goal !== "grow-retention"),
    { id: stableUuid("simple-gm/p1"), roadmap: "alerts-roadmap", code: "M1", name: "Rules in beta", date: "2026-11-27", goal: "grow-retention", gates: ["alert-rules"], counts_when: "10 beta teams use it for a week", progress: "on_track", prd },
    { id: stableUuid("simple-gm/p2"), roadmap: "alerts-roadmap", code: "M2", name: "Digest for all teams", date: "2026-12-15", goal: "grow-retention", gates: ["alert-digest"], counts_when: "Sent to every team 2 weeks in a row", progress: "at_risk", prd },
    { id: stableUuid("simple-gm/p3"), roadmap: "alerts-roadmap", code: "M3", name: "Push on phones", date: "2027-01-12", goal: "grow-retention", gates: ["alert-mobile"], counts_when: "Live on both phone apps", progress: "not_started", prd },
    { id: stableUuid("simple-gm/p4"), roadmap: "alerts-roadmap", code: "M4", name: "Routing by team", date: "2027-03-01", goal: "grow-retention", gates: ["alert-sso"], counts_when: "Used by 20 teams", progress: "not_started", prd },
    { id: stableUuid("simple-gm/p5"), roadmap: "alerts-roadmap", code: "M5", name: "Alerts in the admin app", date: null, goal: "grow-retention", gates: [], counts_when: "", progress: "not_started", prd },
  ];
}

/** roadmap-decide: a change asked of a PRD's milestone (goal_milestones._propose_prd_change), waiting on the PRD's owners. */
function prdAsk(m: MockMilestone, id: string, after: { date: string | null; counts_when: string | null }, by: string, byName: string, at: string, routed: string[]): Schemas["SimpleChangeOut"] {
  return {
    id, session_id: null, document_id: stableUuid(`simple-doc/${m.prd!.slug}`), op: "edit_goal_milestone", draft_ids: [],
    target: { milestone_id: m.id, roadmap_id: stableUuid(`simple-doc/${m.roadmap}`), name: m.name },
    before: { date: m.date, counts_when: m.counts_when }, after,
    status: "proposed", by, by_name: byName, at,
    decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: routed, undoes_id: null, undone: false,
    can_decide: false, can_undo: false, words: "", from_meeting: null, off_agenda: false,
  } as unknown as Schemas["SimpleChangeOut"];
}

/**
 * stuck-milestone-decline ("simple-prd-milestone-stuck" scenario): M2's first ask (Jan 5, Nov 4)
 * still waits though the milestone now waits on a second (Jan 12): only declining closes it.
 * M4 Routing by team is gone (its row deleted) with an ask on it (Mar 15, Nov 3) still waiting.
 * `routedOf`: the PRD's owners (drafts.who: its tracks' owners), whom the asks are sent to;
 * `nameOf`: a member's name, for the first of them the newer ask waits for.
 */
export function seedStuckPrdAsk(milestones: MockMilestone[], routedOf: (prdSlug: string) => string[], nameOf: (id: string) => string | null): Schemas["SimpleChangeOut"][] {
  const m = milestones.find((x) => x.id === stableUuid("simple-gm/p2"))!;
  const routed = routedOf(m.prd!.slug);
  const by = stableUuid("simple-user/sam-lee");
  const stuck = prdAsk(m, stableUuid("simple-gm-change/stuck/first"), { date: "2027-01-05", counts_when: m.counts_when }, by, "Sam Lee", "2026-11-04T17:00:00Z", routed);
  const next = prdAsk(m, stableUuid("simple-gm-change/stuck/second"), { date: "2027-01-12", counts_when: m.counts_when }, by, "Sam Lee", "2026-11-05T17:00:00Z", routed);
  m.pending = { date: "2027-01-12", counts_when: null, asked_of: routed[0] ? nameOf(routed[0]) : null, change_id: next.id, can_decide: false };
  const at = milestones.findIndex((x) => x.id === stableUuid("simple-gm/p4"));
  const [gone] = milestones.splice(at, 1);
  const orphan = prdAsk(gone, stableUuid("simple-gm-change/stuck/gone"), { date: "2027-03-15", counts_when: gone.counts_when }, by, "Sam Lee", "2026-11-03T17:00:00Z", routed);
  return [orphan, stuck, next];
}

/** Who reads or asks of a PRD's milestone: `prdOwners`, the PRD's owners by its slug in id order
 * (drafts.who, ./simple-roadmap.ts prdOwnerIdsOf); `names`: every member's name by id. */
export interface MilestoneReader {
  role: string;
  id?: string;
  prdOwners?: (prdSlug: string) => string[];
  names?: Record<string, string>;
}

/** goal_milestones._out's prd_owner: the name of the PRD's first owner by person id; null with none. */
const prdOwnerName = (slug: string, me: MilestoneReader | undefined): string | null => {
  const first = me?.prdOwners?.(slug)[0];
  return first ? (me?.names?.[first] ?? null) : null;
};

/** roadmap-decide: whether the reader decides a change asked of the milestone's PRD (one of its owners, or a company owner). */
export const decidesAsk = (m: Pick<MockMilestone, "prd">, me: MilestoneReader | undefined): boolean =>
  !!m.prd && !!me && (me.role === "owner" || (!!me.id && (me.prdOwners?.(m.prd.slug) ?? []).includes(me.id)));

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

export function milestoneOut(m: MockMilestone, ids: Record<string, string>, canChange: boolean, canPropose = false, me?: MilestoneReader, titleOf: (slug: string) => string = (slug) => slug): Schemas["SimpleGoalMilestone"] {
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
    prd_owner: m.prd ? prdOwnerName(m.prd.slug, me) : null,
    pending: m.pending ? { ...m.pending, can_decide: decidesAsk(m, me) } : null,
    can_change: canChange,
    can_propose: !m.prd && !canChange && canPropose,
    carried_from: m.carried_from ? { id: stableUuid(`simple-doc/${m.carried_from}`), slug: m.carried_from, title: titleOf(m.carried_from) } : null,
    ...kindDefaults(m),
    status: kindDefaults(m).status_set ?? "on_track",
    status_set_by_name: kindDefaults(m).status_set ? (me?.names?.[me.id ?? ""] ?? null) : null,
    sub_goal_ids: [],
    from_track_name: null,
    to_track_name: null,
    goal_target: false,
  };
}

/** goal_milestones: who is not drafts.can_edit is refused a write (they propose instead). */
const NOT_YOURS = "Only an owner or the roadmap's decider (with none, its owner) changes its milestones";

const GOAL_KEYS = ["grow-retention", "faster-activation", "quiet-alerts"];

/** milestone-rights: a roadmap's own milestone as an edit_goal_milestone proposal holds it (goal_milestones._value). */
export function milestoneValue(m: MockMilestone, ids: Record<string, string>): Record<string, unknown> {
  return { name: m.name, date: m.date, goal_id: m.goal ? stableUuid(`simple-goal/${m.goal}`) : null, item_ids: m.gates.map((k) => ids[k]).filter(Boolean), counts_when: m.counts_when, ...kindDefaults(m) };
}

/** milestone-rights: an accepted edit_goal_milestone writes the milestone (null: removes it). */
export function writeMilestone(m: MockMilestone, ids: Record<string, string>, v: Record<string, unknown> | null): void {
  if (!v) {
    m.deleted = true;
    return;
  }
  const keyOf = (id: unknown) => Object.keys(ids).find((k) => ids[k] === id);
  m.name = String(v.name);
  m.date = (v.date as string | null) ?? null;
  m.goal = v.goal_id ? (GOAL_KEYS.find((g) => stableUuid(`simple-goal/${g}`) === v.goal_id) ?? null) : null;
  m.gates = ((v.item_ids as string[]) ?? []).map(keyOf).filter((k): k is string => !!k);
  m.counts_when = String(v.counts_when ?? "");
  writeKind(m, v);
}

const json = (status: number, body: unknown): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** POST/PATCH/DELETE /v1/simple/roadmap/milestones[/{id}[/restore]], as oracle.simple.router. */
export async function routeMilestones(
  db: { goal_milestones?: MockMilestone[]; ids: Record<string, string>; changes?: Schemas["SimpleChangeOut"][] },
  me: MilestoneReader & { name?: string; names?: Record<string, string>; owners?: string[] },
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
  // A viewer changes nothing (Commenter); a commenter only asks a PRD's owner (goal_milestones._may_propose).
  if (me.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  const history = json(409, { detail: "That roadmap is history" });
  if (!p[4] && req.method === "POST") {
    const b = (await req.json()) as Schemas["SimpleGoalMilestoneIn"];
    const roadmap = slugOf(b.roadmap_id);
    if (!roadmap) return json(404, { detail: "No such roadmap" });
    if (isHistory(roadmap)) return history;
    if (!canEdit(roadmap)) return json(403, { detail: NOT_YOURS });
    const goal = goalKey(b.goal_id, GOAL_KEYS);
    const n = list.filter((m) => m.roadmap === roadmap && m.goal === goal && !m.prd).reduce((a, m) => Math.max(a, Number(m.code.slice(1)) || 0), 0);
    const m: MockMilestone = { id: stableUuid(`simple-gm/${roadmap}/${goal}/${list.length}/${b.name}`), roadmap, code: `M${n + 1}`, name: b.name, date: b.date, goal, gates: (b.item_ids ?? []).map(keyOf).filter((k): k is string => !!k), counts_when: b.counts_when ?? "", progress: "not_started" };
    writeKind(m, b as Record<string, unknown>);
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
      m.pending = null;
      // roadmap-decide: the ask is a proposed change on the PRD (goal_milestones.create), the PRD owner's to decide.
      // As goal_milestones._propose_prd_change, an older ask on it stays proposed (it waits no more: only declining closes it).
      if (b.date !== m.date || b.counts_when) {
        const changes = (db.changes ??= []);
        // Each ask its own id (two asks of one date too), so each is decided on its own.
        let n = changes.length;
        while (changes.some((c) => c.id === stableUuid(`simple-gm-change/${m.id}/${b.date}/${n}`))) n += 1;
        const id = stableUuid(`simple-gm-change/${m.id}/${b.date}/${n}`);
        // Sent to the PRD's owners, else the company's owners (_propose_prd_change's routed_to);
        // it waits for the first of them (asked_of_name).
        const owners = me.prdOwners?.(m.prd.slug) ?? [];
        const routed = owners.length ? owners : (me.owners ?? []);
        m.pending = { date: b.date ?? m.date, counts_when: b.counts_when ?? null, asked_of: routed[0] ? (me.names?.[routed[0]] ?? null) : null, change_id: id, can_decide: false };
        changes.push(prdAsk(m, id, { date: m.pending.date ?? null, counts_when: m.pending.counts_when ?? m.counts_when }, me.id ?? "", (me.id && me.names?.[me.id]) || me.name || "someone", new Date().toISOString(), routed));
      }
      return json(200, milestoneOut(m, db.ids, true, false, me));
    }
    if (!canEdit(m.roadmap)) return json(403, { detail: NOT_YOURS });
    if (b.name != null) m.name = b.name;
    if (b.date != null) m.date = b.date;
    if (b.goal_id !== undefined) m.goal = goalKey(b.goal_id, GOAL_KEYS);
    if (b.item_ids != null) m.gates = b.item_ids.map(keyOf).filter((k): k is string => !!k);
    if (b.counts_when != null) m.counts_when = b.counts_when;
    writeKind(m, b as Record<string, unknown>);
    return json(200, milestoneOut(m, db.ids, true));
  }
  if (!p[5] && req.method === "DELETE" && m.prd) return json(409, { detail: "This milestone is the PRD's: it changes in the PRD" });
  if (!canEdit(m.roadmap)) return json(403, { detail: NOT_YOURS });
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

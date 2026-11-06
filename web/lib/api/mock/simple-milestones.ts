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

/** roadmap-decide: whether the reader decides a change asked of the milestone's PRD (its owner, or a company owner). */
export const decidesAsk = (m: Pick<MockMilestone, "prd">, me: { role: string; name?: string } | undefined): boolean =>
  !!m.prd && !!me && (me.role === "owner" || me.name === m.prd.owner);

export function milestoneOut(m: MockMilestone, ids: Record<string, string>, canChange: boolean, canPropose = false, me?: { role: string; name?: string }): Schemas["SimpleGoalMilestone"] {
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
    pending: m.pending ? { ...m.pending, can_decide: decidesAsk(m, me) } : null,
    can_change: canChange,
    can_propose: !m.prd && !canChange && canPropose,
  };
}

/** goal_milestones: who is not drafts.can_edit is refused a write (they propose instead). */
const NOT_YOURS = "Only an owner or the roadmap's decider (with none, its owner) changes its milestones";

const GOAL_KEYS = ["grow-retention", "faster-activation", "quiet-alerts"];

/** milestone-rights: a roadmap's own milestone as an edit_goal_milestone proposal holds it (goal_milestones._value). */
export function milestoneValue(m: MockMilestone, ids: Record<string, string>): Record<string, unknown> {
  return { name: m.name, date: m.date, goal_id: m.goal ? stableUuid(`simple-goal/${m.goal}`) : null, item_ids: m.gates.map((k) => ids[k]).filter(Boolean), counts_when: m.counts_when };
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
}

const json = (status: number, body: unknown): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** POST/PATCH/DELETE /v1/simple/roadmap/milestones[/{id}[/restore]], as oracle.simple.router. */
export async function routeMilestones(
  db: { goal_milestones?: MockMilestone[]; ids: Record<string, string>; changes?: Schemas["SimpleChangeOut"][] },
  me: { id?: string; role: string; name?: string; names?: Record<string, string> },
  req: Request,
  p: string[],
  slugOf: (id: string) => string | null,
  canEdit: (roadmap: string) => boolean,
  isHistory: (roadmap: string) => boolean = () => false,
): Promise<Response | null> {
  if (p[3] !== "milestones") return null;
  const list = (db.goal_milestones ??= []);
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
      m.pending = b.date === m.date && !b.counts_when ? null : { date: b.date ?? m.date, counts_when: b.counts_when ?? null, asked_of: m.prd.owner, change_id: stableUuid(`simple-gm-change/${m.id}/${b.date}`), can_decide: false };
      // roadmap-decide: the ask is a proposed change on the PRD (goal_milestones.create), the PRD owner's to decide.
      if (m.pending) {
        const changes = (db.changes ??= []);
        const id = m.pending.change_id!;
        for (const c of changes) if (c.op === "edit_goal_milestone" && c.status === "proposed" && c.target.milestone_id === m.id) c.status = "declined";
        changes.push({
          id, session_id: null, document_id: stableUuid(`simple-doc/${m.prd.slug}`), op: "edit_goal_milestone", draft_ids: [],
          target: { milestone_id: m.id, roadmap_id: stableUuid(`simple-doc/${m.roadmap}`), name: m.name },
          before: { date: m.date, counts_when: m.counts_when }, after: { date: m.pending.date, counts_when: m.pending.counts_when ?? m.counts_when },
          status: "proposed", by: me.id ?? "", by_name: (me.id && me.names?.[me.id]) || me.name || "someone", at: new Date().toISOString(),
          decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: [], undoes_id: null, undone: false,
          can_decide: false, can_undo: false, words: "", from_meeting: null, off_agenda: false,
        } as unknown as Schemas["SimpleChangeOut"]);
      }
      return json(200, milestoneOut(m, db.ids, true, false, me));
    }
    if (!canEdit(m.roadmap)) return json(403, { detail: NOT_YOURS });
    if (b.name != null) m.name = b.name;
    if (b.date != null) m.date = b.date;
    if (b.goal_id !== undefined) m.goal = goalKey(b.goal_id, GOAL_KEYS);
    if (b.item_ids != null) m.gates = b.item_ids.map(keyOf).filter((k): k is string => !!k);
    if (b.counts_when != null) m.counts_when = b.counts_when;
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

/**
 * Mock of B2 Baseline review from this run (GET /v1/baseline/from-run/{run_id}, mirrors
 * api/oracle/baseline/from_run.py): a run's rows are the entities it created (`run_id`) and
 * the ones it proposed a change to, each with the reasons it needs a person, recomputed on
 * every read, and the state the shared draft's actions leave it in. Made-up data only.
 */
import type { Schemas } from "@/lib/api/client";

import { LOW_CONFIDENCE, type BaselineState } from "./baseline";
import { goalCheck } from "./goals";
import type { BaselineReviewOf, GateReason } from "./runs";

type Row = Schemas["FromRunRow"];
type Reason = Schemas["RowReason"];
type Action = Pick<Schemas["ReviewAction"], "item_key" | "kind" | "state" | "answers">;
type EntityRow = BaselineState["entities"][number];

const GOAL_UNDECIDED = "goal_undecided";
const GROUP: Record<string, number> = { goal: 0, product: 1, feature: 2 };
const DECIDED_ELSEWHERE = ["changes_your_edit", "material_conflict"];
export const MERGE_LOCKED = "Locked: a person edited it";
export const MERGE_NOT_THIS_RUN = "Only items this run created can be merged here";
export const MERGE_NOT_SAME_TYPE = "Only items of the same type can be merged";

const keyOf = (e: Pick<EntityRow, "type" | "key">) => `${e.type}:${e.key}`;

function reason(e: EntityRow, code: string, severity: Reason["severity"], label: string, text: string, extra: Partial<Reason> = {}): Reason {
  return { item: keyOf(e), item_title: e.title, code, severity, label, text, data: {}, fixes: [], ...extra };
}

/**
 * As from_run._answers: a staged waiver answers the reasons it names (Leave proposed answers
 * the goal's to-confirm reasons too); a staged look again answers every reason but
 * goal_undecided, which only a waiver answers (the approve gate's rule).
 */
function answers(a: Action, r: Reason): boolean {
  if (a.state !== "staged") return false;
  if (a.kind === "look_again") return r.code !== GOAL_UNDECIDED;
  if (a.kind !== "waive") return false;
  const named = a.answers ?? [];
  return !named.length || named.includes(r.code) || (named.includes(GOAL_UNDECIDED) && r.severity === "confirm");
}

export interface FromRun {
  rows: Row[];
  summary: Schemas["FromRunSummary"];
  other_proposed_goals: Schemas["EntityOut"][];
}

/** The run's rows (as from_run.build). */
export function fromRun(s: BaselineState, runId: string, actions: Schemas["ReviewAction"][]): FromRun {
  const evidence = (id: string) => s.evidence.filter((x) => x.entity_id === id).length;
  const proposals = s.proposals.filter((p) => p.run_id === runId && p.entity_id);
  const created = s.entities.filter((e) => e.run_id === runId);
  const proposed = s.entities.filter((e) => !created.includes(e) && proposals.some((p) => p.entity_id === e.id));
  const confirmedGoals = new Set(s.entities.filter((e) => e.type === "goal" && e.status === "confirmed").map((e) => e.id));
  const served = (e: EntityRow) => s.edges.some((x) => x.src_id === e.id && x.type === "supports" && x.status !== "rejected" && confirmedGoals.has(x.dst_id));
  const summary: Schemas["FromRunSummary"] = { items: 0, need_you: 0, not_decided: 0, handled: 0, left_proposed: 0, other_proposed_goals: 0 };
  // Grouped, by key; a subgoal (#345) right after its parent goal when that is a row too.
  const touched = [...created, ...proposed];
  const place = (e: EntityRow): [number, string, string, number, string] => {
    const parent = e.type === "goal" && e.parent_id ? touched.find((x) => x.id === e.parent_id && x.type === "goal") : undefined;
    return parent ? [GROUP.goal, e.type, parent.key, 1, e.key] : [GROUP[e.type] ?? 3, e.type, e.key, 0, ""];
  };
  const ents = touched
    .map((e) => ({ e, at: place(e) }))
    .sort(({ at: a }, { at: b }) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3] - b[3] || a[4].localeCompare(b[4]))
    .map(({ e }) => e);
  const rows = ents.map((e): Row => {
    const key = keyOf(e);
    const own = created.includes(e);
    const mineProposals = proposals.filter((p) => p.entity_id === e.id);
    const open = mineProposals.filter((p) => p.status === "open");
    const reasons: Reason[] = [];
    if (e.status !== "rejected" && own) {
      if (e.type === "goal" && e.status === "proposed") {
        reasons.push(
          reason(e, GOAL_UNDECIDED, "blocking", "Not decided", "The run proposed this goal and nobody decided it: confirm it, reject it, or leave it proposed with a reason.", {
            waivable: true,
          }),
        );
      }
      if (e.type === "goal") {
        // B5's goal_check (the owner a member id; membership is not checked here).
        const missing = goalCheck(e.attrs, e.status, () => true).missing;
        if (missing.length) {
          reasons.push(reason(e, "goal_not_measurable", "confirm", "Not measurable", "The goal is not measurable yet: it may be confirmed and stays flagged.", { detail: `Missing: ${missing.join(", ")}` }));
        }
      }
      if (e.confidence != null && e.confidence < LOW_CONFIDENCE) {
        const score = Math.round(e.confidence * 100);
        reasons.push(reason(e, "low_confidence", "confirm", `Low confidence ${score}`, `Its evidence scores ${score}, below the company's low threshold.`));
      }
      if (!evidence(e.id)) reasons.push(reason(e, "no_evidence", "confirm", "No evidence", "Nothing cites it yet."));
      if (e.type === "feature" && !served(e)) reasons.push(reason(e, "serves_no_goal", "confirm", "Serves no goal", "No supports link to a confirmed goal."));
    }
    if (e.status !== "rejected") {
      if (open.length && e.locked) {
        reasons.push(reason(e, "changes_your_edit", "confirm", "Changes a locked item", "The run proposes a change to an item a person edited. Accepting applies it, and the item stays locked against Oracle's changes until a person unlocks it; or reject it."));
      }
      if (s.conflicts.some((c) => c.entity_id === e.id && c.status === "open" && c.material)) {
        reasons.push(reason(e, "material_conflict", "confirm", "Sources disagree", "Sources disagree on a field that changes a decision: pick a side."));
      }
    }
    const mine = actions.filter((a) => a.item_key === key);
    const openReasons = reasons.filter(
      (r) => !mine.some((a) => answers(a, r)) && !(e.locked && r.severity === "confirm" && !DECIDED_ELSEWHERE.includes(r.code)),
    );
    const state: Row["state"] = openReasons.length ? "needs_you" : reasons.length || e.locked || mine.some((a) => a.state === "staged") ? "handled" : "fine";
    const undecided = openReasons.some((r) => r.code === GOAL_UNDECIDED);
    summary.items += 1;
    summary.need_you += state === "needs_you" ? 1 : 0;
    summary.handled += state === "handled" ? 1 : 0;
    summary.not_decided += undecided ? 1 : 0;
    summary.left_proposed +=
      e.type === "goal" && e.status === "proposed" && !undecided && mine.some((a) => a.kind === "waive" && a.state === "staged") ? 1 : 0;
    const why_not = e.run_id !== runId ? MERGE_NOT_THIS_RUN : e.locked ? MERGE_LOCKED : null;
    return {
      key,
      entity: { ...e, evidence_count: evidence(e.id) },
      change: own ? "new" : "proposal",
      proposal_ids: open.map((p) => p.id),
      proposals: mineProposals.map((p) => ({ id: p.id, status: p.status })),
      conflict_ids: s.conflicts.filter((c) => c.entity_id === e.id && c.status === "open" && c.material).map((c) => c.id),
      edges: { new: s.edges.filter((x) => x.run_id === runId && (x.src_id === e.id || x.dst_id === e.id)).length, changed: 0 },
      reasons,
      actions: mine,
      state,
      merge: { allowed: why_not === null, why_not },
    };
  });
  const ids = new Set(ents.map((e) => e.id));
  const others = s.entities.filter((e) => e.type === "goal" && e.status === "proposed" && !ids.has(e.id));
  summary.other_proposed_goals = others.length;
  return { rows, summary, other_proposed_goals: others.map((e) => ({ ...e, evidence_count: evidence(e.id) })) };
}

/** As from_run.row_tally: the Inbox row's counts. */
/** The Inbox row's counts of a run's rows (D9's summary). */
export type RowTally = Pick<Schemas["InboxSummary"], "need_you" | "blocking" | "to_confirm" | "handled">;

export function rowTally(rows: Row[]): RowTally {
  let blocking = 0;
  let toConfirm = 0;
  for (const r of rows) {
    if (r.state !== "needs_you") continue;
    const undecided = r.reasons.some((x) => x.code === GOAL_UNDECIDED && !r.actions.some((a) => answers(a, x)));
    blocking += undecided ? 1 : 0;
    toConfirm += undecided ? 0 : 1;
  }
  return {
    need_you: rows.filter((r) => r.state === "needs_you").length,
    blocking,
    to_confirm: toConfirm,
    handled: rows.filter((r) => r.state === "handled").length,
  };
}

/** What the runs mock reads of the baseline at Confirm the baseline (RunsContext.baselineReview). */
export function baselineReviewOf(s: BaselineState, runId: string, actions: Schemas["ReviewAction"][]): BaselineReviewOf {
  const { rows } = fromRun(s, runId, actions);
  const goals: GateReason[] = rows
    .filter((r) => r.change !== "proposal")
    .flatMap((r) => r.reasons.filter((x) => x.code === GOAL_UNDECIDED))
    .map((x) => ({ item: x.item, item_title: x.item_title, code: x.code, severity: x.severity, label: x.label }));
  return { goals, summary: rowTally(rows), titles: Object.fromEntries(rows.map((r) => [r.key, r.entity.title])) };
}

/**
 * The "baseline-review" scenarios' baseline (B2 3.6): the Oct 20 Build the baseline run
 * created two proposed goals (one measurable, one without target and owner), a feature at
 * confidence 0.32 serving no goal, a duplicate of Saved carts (with evidence and a link to a
 * confirmed goal, so it needs nothing), and proposed a change to the locked Guided setup.
 */
export function seedFromRun(s: BaselineState, runId: string, uuid: () => string, ownerId: string) {
  const at = "2026-10-20T16:30:00Z";
  const goal = s.entities.find((e) => e.type === "goal" && e.status === "confirmed")!;
  const guided = s.entities.find((e) => e.key === "f.guided-setup")!;
  const cited = s.evidence.find((x) => x.entity_id)!;
  const entity = (type: EntityRow["type"], key: string, title: string, attrs: Record<string, unknown>, extra: Partial<EntityRow> = {}): EntityRow => {
    const row: EntityRow = {
      id: uuid(), type, key, title, body: null, attrs, status: type === "goal" ? "proposed" : "proposed", origin: "agent",
      locked: false, locked_by: null, locked_at: null, confidence: 0.7, run_id: runId, created_at: at, updated_at: at, ...extra,
    };
    s.entities.push(row);
    return row;
  };
  const cite = (e: EntityRow, excerpt: string) => s.evidence.push({ ...cited, id: uuid(), entity_id: e.id, edge_id: null, excerpt, created_at: at });
  const activation = entity("goal", "g.first-week-stores", "Activate new stores in their first week", {
    metric: "stores with a first order", unit: "%", comparison: "at_least", target: 45, horizon: "short", owner: ownerId,
  });
  cite(activation, "Half the new stores never take an order in their first week.");
  const repeat = entity("goal", "g.repeat-buyers", "Bring buyers back", { metric: "buyers with a second order", horizon: "long" });
  cite(repeat, "Repeat buyers spend twice as much over a year.");
  entity("feature", "f.gift-notes", "Gift notes", {}, { confidence: 0.32 });
  const twin = entity("feature", "f.carts-for-later", "Carts for later", { status: "idea" });
  cite(twin, "Buyers ask to keep a cart for later.");
  cite(twin, "Two support tickets a week ask for a saved cart.");
  s.edges.push({
    id: uuid(), src_id: twin.id, dst_id: goal.id, type: "supports", attrs: { contribution: 2 }, status: "proposed", origin: "agent",
    locked: false, locked_by: null, locked_at: null, confidence: null, run_id: runId, created_at: at, updated_at: at,
  });
  s.proposals.push({
    id: uuid(), entity_id: guided.id, edge_id: null,
    payload: { op: "update", kind: "entity", fields: { attrs: { effort: "XL" } }, reason: "The setup interviews found two more steps.", origin: "agent" },
    run_id: runId, actor: `run:${runId}`, status: "open", decided_by: null, decided_at: null, created_at: at,
  });
}

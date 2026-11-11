/**
 * Simple S3a (#723): the change engine (/v1/simple/sessions, /v1/simple/changes), as
 * api/oracle/simple/changes.py serves it, over the mock's company-wide roadmap
 * (./simple-roadmap.ts).
 *
 * Who decides (D-a, #730 review): an owner; the roadmap's decider (`db.deciders`); with none,
 * the item's track owner (`db.track_owners`) while an approver or owner; they apply, and
 * approvers and commenters propose to them, else to the company's owners; viewers are
 * refused. An open proposal is routed to whoever decides now. The default seed names no
 * decider and no track owner, so there owners apply every change; the "simple-deciders"
 * scenario names both (./simple-roadmap.ts seedSimpleDeciders). A
 * change whose `before` differs from the stored values answers 409 with the current values
 * and who changed them last; undo works for its author, in its open session, while the item
 * still holds the change's `after`. Sessions close after 30 minutes without a change.
 *
 * S3b (api/oracle/simple/drafts.py): an applied change of a roadmap's item goes into the
 * roadmap's working draft (one per roadmap; the session joins it); readers who may not see
 * it (here: anyone but owners and its people) read the published items and a
 * `changes_in_review` count (./simple-roadmap.ts). Submit makes it the next version in
 * review; with no required reviewers in the mock, an owner's approval publishes it. Undo
 * works inside a working draft only; its author resumes it after its session closed.
 * Non-versioned targets (item tasks, action items, priority overrides, launch tasks) are
 * owners' to apply and others' to propose, kept in `db.targets` and undone like the rest.
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { draftDecisionNotes } from "./decision-notes";
import { stableUuid } from "./ids";
import { changePhrase, changeSentence } from "./simple-change-words";
import { milestoneValue, writeMilestone } from "./simple-milestones";
import { addToCompany, featureItem, featureKeyOf, itemsOfFeature, priorityAfter, priorityBefore, prioritiesOut, sameName, twinBlock } from "./simple-priorities";
import { archiveGoal, goalBucketsDb, trashGoal, unarchiveGoal, type GoalBucketsTrash } from "./goal-buckets";
import {
  canDecideItem,
  canEditRoadmap,
  closed,
  companyToday,
  deciderIds,
  draftChanges,
  openDraft,
  GOALS,
  MAP_GOALS,
  featureGoalRef,
  mapGoalRef,
  goalId,
  goalIdsOf,
  itemDeciderId,
  itemOwnerId,
  namedOn,
  lookalikes,
  fileUnderCurrentPrd,
  ofReplacedPrd,
  shiftPlan,
  ownDates,
  ownPrd,
  pickedName,
  prdCode,
  shownCode,
  shownName,
  codedTitle,
  dependencyOf,
  loopOf,
  ROADMAP_SLUGS,
  ROADMAPS,
  prdOwnerIdsOf,
  decidesMilestoneAsk,
  roadmapRoute,
  goalTargetOf,
  setTargetName,
  readerDb,
  readsRoadmap,
  roadmapId,
  roadmapOut,
  draftPrds,
  readableRoadmap,
  readDates,
  readColumn,
  quarterWindows,
  shiftToQuarter,
  roadmapGoal,
  roadmapGoalKey,
  keptTarget,
  storedUnit,
  goalInTrash,
  writeRoadmapGoal,
  seesDraft,
  settleDrafting,
  simpleWindows,
  storedDates,
  type MockDraft,
  type MockKeyDate,
  type SeedItem,
  type SimpleDb,
  TRACKS,
} from "./simple-roadmap";
import { routeGoalSuggestions } from "./simple-suggestions";
import { entryOut, mayRestore, restoreFromTrash, type TrashDb, type TrashEntryRow } from "./trash";
import { madeOrder } from "./made-order";

type Change = Schemas["SimpleChangeOut"];
type Session = Schemas["SimpleSessionOut"];
type Role = Schemas["Me"]["role"];
type Values = Record<string, unknown>;

export interface SimpleChangesCtx {
  id: string;
  role: Role;
  /** The company's owners (who decide proposals with no decider or roadmap owner). */
  owners: string[];
  /** simple-replaced-prds: the slugs and ids of the PRDs marked replaced (their open drafts are never listed in Simple). */
  replaced?: string[];
  /** Person id -> name. */
  names: Record<string, string>;
  /** Person id -> role (D-a: whether a track owner decides). */
  roles?: Record<string, Role>;
  /** The company's confirmed goals (the Ground Truth's), as the API lists them for suggestions (qa4-simple-home-4). */
  companyGoals?: { id: string; key: string; title: string }[];
  /** trash-features-goals: Settings › Trash (./trash.ts), shared with documents, intakes and runs. */
  trash?: TrashDb;
  /** edit-goals-prds: the goal buckets' Trash, writer and members (an accepted Ask to delete a goal). */
  goalBin?: GoalBucketsTrash;
  /** S9 (targets.py add_feature_ask): files a feature ask in Requests, and drops it on undo. */
  fileAsk?: (input: { id: string; title: string; channel: string; requester_name: string | null; requester_kind: string; filed_by: string }) => void;
  dropAsk?: (id: string) => void;
  /** every-field-editable: the Goal ladder's key results (goal-map.ts ladderMilestones), the same
   * track_milestones in the API: an edit_goal_milestone may name one. */
  ladder?: LadderMilestones;
}

/** every-field-editable: a Goal ladder key result as an edit_goal_milestone reads and writes it. */
export interface LadderMilestones {
  /** milestone-rename: `roadmap`, the roadmap (slug) the map's milestones sit on. */
  find: (id: string) => { value: Record<string, unknown>; can_change: boolean; name: string; decider: string | null; roadmap?: string | null } | null;
  /** milestone-rename: writes an accepted proposal's name, date and goal. */
  write: (id: string, after: Record<string, unknown> | null) => void;
  /** goal-map-link-asks: the map's links (goal-map.ts), for a link_goal_map change. */
  links?: {
    feature: (id: string) => { title: string; milestones: string[]; area: string | null } | null;
    milestone: (id: string) => { name: string; areas: string[] } | null;
    firstArea: () => string | null;
    /** The Goal map's POST /links and /links/move; null when done. */
    attach: (feature: string, milestone: string, area: string) => Response | null;
    move: (feature: string, from: string, to: string) => Response | null;
  };
}

/** goal-map-link-asks (oracle.simple.goal_map_asks): a feature put on a goal milestone
 * (target.from_milestone null) or its link moved there, suggested by who may propose but not edit
 * the Goal map (a commenter), routed to the map's roadmap's decider; accepted, it applies as the
 * Goal map's own POST /links (in the milestone's first area, else the feature's, else the map's
 * first) or /links/move does. */
const MAP_LINK_OP = "link_goal_map";

function mapLinkArea(links: NonNullable<LadderMilestones["links"]>, feature: string, milestone: string): string | null {
  return links.milestone(milestone)?.areas[0] ?? links.feature(feature)?.area ?? links.firstArea();
}

function createMapLink(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Response {
  if (ctx.role === "viewer") return json(403, { detail: "Viewers may not propose a change" });
  if (approves(ctx)) return json(409, { detail: "You change this directly on the Goal map" });
  const links = ctx.ladder?.links;
  const feature = String(body.target.feature ?? "");
  const milestone = String(body.target.milestone ?? "");
  const from = body.target.from_milestone ? String(body.target.from_milestone) : null;
  const f = links?.feature(feature);
  if (!links || !f) return json(404, { detail: "No such feature" });
  const m = links.milestone(milestone);
  if (!m) return json(404, { detail: "No such milestone" });
  if (from === milestone) return json(422, { detail: "It is on that milestone already" });
  if (from && !f.milestones.includes(from)) return json(404, { detail: "The feature is not on that milestone" });
  if (!from && f.milestones.includes(milestone)) return json(422, { detail: "It is on that milestone already" });
  if (!from && !mapLinkArea(links, feature, milestone)) return json(422, { detail: "The map has no area to put it in" });
  if ((db.changes ?? []).some((c) => c.op === MAP_LINK_OP && c.status === "proposed" && c.target.feature === feature && c.target.milestone === milestone)) return json(409, { detail: "This is asked already" });
  const kr = ctx.ladder?.find(milestone);
  const doc = kr?.roadmap ? stableUuid(`simple-doc/${kr.roadmap}`) : null;
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: doc, draft_ids: [], op: body.op,
    target: { feature, milestone, from_milestone: from, item_id: feature, title: f.title, name: m.name, from_name: from ? (links.milestone(from)?.name ?? null) : null },
    before: {}, after: {}, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    // goal_map_asks: key_dates.route, the map's decider, else the roadmap's track owners who decide, else the owners.
    routed_to: kr?.decider ? [kr.decider] : kr?.roadmap ? roadmapRoute(db, kr.roadmap, ctx.roles, ctx.owners) : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

/** An accepted link_goal_map: the Goal map's own attach or move; null when done. */
function applyMapLink(ctx: SimpleChangesCtx, c: Change): Response | null {
  const links = ctx.ladder?.links;
  if (!links) return json(404, { detail: "No such feature or milestone" });
  const feature = String(c.target.feature), milestone = String(c.target.milestone);
  if (c.target.from_milestone) return links.move(feature, String(c.target.from_milestone), milestone);
  if (!links.milestone(milestone)) return json(404, { detail: "No such milestone" });
  const area = mapLinkArea(links, feature, milestone);
  return area ? links.attach(feature, milestone, area) : json(422, { detail: "The map has no area to put it in" });
}

/** edit-goals-prds (oracle.simple.goal_asks): a goal archived or restored, asked by who may not
 * (a goal's delete is trash_items', decided by approvers and owners). */
const GOAL_ASK_OPS = ["archive_goal", "unarchive_goal"];
const approves = (ctx: Pick<SimpleChangesCtx, "role">) => ctx.role === "owner" || ctx.role === "approver";

/** Applies a goal ask: Archive (its features to `to_goal_id`), the goal to Trash, or Restore. */
function applyGoalAsk(db: SimpleDb, ctx: SimpleChangesCtx, c: Pick<Change, "op" | "target" | "reason">): Response | null {
  const gb = goalBucketsDb(db, ctx.goalBin?.people);
  const id = String(c.target.goal_id ?? "");
  const to = (c.target.to_goal_id as string | null | undefined) ?? null;
  if (c.op === "archive_goal") {
    const undo = archiveGoal(gb, id, to, iso(mockNowMs()));
    return undo instanceof Response ? undo : null;
  }
  if (c.op === "unarchive_goal") {
    const done = unarchiveGoal(gb, id);
    return done instanceof Response ? done : null;
  }
  const bin = ctx.goalBin ?? { trash: (ctx.trash ??= { entries: [], estimates: {} }), id: ctx.id, name: ctx.names[ctx.id] ?? null, now: () => iso(mockNowMs()) };
  const row = trashGoal(gb, bin, id, to, c.reason ?? null, db);
  return row instanceof Response ? row : null;
}

/** POST /v1/simple/changes op `archive_goal` / `delete_goal`: an approver's applies, a commenter's goes to the company's owners. */
function createGoalAsk(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Response {
  const gb = goalBucketsDb(db, ctx.goalBin?.people);
  const g = gb.goals.find((x) => x.id === body.target.goal_id && !x.trashed);
  if (!g) return json(404, { detail: "No such goal" });
  if (body.op === "archive_goal" && g.archived) return json(409, { detail: `${g.title} is archived already` });
  if (body.op === "unarchive_goal" && !g.archived) return json(409, { detail: `${g.title} is not archived` });
  const applies = approves(ctx);
  if (!applies && (db.changes ?? []).some((c) => c.op === body.op && c.status === "proposed" && c.target.goal_id === g.id)) return json(409, { detail: "This is asked already" });
  const target = { goal_id: g.id, title: g.title, to_goal_id: (body.target.to_goal_id as string | null | undefined) ?? null };
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: null, draft_ids: [],
    op: body.op, target, before: {}, after: {}, status: applies ? "applied" : "proposed",
    by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (applies) {
    const err = applyGoalAsk(db, ctx, change);
    if (err) return err;
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

const IDLE_MS = 30 * 60_000;
const DAY = 86_400_000;
const FIELDS: Record<string, string[]> = {
  move_dates: ["start_date", "end_date"],
  accept_date_suggestion: ["start_date", "end_date"],
  change_horizon: ["horizon"],
  reorder: ["position"],
  cut: ["cut"],
  restore: ["cut"],
  edit_title: ["title"],
  edit_outcome: ["outcome"],
  // build-feature-panel (AN PR 1204): the panel's Notes row (changes.py edit_note).
  edit_note: ["note"],
  accept_risk: ["risk"],
  // S6: a draft item confirmed (changes.py confirm_item).
  confirm_item: ["draft"],
  // one-feature-panel (changes.py SHOWN): before is what the read shows.
  set_confidence: ["confidence"],
  set_track: ["track_id"],
  set_prd: ["prd_document_id"],
  set_goal: ["goal_id"],
  set_depends: ["depends_on"],
  set_status: ["status"],
  // lane-gt-ui: the Ground Truth feature the item is (Add to Ground Truth, Link to a feature).
  set_feature: ["feature_id"],
  // goal-buckets-tasks: the goals an item serves (changes.py set_goals).
  set_goals: ["goal_ids"],
  // roadmap-decide: a dependent no longer depends on a cut item (changes.py remove_dependency).
  remove_dependency: ["depends_on"],
  // feature-parts: the key of the feature it is a part of (changes.py set_parent).
  set_parent: ["parent_key"],
  // every-field-editable: the item's feature code, stored as its title's lead (changes.py set_code).
  set_code: ["code"],
};
const FIXES = ["shift_dependents", "move_dependency"];
/** fix5-cut-dependents: the item and everything waiting on it, cut as one change (changes.py CUT_ALL). */
export const CUT_ALL = "cut_with_dependents";
/** The ops that key before/after by item id (changes.py KEYED). */
const KEYED = [...FIXES, CUT_ALL];

/** changes.dependents: every item waiting on `id`, transitively (breadth first), but those cut or merged already. */
export function cutDependents(items: Schemas["SimpleRoadmapItem"][], id: string): Schemas["SimpleRoadmapItem"][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set([id]);
  const out: Schemas["SimpleRoadmapItem"][] = [];
  const queue = [id];
  while (queue.length) {
    for (const n of byId.get(queue.shift()!)?.needed_by ?? []) {
      const next = byId.get(n);
      if (!next || seen.has(n) || next.status === "cut" || next.status === "merged") continue;
      seen.add(n);
      out.push(next);
      queue.push(n);
    }
  }
  return out;
}
/** The item task ops (targets.py KIND "task"). */
const KIND_TASK = new Set(["add_item_task", "edit_item_task", "set_item_task_status"]);
/** S3b: non-versioned ops (api/oracle/simple/targets.py) and the target id each creates. */
const TARGETS: Record<string, { id: string; adds?: boolean }> = {
  add_item_task: { id: "task_id", adds: true },
  edit_item_task: { id: "task_id" },
  set_item_task_status: { id: "task_id" },
  add_action_item: { id: "action_item_id", adds: true },
  edit_action_item: { id: "action_item_id" },
  set_action_item_status: { id: "action_item_id" },
  add_launch_task: { id: "task_id", adds: true },
  set_launch_task_status: { id: "task_id" },
  override_priority: { id: "item_id" },
  // S6: a person's goal value or effort for the item's feature (targets.py estimate_feature).
  estimate_feature: { id: "item_id" },
  // S9: a milestone typed in chat, and a new feature ask (targets.py set_milestone, add_feature_ask).
  set_milestone: { id: "item_id" },
  add_feature_ask: { id: "request_id", adds: true },
  // Chat actions: an item's owner or decider (stored by item id; simple-roadmap's itemOwnerId / itemDeciderId read them).
  set_owner: { id: "item_id" },
  set_decider: { id: "item_id" },
  // one-feature-panel: how the item's goal is measured (targets.py set_goal_measure), into the goal.
  set_goal_measure: { id: "goal_id" },
};

/** targets.py goal_measure: the goal's measure, target and date as the roadmap read shows them. */
function goalMeasure(db: SimpleDb, goalId: unknown): Values | null {
  const k = roadmapGoalKey(String(goalId ?? ""), db);
  if (!k || goalInTrash(db, k)) return null;
  const g = roadmapGoal(db, k);
  return { measure: g.metric, target: g.target, due: g.due };
}

/** Roadmap-plus: a roadmap's key dates (api/oracle/simple/key_dates.py), into its working draft. */
const KEY_DATE_OPS = ["add_key_date", "edit_key_date", "remove_key_date"];

const iso = (ms: number): string => new Date(ms).toISOString();
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const days = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function keyOf(db: SimpleDb, id: unknown): string | undefined {
  return Object.keys(db.ids).find((k) => db.ids[k] === id);
}

function seed(db: SimpleDb, key: string) {
  return db.items.find((s) => s.key === key)!;
}

/**
 * changes._parent: why `key` may not be made part of `v` as `seen` reads the roadmap (null: it
 * may): an open item of the same roadmap, any depth, never the item itself or one of its own
 * parts (a feature is never its own ancestor). Create, accept and undo all check it.
 */
function parentRefusal(seen: SimpleDb, key: string, v: string | null): string | null {
  const me = seen.items.find((s) => s.key === key);
  if (v === null || !me) return null;
  const live = (k: string) => seen.items.find((x) => x.key === k && !x.trashed);
  const parent = live(v);
  // Each feature by its code and name (F-02 Alert routing by team), as changes._parent.
  const name = (x: { section?: string | null; title: string }) => [prdCode(x.section), x.title].filter(Boolean).join(" ");
  if (v === key) return `${name(me)} cannot be a part of itself`;
  if (!parent || parent.roadmap !== me.roadmap || closed(parent)) return `after.parent_key: no open item of this roadmap has the key ${v}`;
  const up = new Set<string>();
  for (let k = parent.parent; k && !up.has(k) && live(k); k = live(k)!.parent) up.add(k);
  if (up.has(key)) return `${name(me)} cannot be part of ${name(parent)}: ${name(parent)} is already one of its parts`;
  return null;
}

/** The roadmap slug of a key-date change's target document. */
function roadmapOfDoc(db: SimpleDb, docId: unknown): string | undefined {
  return [...new Set(db.items.map((s) => s.roadmap))].find((r) => stableUuid(`simple-doc/${r}`) === docId);
}


/** Whether the caller applies a change to this item (service.can_decide); no item: owners. */
function decides(db: SimpleDb, ctx: SimpleChangesCtx, itemId: unknown): boolean {
  const key = itemId ? keyOf(db, itemId) : undefined;
  return key ? canDecideItem(db, seed(db, key), ctx) : ctx.role === "owner";
}

/**
 * priorities.merge_twin (qa-prio-twins, review of #1503): a Same name record's Merge into… the row's feature (422
 * unless it has one of its names). Each open item of the twin's feature, on every roadmap (the older ones too), is
 * re-linked to the kept feature first (when the kept feature holds only a draft on that roadmap, the draft is merged
 * into the confirmed item, merge_item); then the feature is gone (in the mock its items stand for the kept one).
 * 403 unless an approver; 409, nothing written, when they do not decide one of those items' roadmaps, the kept feature
 * has its own confirmed item there, or the twin's feature is locked or linked from a PRD (baseline.merge_entity).
 * A step that fails undoes the ones before it.
 */
async function mergeTwin(db: SimpleDb, ctx: SimpleChangesCtx, fid: string, body: { into: string }): Promise<Response> {
  if (ctx.role !== "owner" && ctx.role !== "approver") return json(403, { detail: "Only an approver merges Ground Truth features" });
  const pair = twinPair(db, fid, body.into);
  if (pair instanceof Response) return pair;
  const { source, kept, keptTitle } = pair;
  const theirs = itemsOfFeature(db, source);
  const ours = itemsOfFeature(db, kept);
  const why = twinBlock(db, (x) => decides(db, ctx, db.ids[x.key]), source, kept, keptTitle);
  if (why) return json(409, { detail: why });
  const lock = db.items.find((x) => x.key === source)!.gt_lock;
  if (lock) return json(409, { detail: lock === "locked" ? "Locked: a person edited it" : "Linked from a PRD section: edit or reject it instead" });
  const undo = structuredClone({ items: db.items, changes: db.changes, ids: db.ids });
  const relinked: string[] = [];
  for (const x of theirs) {
    const here = ours.filter((y) => y.roadmap === x.roadmap);
    if (!x.draft && here.length && here.every((y) => y.draft)) {
      const draft = [...here].sort((a, b) => a.key.localeCompare(b.key))[0];
      const r = await create(db, ctx, { op: "merge_item", target: { item_id: db.ids[draft.key], into_id: db.ids[x.key] }, before: {}, after: {}, reason: `Merged into ${x.title}` });
      if (r.status >= 300) {
        Object.assign(db, undo);
        return r;
      }
    }
    relinked.push(x.key);
  }
  // The feature goes: every record of it stands for the kept one.
  for (const x of db.items) if (x.key !== kept && (x.feature ?? x.trace_feature ?? x.key) === source) x.feature = kept;
  // twin_merges.close_open (baseline.merge_entity): its waiting proposals are closed, nothing left to accept.
  const at = iso(mockNowMs());
  for (const c of db.changes ?? [])
    if (c.op === "merge_twin" && c.status === "proposed" && c.target.feature_id === fid)
      Object.assign(c, { status: "declined", decided_by: ctx.id, decided_at: at, decision_reason: `Merged into ${keptTitle}` });
  return json(200, { feature_id: body.into, relinked });
}

/** priorities.twin_pair and its same-name check: the twin's feature and the kept one (422 unless two features, one of
 * the twin's names the kept one's). */
function twinPair(db: SimpleDb, fid: string, into: string): Response | { source: string; kept: string; sourceTitle: string; keptTitle: string } {
  const source = featureItem(db, fid);
  const kept = featureItem(db, into);
  if (!source || !kept || source === kept) return json(422, { detail: "into: another Ground Truth feature" });
  const sourceTitle = db.items.find((x) => x.key === source)!.title;
  const keptTitle = db.items.find((x) => x.key === kept)!.title;
  const names = new Set([sourceTitle, ...itemsOfFeature(db, source).map((x) => x.title)].map(sameName));
  if (![keptTitle, ...itemsOfFeature(db, kept).map((x) => x.title)].some((t) => names.has(sameName(t)))) return json(422, { detail: `into: a feature named ${sourceTitle}` });
  return { source, kept, sourceTitle, keptTitle };
}

/**
 * prio-twin-propose (oracle.simple.twin_merges): op merge_twin, target {feature_id, into_id}. An approver's runs
 * mergeTwin at once; a commenter's is proposed to the company's owners (one open per twin); a viewer's is 403.
 */
async function createTwinMerge(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Promise<Response> {
  if (ctx.role === "viewer") return json(403, { detail: "Only a commenter or above proposes a merge" });
  const fid = String(body.target.feature_id ?? "");
  const into = String(body.target.into_id ?? "");
  const pair = twinPair(db, fid, into);
  if (pair instanceof Response) return pair;
  const applies = ctx.role === "owner" || ctx.role === "approver";
  if (!applies && (db.changes ?? []).some((c) => c.op === body.op && c.status === "proposed" && c.target.feature_id === fid)) return json(409, { detail: "This merge is proposed already" });
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: null, draft_ids: [],
    op: body.op, target: { feature_id: fid, into_id: into, title: pair.sourceTitle, into_title: pair.keptTitle }, before: {}, after: {},
    status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (applies) {
    const r = await mergeTwin(db, ctx, fid, { into });
    if (r.status >= 300) return r;
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

/** S7: the roadmap (slug) an add_item change writes. */
const slugOf = (id: unknown): string | undefined => ROADMAP_SLUGS().find((r) => roadmapId(r) === id);

/** A PRD's slug by its document's id (simple-doc/<slug>): a roadmap's PRD's, or a milestone's. */
function prdSlugOf(db: SimpleDb, docId: unknown): string | undefined {
  const slugs = [...ROADMAP_SLUGS().map((r) => ROADMAPS[r].prd.toLowerCase().replace(/ /g, "-")), ...(db.goal_milestones ?? []).flatMap((m) => (m.prd ? [m.prd.slug] : []))];
  return slugs.find((x) => stableUuid(`simple-doc/${x}`) === docId);
}

/** drafts.who on a PRD's document (./simple-roadmap.ts prdOwnerIdsOf), by its id. */
function prdOwnerIds(db: SimpleDb, docId: unknown): string[] {
  const slug = prdSlugOf(db, docId);
  return slug ? prdOwnerIdsOf(db, slug) : [];
}

/** Whether the caller applies (or accepts) this change: a key date's by the roadmap's rule
 * (drafts.can_edit), an add_item's by its roadmap's editors, else the item's deciders. */
function decidesChange(db: SimpleDb, ctx: SimpleChangesCtx, c: Pick<Change, "op" | "target"> & Partial<Pick<Change, "routed_to" | "after" | "before" | "document_id">>): boolean {
  // Review major (changes.decides_all): a cut with its dependents needs rights on every item it cuts.
  if (c.op === CUT_ALL && c.after) return Object.keys(c.after).every((id) => decides(db, ctx, id));
  // A goal ask is decided by the owners it is sent to (goal_asks.may_decide).
  if (GOAL_ASK_OPS.includes(c.op)) return ctx.role === "owner";
  // prio-twin-propose (twin_merges.may_decide): who may run merge_twin.
  if (c.op === "merge_twin") return ctx.role === "owner" || ctx.role === "approver";
  // roadmap-decide: a change asked of a PRD's milestone (before.date) is any of the PRD's owners'
  // (drafts.who on the change's document) or a company owner's (goal_milestones.decide), its
  // milestone live or gone (its other milestones gone too).
  if (c.op === "edit_goal_milestone" && c.before && !("milestone" in c.before)) return ctx.role === "owner" || prdOwnerIds(db, c.document_id).includes(ctx.id);
  // milestone-rename: a roadmap's own milestone's (a goal's, the Goal map's) as goal_milestones.with_asks reads it.
  if (c.op === MILESTONE_OP) return decidesMilestoneAsk(db, c as Change, ctx);
  // goal-map-link-asks (goal_map_asks.may_decide, as key_dates.may_decide): an owner, whom it is
  // routed to, or who changes the map's roadmap directly.
  if (c.op === MAP_LINK_OP) {
    const rm = roadmapOfDoc(db, c.document_id);
    return ctx.role === "owner" || (c.routed_to ?? []).includes(ctx.id) || (!!rm && canEditRoadmap(db, rm, ctx));
  }
  if (KEY_DATE_OPS.includes(c.op)) {
    const rm = roadmapOfDoc(db, c.target.document_id);
    return ctx.role === "owner" || (c.routed_to ?? []).includes(ctx.id) || (!!rm && canEditRoadmap(db, rm, ctx));
  }
  if (c.op === "add_item" && !keyOf(db, c.target.item_id)) return canEditRoadmap(db, slugOf(c.target.roadmap_id) ?? "", ctx);
  if (c.op === "delete_goal") return ctx.role === "owner" || ctx.role === "approver";
  return decides(db, ctx, c.target.item_id);
}

/** walkc-meeting: mark a proposal as made in a meeting (its session a meeting's). Kept in the
 * company's own stored db (`meeting_proposals`), so it survives a reload, is the same in every
 * tab, and goes with the company when the scenario changes or the mock data is reset. */
export function markMeetingProposal(db: SimpleDb, id: string): void {
  const ids = (db.meeting_proposals ??= []);
  if (!ids.includes(id)) ids.push(id);
}

/** walkc-meeting (changes.routed_to): who a proposal on this item would go to now. */
export function proposalRoute(db: SimpleDb, ctx: Pick<SimpleChangesCtx, "owners" | "roles">, itemId: string): string[] {
  const key = keyOf(db, itemId);
  if (!key) return ctx.owners;
  const ids = deciderIds(db, seed(db, key), ctx.roles);
  return ids.length ? ids : ctx.owners;
}

/** walkc-meeting (changes.meeting_deciders): the attendees who may decide every one of these
 * items (service.can_decide: an owner, the item's or roadmap's decider, else its track owner
 * while an approver), in the meeting's order; no known item: nobody. */
function meetingDeciders(db: SimpleDb, attendees: string[], ctx: Pick<SimpleChangesCtx, "roles">, itemIds: string[]): string[] {
  const keys = itemIds.map((id) => keyOf(db, id)).filter((k): k is string => !!k);
  if (!keys.length) return [];
  return attendees.filter((i, n) => {
    const role = ctx.roles?.[i];
    return attendees.indexOf(i) === n && !!role && keys.every((k) => canDecideItem(db, seed(db, k), { id: i, role }));
  });
}

/** walkc-meeting (changes.meeting_route): in a meeting a proposal on these items goes to its
 * deciders (those of `route` in it, else every attendee who may decide them all); only when
 * nobody in it may, to `route`. */
export function meetingRoute(db: SimpleDb, attendees: string[], ctx: Pick<SimpleChangesCtx, "roles">, itemIds: string[], route: string[]): { ids: string[]; here: boolean } {
  const inside = meetingDeciders(db, attendees, ctx, itemIds);
  const here = route.filter((i) => inside.includes(i));
  const ids = here.length ? here : inside;
  return ids.length ? { ids, here: true } : { ids: route, here: false };
}

/** changes.current_route: who decides an open proposal now; else its stored route. */
function route(db: SimpleDb, ctx: Pick<SimpleChangesCtx, "owners" | "roles">, c: Change): string[] {
  if (c.status !== "proposed" || KEY_DATE_OPS.includes(c.op) || c.op === MILESTONE_OP || c.op === MAP_LINK_OP) return c.routed_to;
  // walkc-meeting: a proposal made in a meeting stays with the meeting's deciders.
  if (db.meeting_proposals?.includes(c.id) && c.routed_to.length) return c.routed_to;
  if (c.op === "add_item" && !keyOf(db, c.target.item_id)) {
    const decider = db.deciders?.[slugOf(c.target.roadmap_id) ?? ""];
    return decider ? [decider] : ctx.owners;
  }
  if (c.op === CUT_ALL) return cutRoute(db, ctx, Object.keys(c.after));
  const key = c.target.item_id ? keyOf(db, c.target.item_id) : undefined;
  if (!key) return ctx.owners;
  const ids = deciderIds(db, seed(db, key), ctx.roles);
  return ids.length ? ids : ctx.owners;
}

/** changes.cut_route: the deciders every item of a cut with its dependents shares, else the company's owners. */
export function cutRoute(db: SimpleDb, ctx: Pick<SimpleChangesCtx, "owners" | "roles">, itemIds: string[]): string[] {
  let common: string[] | null = null;
  for (const id of itemIds) {
    const key = keyOf(db, id);
    const ids = key ? deciderIds(db, seed(db, key), ctx.roles) : [];
    common = common === null ? ids : common.filter((i) => ids.includes(i));
  }
  return common?.length ? common : ctx.owners;
}

/** The stored values of one item's fields (the API's changes.read). */
/** changes.TITLE_MAX: an item's title, its code included. */
const TITLE_MAX = 200;

function read(db: SimpleDb, key: string, fields: string[], target: Values): Values {
  const s = seed(db, key);
  const own = ownDates(db, s);
  const out: Values = {};
  for (const f of fields) {
    // The API's stored dates: typed or accepted ones (storedDates), never estimates.
    if (f === "start_date") out[f] = storedDates(db, key).start;
    else if (f === "end_date") out[f] = storedDates(db, key).end;
    else if (f === "date_source") out[f] = own ? (own.source ?? "accepted") : s.dates ? s.dates.source : s.source === "typed" || s.source === "accepted" ? s.source : null;
    else if (f === "horizon") out[f] = s.horizon;
    else if (f === "position") out[f] = s.position ?? db.items.indexOf(s);
    else if (f === "cut") out[f] = s.status === "cut";
    else if (f === "shipped") out[f] = s.shipped ?? null;
    else if (f === "title") out[f] = s.title;
    else if (f === "outcome") out[f] = s.outcome ?? null;
    else if (f === "note") out[f] = s.note ?? null;
    else if (f === "draft") out[f] = !!s.draft;
    else if (f === "confidence") out[f] = s.confidence ?? null;
    else if (f === "feature_id") out[f] = s.feature_id ?? null;
    else if (f === "track_id") out[f] = s.track ? stableUuid(`simple-track/${s.track}`) : null;
    else if (f === "goal_ids") out[f] = goalIdsOf(s);
    else if (f === "goal_id") out[f] = s.goal && !goalInTrash(db, s.goal) ? stableUuid(`simple-goal/${s.goal}`) : s.map_goal && mapGoalRef(db, s.map_goal) ? s.map_goal : (featureGoalRef(db, key)?.id ?? null);
    else if (f === "prd_document_id") out[f] = ownPrd(s).id;
    else if (f === "depends_on") out[f] = [...(s.depends ?? [])];
    else if (f === "parent_key") out[f] = s.parent ?? null;
    else if (f === "code") out[f] = shownCode(s, (id) => db.feature_codes?.[id]);
    else if (f === "status") out[f] = s.merged_into ? "merged" : s.status === "cut" ? "cut" : s.draft ? "draft" : (s.status ?? "planned");
    else if (f === "risk") out[f] = (s.risks ?? []).find((r) => r.flag === target.flag && (r.subject ?? null) === (target.subject ?? null)) ?? null;
  }
  return out;
}

/** changes.py PANEL_DONE: the shipped mark the panel's Status set to done leaves. */
const PANEL_DONE = "Marked done in its panel";

/** changes.py set_status: its stored after, {cut, shipped}; planned clears only the panel's own done mark. */
function statusAfter(s: ReturnType<typeof seed>, status: string, by: string): Values {
  const kept = s.shipped?.note === PANEL_DONE ? null : (s.shipped ?? null);
  return { cut: status === "cut", shipped: status === "done" ? (s.shipped ?? { note: PANEL_DONE, by, on: iso(mockNowMs()).slice(0, 10) }) : kept };
}

/** The status the tracker gives the item, read before a cut or a shipped mark is written (kept as its tracked). */
function trackerStatus(s: ReturnType<typeof seed>): NonNullable<ReturnType<typeof seed>["tracked"]> {
  return !s.status || s.status === "cut" || s.status === "draft" || (s.status === "done" && s.shipped) ? "planned" : s.status;
}

function write(db: SimpleDb, key: string, values: Values, target: Values): void {
  const s = seed(db, key);
  if ("start_date" in values) {
    if (values.start_date && values.end_date) db.own[key] = { start: String(values.start_date), end: String(values.end_date), source: (values.date_source as "typed" | "accepted") ?? "typed" };
    else delete db.own[key];
  }
  if ("horizon" in values) s.horizon = values.horizon as typeof s.horizon;
  if ("position" in values) s.position = values.position as number;
  // set_status's {cut, shipped} is written below, from the tracker's status read before either is written.
  // cut / restore write {cut} alone: restored, it reads as service._status, its shipped mark, then the tracker's status.
  if ("cut" in values && !("shipped" in values)) {
    s.tracked ??= trackerStatus(s);
    s.status = values.cut ? "cut" : s.shipped ? "done" : s.tracked;
  }
  if ("title" in values) s.title = String(values.title);
  if ("draft" in values) s.draft = !!values.draft;
  if ("goal_ids" in values) {
    // set_goals (the goal buckets' move): the goals it serves.
    const keys = (values.goal_ids as string[]).map((id) => Object.keys(GOALS).find((k) => goalId(k) === id)).filter((k): k is string => !!k);
    s.goal = keys[0];
    s.goals = keys.slice(1);
  }
  if ("outcome" in values) s.outcome = (values.outcome as string | null) ?? null;
  if ("note" in values) s.note = (values.note as string | null) ?? null;
  // one-feature-panel: a track, goal or PRD is one another item of the roadmap read has (as the API's are rows).
  const like = (f: (x: typeof s) => unknown, v: unknown) => db.items.find((x) => f(x) === v);
  if ("feature_id" in values) s.feature_id = (values.feature_id as string | null) ?? null;
  if ("confidence" in values) s.confidence = (values.confidence as typeof s.confidence) ?? undefined;
  // empty-track (changes._exists): any track the company has, one that holds no item yet too.
  if ("track_id" in values) s.track = values.track_id ? Object.keys(TRACKS).find((k) => stableUuid(`simple-track/${k}`) === values.track_id) : undefined;
  if ("goal_id" in values) {
    s.goal = values.goal_id ? (Object.keys(GOALS).find((k) => goalId(k) === values.goal_id) ?? like((x) => x.goal && goalId(x.goal), values.goal_id)?.goal) : undefined;
    // goal-map-editing: a confirmed goal named by its id alone (goal-ladder's).
    s.map_goal = !s.goal && values.goal_id && String(values.goal_id) in MAP_GOALS ? String(values.goal_id) : undefined;
  }
  if ("prd_document_id" in values) {
    const x = like((x) => ownPrd(x).id, values.prd_document_id);
    if (x) s.prd_doc = ownPrd(x);
  }
  if ("depends_on" in values) s.depends = [...((values.depends_on as string[]) ?? [])];
  if ("parent_key" in values) s.parent = (values.parent_key as string | null) ?? undefined;
  if ("shipped" in values) {
    // changes.py set_status ({cut, shipped}): it reads as service._status: cut, then its shipped mark, then the tracker's status.
    s.tracked ??= trackerStatus(s);
    s.shipped = (values.shipped as typeof s.shipped) ?? null;
    s.status = values.cut ? "cut" : s.shipped ? "done" : s.tracked;
  }
  if ("risk" in values) {
    const kept = (s.risks ?? []).filter((r) => !(r.flag === target.flag && (r.subject ?? null) === (target.subject ?? null)));
    const risk = values.risk as { flag: never; note: string; subject?: string | null } | null;
    s.risks = risk ? [...kept, risk] : kept;
  }
}

function touched(c: Pick<Change, "op" | "target" | "after" | "before">): string[] {
  if (KEYED.includes(c.op)) return [...new Set([...Object.keys(c.after), ...Object.keys(c.before)])];
  // Review: a removed dependency touches the item it depended on too (changes.py _touched).
  if (c.op === "remove_dependency" && c.target.subject) return [String(c.target.item_id), String(c.target.subject)];
  return [String(c.target.item_id)];
}

function idle(s: Session): boolean {
  return Date.parse(s.last_change_at ?? s.started_at) <= mockNowMs() - IDLE_MS;
}

function openEditing(db: SimpleDb, me: string): Session | undefined {
  const s = (db.sessions ??= []).find((x) => x.started_by === me && x.kind === "editing" && !x.closed_at);
  if (s && idle(s)) {
    s.closed_at = iso(mockNowMs());
    return undefined;
  }
  return s;
}

function newSession(db: SimpleDb, me: string, kind: Session["kind"]): Session {
  const s: Session = { id: crypto.randomUUID(), kind, started_by: me, started_at: iso(mockNowMs()), last_change_at: null, closed_at: null };
  (db.sessions ??= []).push(s);
  return s;
}

/** A conflict's field and the fields of a change that write it (changes.py WRITES). */
const WRITES: Record<string, string[]> = { status: ["status", "cut", "shipped"], goal_id: ["goal_id", "goal_ids"] };
const IS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** changes._fields: the fields a conflict is about (its items' when keyed by item id); null for any field. */
function conflictFields(current: Values): string[] | null {
  const keys = Object.entries(current).flatMap(([k, v]) => (IS_ID.test(k) && v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [k]));
  if (!keys.length || keys.includes("dependents")) return null;
  return keys.flatMap((k) => WRITES[k] ?? [k]);
}

/** changes._writes: whether the change wrote one of these fields of one of these items. */
function writesFields(c: Change, ids: string[], fields: string[] | null): boolean {
  if (!(c.op === "set_goal_measure" ? [String(c.target.goal_id)] : touched(c)).some((i) => ids.includes(i))) return false;
  // A goal's measure: any change of it (targets._last_writer looks by the goal, not its fields).
  if (!fields || c.op === "set_goal_measure") return true;
  const wrote = KEYED.includes(c.op) ? ids.flatMap((i) => Object.keys((c.after[i] as Values | undefined) ?? {})) : Object.keys(c.after);
  return wrote.some((f) => fields.includes(f));
}

function conflict(db: SimpleDb, ctx: SimpleChangesCtx, current: Values, ids: string[], lead: string): Response {
  const fields = conflictFields(current);
  const writes = (db.changes ?? [])
    .filter((c) => ["applied", "accepted", "undone"].includes(c.status) && writesFields(c, ids, fields))
    .map((c) => ({ at: c.status === "accepted" && c.decided_at ? c.decided_at : c.at, who: c.status === "accepted" && c.decided_by ? c.decided_by : c.by }));
  const last = madeOrder(writes, (w) => [w.at], true)[0];
  // roadmap-edit-fixes (changes._last_writer): Oracle's draft filled it last: Oracle changed it.
  const oracle = db.items.filter((x) => ids.includes(db.ids[x.key]) && x.drafted_at).map((x) => x.drafted_at!).sort().reverse()[0];
  if (oracle && (!last || oracle >= last.at)) {
    return json(409, { detail: { message: `${lead}: changed by Oracle`, current, changed_by: { id: null, name: "Oracle" }, changed_at: oracle } });
  }
  const who = last ? { id: last.who, name: ctx.names[last.who] ?? "someone" } : null;
  return json(409, { detail: { message: `${lead}: changed by ${who?.name ?? "someone outside Simple"}`, current, changed_by: who, changed_at: last?.at ?? null } });
}

function flagsFor(db: SimpleDb, ids: string[]): Schemas["SimpleItemFlags"][] {
  const items = new Map(roadmapOut(db, "owner", new URLSearchParams())!.items.map((i) => [i.id, i]));
  const out: string[] = [];
  for (const id of ids) for (const i of [id, ...(items.get(id)?.needed_by ?? [])]) if (!out.includes(i)) out.push(i);
  return out.filter((i) => items.has(i)).map((i) => ({ item_id: i, flags: items.get(i)!.flags }));
}

function view(db: SimpleDb, ctx: SimpleChangesCtx, c: Change): Change {
  const s = (db.sessions ?? []).find((x) => x.id === c.session_id);
  const undone = (db.changes ?? []).some((x) => x.undoes_id === c.id);
  return {
    ...c,
    routed_to: route(db, ctx, c),
    undone,
    can_decide: c.status === "proposed" && decidesChange(db, ctx, c),
    can_undo: c.status === "applied" && c.by === ctx.id && !undone && !!s && !s.closed_at && !idle(s),
    words: changeSentence(c, c.by_name, c.op === "delete_goal" ? goalLabel(db, c.target.goal_id) : itemLabel(db, c.target.item_id), undone),
  };
}

/** The walk (H2): "F-08 Billing page", the item's code and name as the change's words name
 * it; trash-features-goals: once it is in Trash, its name with "(deleted)" (changes.deleted_names). */
function itemLabel(db: SimpleDb, id: unknown): string | null {
  const key = id ? keyOf(db, id) : undefined;
  const s = key ? db.items.find((x) => x.key === key) : undefined;
  if (!s) return null;
  return s.trashed ? `${s.title} (deleted)` : `${prdCode(s.section) ?? ""} ${s.title}`.trim();
}

/** trash-features-goals: a `delete_goal` change names the goal with "(deleted)" once it is
 * in Trash (changes.deleted_names); still live (a proposal waiting), the sentence's own
 * fallback (target.title) names it instead. */
function goalLabel(db: SimpleDb, id: unknown): string | null {
  const g = (db.goal_buckets?.goals ?? []).find((x) => x.id === id);
  return g?.trashed ? `${g.title} (deleted)` : null;
}

/** simple-replaced-prds (changes.listing): a proposal waiting on a replaced PRD's item leaves Simple with the item. */
function onReplacedPrd(db: SimpleDb, c: Change): boolean {
  if (c.status !== "proposed" || !c.target.item_id) return false;
  const key = keyOf(db, c.target.item_id);
  const s = key ? db.items.find((x) => x.key === key) : undefined;
  return !!s && ofReplacedPrd(db, s);
}

function sees(db: SimpleDb, ctx: SimpleChangesCtx, c: Change): boolean {
  if (ctx.role === "owner" || c.by === ctx.id || route(db, ctx, c).includes(ctx.id)) return true;
  if ((db.drafts ?? []).some((d) => (c.draft_ids ?? []).includes(d.out.id) && seesDraft(d, ctx, db))) return true;
  if ((db.sessions ?? []).some((s) => s.id === c.session_id && s.started_by === ctx.id)) return true;
  // changes.sees: the document's owners and who decides it; a PRD milestone's ask is its PRD owner's.
  if (c.op === MAP_LINK_OP) return decidesChange(db, ctx, c);
  if (c.op !== MILESTONE_OP || !c.before || "milestone" in c.before) return false;
  // changes.sees: and the PRD's reviewers, its decider among them (its review policy's), and its owners (drafts.who).
  const slug = prdSlugOf(db, c.document_id);
  const people = slug ? [...(db.prd_reviewers?.[slug] ?? []), db.prd_deciders?.[slug], ...prdOwnerIdsOf(db, slug)] : [];
  return people.includes(ctx.id) || decidesChange(db, ctx, c);
}

/** The drafts a change writes (drafts.write_items): the roadmaps' working drafts, opened on
 * their published items; for an undo, the change's own drafts while they are working. */
function intoDrafts(db: SimpleDb, c: Change, session: Session, undo = false): string[] | Response {
  if (TARGETS[c.op]) return [];
  const roadmaps = KEY_DATE_OPS.includes(c.op) ? [roadmapOfDoc(db, c.target.document_id)!] : [...new Set(touched(c).map((id) => seed(db, keyOf(db, id)!).roadmap))];
  const out: string[] = [];
  for (const rm of roadmaps) {
    const drafts = (db.drafts ??= []);
    let d = drafts.find((x) => x.roadmap === rm && x.out.status === "working");
    if (undo) {
      if (!d || !(c.draft_ids ?? []).includes(d.out.id)) return json(409, { detail: "Its draft was submitted: undo works only inside a working draft" });
    } else if (!d) {
      const waiting = drafts.find((x) => x.roadmap === rm && x.out.status === "submitted");
      if (waiting) return json(409, { detail: `This roadmap's draft is in review as version ${waiting.out.version}: changes wait until it is approved` });
      d = openDraft(db, rm, session.started_by);
    }
    if (!d.out.participant_ids.includes(session.started_by)) d.out.participant_ids.push(session.started_by);
    out.push(d.out.id);
  }
  return out;
}

/** D-d: the draft's applied changes, not undone: who, when, and whether in a meeting. */
function changeLog(db: SimpleDb, id: string): Schemas["SimpleDraftChange"][] {
  const cs = db.changes ?? [];
  return madeOrder(cs, (c) => [c.at])
    .filter((c) => ["applied", "accepted"].includes(c.status) && (c.draft_ids ?? []).includes(id) && !cs.some((u) => u.undoes_id === c.id))
    .map((c) => {
      const kind = (db.sessions ?? []).find((x) => x.id === c.session_id)?.kind ?? null;
      // roadmap-decide: every line names its item (a fix: then what else moved).
      const named = (c.target.titles as string[] | undefined) ?? [];
      const own = c.target.item_id ? keyOf(db, String(c.target.item_id)) : undefined;
      const titles = named.length ? named : own ? [seed(db, own).title] : c.target.name ? [String(c.target.name)] : [];
      return { id: c.id, op: c.op, item_id: (c.target.item_id as string) ?? null, by: c.by, by_name: c.by_name, at: c.at, session_kind: kind, in_meeting: kind === "meeting", titles };
    });
}

/** drafts._approver_of: the draft's final approval is the roadmap's decider's; with none, an editor's (an owner's, its track owner's). */
function approverOf(db: SimpleDb, ctx: Pick<SimpleChangesCtx, "id" | "role">, d: MockDraft): boolean {
  const decider = db.deciders?.[d.roadmap];
  return decider ? decider === ctx.id : canEditRoadmap(db, d.roadmap, ctx);
}

function draftOut(db: SimpleDb, ctx: SimpleChangesCtx, d: MockDraft): Schemas["SimpleDraftOut"] {
  const edits = canEditRoadmap(db, d.roadmap, ctx);
  const decider = db.deciders?.[d.roadmap];
  const approver = approverOf(db, ctx, d);
  // hotfix 4 (drafts.listing): the number it becomes, after the roadmap's latest version.
  const latest = Math.max(d.out.base_version ?? 0, ...(db.versions ?? []).filter((v) => v.roadmap === d.roadmap).map((v) => v.number));
  return {
    ...d.out, next_version: d.out.version ?? latest + 1, changes: draftChanges(db, d.out.id), change_log: changeLog(db, d.out.id), from_prds: draftPrds(d),
    // roadmap-decide review (drafts.outs): the author and the roadmap's set decider, by name.
    created_by_name: ctx.names[d.out.created_by] ?? null,
    decider: decider ? { id: decider, name: ctx.names[decider] ?? "its decider" } : null,
    can_submit: d.out.status === "working" && edits,
    can_resume: d.out.status === "working" && (d.out.created_by === ctx.id || decider === ctx.id),
    // Review: a decider who approved already waits on the required reviewers, not on themself;
    // an owner who sent a roadmap someone else decides does not approve it (drafts._approver_of).
    can_approve: d.out.status === "submitted" && ((approver && !d.out.decider_approved) || d.out.waiting_on.includes(ctx.id)),
    // roadmap-decide (drafts.outs): the decider's Approve and publish on a working draft (with no decider, an owner's).
    can_publish: d.out.status === "working" && approver && edits,
    // roadmap-decide review: who still reviews a working draft after the decider's approval.
    required_reviewers: d.out.status === "working" ? (db.reviewers?.[d.roadmap] ?? []).filter((r) => r !== ctx.id) : [],
    can_withdraw: d.out.status === "submitted" && (d.out.created_by === ctx.id || approver),
    published: !(db.unapproved ?? []).includes(d.roadmap),
    // decisions-reversed-or-trashed: notes on decisions it cited that were reversed since.
    decision_notes: [...(d.out.decision_notes ?? []), ...draftDecisionNotes()],
  };
}

/** /v1/simple/drafts (drafts.listing, submit, approve, resume). */
function routeDrafts(db: SimpleDb, ctx: SimpleChangesCtx, m: string, p: string[], q: URLSearchParams): Response | null {
  const now = iso(mockNowMs());
  // ?roadmap= (an id or slug): that roadmap's drafts only (a working draft belongs to one roadmap).
  const asked = q.get("roadmap");
  const rm = asked ? readableRoadmap(asked, ctx.role) : undefined;
  if (asked && !rm && !p[3]) return json(404, { detail: "No such roadmap" });
  const open = (db.drafts ?? []).filter((d) => ["working", "submitted"].includes(d.out.status) && (!rm || d.roadmap === rm));
  // simple-replaced-prds (as drafts.listing): a replaced PRD's open draft is history.
  const current = (d: MockDraft) => !ctx.replaced?.some((r) => r === d.out.document.slug || r === d.out.document.id);
  if (!p[3] && m === "GET") return json(200, open.filter((d) => current(d) && seesDraft(d, ctx, db)).map((d) => draftOut(db, ctx, d)));
  const d = (db.drafts ?? []).find((x) => x.out.id === p[3] && seesDraft(x, ctx, db));
  if (!d) return json(404, { detail: "No such draft" });
  if (!p[4] && m === "GET") return json(200, draftOut(db, ctx, d));
  if (m !== "POST") return null;
  if (p[4] === "submit") {
    if (!canEditRoadmap(db, d.roadmap, ctx)) return json(403, { detail: "Only an owner or the roadmap's decider (with none, its owner) submits" });
    if (d.out.status !== "working") return json(409, { detail: `This draft is ${d.out.status} already` });
    if (!draftChanges(db, d.out.id) && !draftPrds(d).length) return json(422, { detail: "Nothing to submit: the draft has no changes" });
    // inbox-meeting-proposals fix: it waits on the roadmap's required reviewers (not the one who sent it).
    const waiting = (db.reviewers?.[d.roadmap] ?? []).filter((r) => r !== ctx.id);
    Object.assign(d.out, { status: "submitted", version: (d.out.base_version ?? 1) + 1, submitted_at: now, submitted_by: ctx.id, waiting_on: waiting });
    return json(200, draftOut(db, ctx, d));
  }
  if (p[4] === "approve") {
    // roadmap-decide (drafts.approve): the decider's approval of a working draft sends it first.
    if (d.out.status === "working") {
      // Review minor 6: one rule (can_publish) for the button and the endpoint.
      if (!draftOut(db, ctx, d).can_publish) return json(403, { detail: "Only the roadmap's decider approves and publishes this draft" });
      if (!draftChanges(db, d.out.id) && !draftPrds(d).length) return json(422, { detail: "Nothing to submit: the draft has no changes" });
      // As submit (drafts._in_review): it waits on the roadmap's required reviewers.
      const waiting = (db.reviewers?.[d.roadmap] ?? []).filter((r) => r !== ctx.id);
      Object.assign(d.out, { status: "submitted", version: (d.out.base_version ?? 1) + 1, submitted_at: now, submitted_by: ctx.id, waiting_on: waiting });
    }
    // As drafts.approve: a second press in a stale tab, after this approver's approval published it, answers with it.
    if (d.out.status === "approved" && (approverOf(db, ctx, d) || (db.reviewers?.[d.roadmap] ?? []).includes(ctx.id))) return json(200, draftOut(db, ctx, d));
    if (d.out.status !== "submitted") return json(409, { detail: `This draft is ${d.out.status}: only a submitted draft is approved` });
    // As drafts._approve: the decider (with none, an editor), a required reviewer (one who approved
    // already may approve again: nothing changes) or anyone it waits on.
    const approver = approverOf(db, ctx, d);
    const reviewer = d.out.waiting_on.includes(ctx.id) || (db.reviewers?.[d.roadmap] ?? []).includes(ctx.id);
    if (!reviewer && !approver) return json(403, { detail: "Only the decider and the required reviewers approve this draft" });
    // A required reviewer's approval takes them off waiting_on; the decider's (or an owner's) is
    // the decider's. As drafts._settle: published once the decider approved and no one is left.
    const waiting = d.out.waiting_on.filter((r) => r !== ctx.id);
    const deciderApproved = d.out.decider_approved || approver;
    Object.assign(d.out, { decider_approved: deciderApproved, waiting_on: waiting });
    if (!deciderApproved || waiting.length) return json(200, draftOut(db, ctx, d));
    Object.assign(d.out, { status: "approved", approved_at: now });
    // trash-features-goals review 4: the version is made without the features in Trash.
    const without = db.items.filter((s) => s.trashed && s.roadmap === d.roadmap).map((s) => s.key);
    (db.versions ??= []).push({ roadmap: d.roadmap, number: d.out.version ?? (d.out.base_version ?? 1) + 1, without });
    return json(200, draftOut(db, ctx, d));
  }
  if (p[4] === "withdraw") {
    // S3b-1: back to working, its changes kept; the version is withdrawn (never approved).
    if (d.out.created_by !== ctx.id && !approverOf(db, ctx, d)) return json(403, { detail: "Only the draft's author or the roadmap's decider withdraws it" });
    if (d.out.status !== "submitted") return json(409, { detail: `This draft is ${d.out.status}: only a submitted draft is withdrawn` });
    Object.assign(d.out, { status: "working", version: null, submitted_at: null, submitted_by: null, decider_approved: false, waiting_on: [] });
    return json(200, draftOut(db, ctx, d));
  }
  if (p[4] === "resume") {
    if (d.out.created_by !== ctx.id && db.deciders?.[d.roadmap] !== ctx.id) return json(403, { detail: "Only the draft's author or the roadmap's decider resumes it" });
    if (d.out.status !== "working") return json(409, { detail: `This draft is ${d.out.status}: only a working draft resumes` });
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    return json(200, { session, draft: draftOut(db, ctx, d) });
  }
  return null;
}

/** A non-versioned change (targets.create): owners apply it, others propose it. */
function createTarget(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"], session: Session | undefined): Response {
  const now = iso(mockNowMs());
  const spec = TARGETS[body.op];
  const target: Values = { ...body.target };
  if (target.item_id && !keyOf(db, target.item_id)) return json(404, { detail: "No such roadmap item" });
  // A feature ask is filed directly by every commenter and up (targets.py _who).
  const applies = body.op === "add_feature_ask" || decides(db, ctx, target.item_id);
  // S6 (./simple-priorities.ts): a pin and an estimate are compared and stored as targets.py does.
  const ranking = body.op === "override_priority" || body.op === "estimate_feature";
  if (ranking && !target.item_id) {
    if (typeof target.feature_id !== "string" || !target.feature_id) return json(422, { detail: "target: item_id or feature_id" });
    // prio-company (targets.create): moving a feature not on the company roadmap adds it there,
    // an owner's right; then the move is the item's. An estimate is the feature's (stored here
    // under the item standing for it).
    if (body.op === "override_priority" && ctx.role !== "owner") return json(403, { detail: "Only an owner can add a feature to the company roadmap" });
    const key = body.op === "override_priority" ? addToCompany(db, target.feature_id, readerDb(db, ctx)) : featureItem(db, target.feature_id);
    if (!key) return json(404, { detail: "No such feature" });
    if (typeof key === "object") return json(422, { detail: key.refused });
    target.item_id = db.ids[key];
  }
  if (spec.adds) target[spec.id] = crypto.randomUUID();
  const id = String(target[spec.id] ?? "");
  const stored = (db.targets ??= {})[id] ?? {};
  const after = ranking ? priorityAfter(body.op, body.after ?? {}) : { ...body.after };
  if (typeof after === "string") return json(422, { detail: after });
  // S9: a feature ask's requester and channel as targets.py stores them.
  if (body.op === "add_feature_ask") {
    const name = typeof after.requester_name === "string" ? after.requester_name.split(/\s+/).filter(Boolean).join(" ") || null : null;
    Object.assign(after, { requester_name: name, requester_kind: after.requester_kind || (name ? "customer" : "unknown"), channel: after.channel || "other" });
  }
  // walkc-roadmap-tasks: a task's owner is a person (targets.py stores owner_id); the chat's
  // "for <name>" names them.
  if (body.op === "add_item_task" && !after.owner_id && typeof after.owner_name === "string") {
    const asked = after.owner_name.trim().toLowerCase();
    const hit = Object.entries(ctx.names).find(([, n]) => n.toLowerCase() === asked) ?? Object.entries(ctx.names).find(([, n]) => n.toLowerCase().split(" ")[0] === asked);
    if (hit) Object.assign(after, { owner_id: hit[0], owner_name: hit[1] });
  }
  if (body.op === "add_item_task" && after.owner_id && !after.owner_name) after.owner_name = ctx.names[String(after.owner_id)] ?? null;
  // item-milestone (changes._roadmap_milestone): a goal milestone of the item's roadmap picked in
  // its panel, stored by id with its code and name and no date.
  const pickedMs = body.op === "set_milestone" ? (after.milestone as Values | null | undefined) : undefined;
  if (pickedMs && typeof pickedMs === "object" && pickedMs.id) {
    const refused = pickRefused(db, target.item_id, pickedMs.id);
    if (refused) return json(422, { detail: refused });
    const gm = (db.goal_milestones ?? []).find((m) => m.id === pickedMs.id)!;
    after.milestone = { id: gm.id, name: `${gm.code} ${gm.name}`, date: null, date_source: null };
  }
  if (body.op === "set_goal_measure") {
    // targets.py: the goal the item's read shows; a measure (target and date may be empty); before as read, else 409.
    if (!target.item_id || read(db, keyOf(db, target.item_id)!, ["goal_id"], target).goal_id !== target.goal_id) return json(422, { detail: "target.goal_id: the goal the item serves" });
    const line = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ") || null;
    const measure = line(body.after?.measure);
    if (!measure || measure.length > 300) return json(422, { detail: "after.measure: required, at most 300 characters" });
    const due = line(body.after?.due);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json(422, { detail: "after.due: a day as YYYY-MM-DD" });
    // goal-target-kept: a measured goal keeps its number and unit: a bare number is in its unit,
    // clearing it is refused.
    const gk = roadmapGoalKey(String(target.goal_id ?? ""), db);
    const kept = keptTarget(gk, gk ? roadmapGoal(db, gk).target : null, line(body.after?.target), storedUnit(db, gk));
    if ("detail" in kept) return json(422, kept);
    Object.assign(after, { measure, target: kept.target, due });
    for (const k of Object.keys(after)) if (!["measure", "target", "due"].includes(k)) delete after[k];
  }
  const before: Values = ranking
    ? priorityBefore(db, keyOf(db, target.item_id)!, body.op, id)
    : (body.op as string) === "set_owner"
      ? // one-feature-panel: the API's before is the item's own owner (null: its track's shown); the chat sends the shown one.
        { owner_id: body.before.owner_id === (namedOn(db, keyOf(db, target.item_id)!, "owner_id") ?? null) ? (body.before.owner_id ?? null) : itemOwnerId(db, keyOf(db, target.item_id)!) }
      : (body.op as string) === "set_decider"
        ? { decider_id: itemDeciderId(db, keyOf(db, target.item_id)!, ctx.roles) }
        : (body.op as string) === "set_goal_measure"
          ? goalMeasure(db, target.goal_id)!
          : body.op === "set_milestone"
            ? { milestone: ownMilestone(db, keyOf(db, target.item_id)!) }
            : spec.adds ? {} : Object.fromEntries(Object.keys(body.before).map((k) => [k, stored[k] ?? null]));
  const seen = ranking || (body.op as string) === "set_goal_measure" ? Object.fromEntries(Object.keys(before).map((k) => [k, body.before[k] ?? null])) : body.before;
  // goal-buckets-tasks: a milestone is matched by its name and date as the item reads them (changes._seen_milestone).
  const matches = body.op === "set_milestone" ? seenMilestone(before.milestone) === seenMilestone(seen.milestone) : same(before, seen);
  if (!spec.adds && !matches) return conflict(db, ctx, before, [id], "Changed since you saw it");
  // build-feature-panel: an owner or decider set to what it is already records nothing (changes.py).
  if ((body.op === "set_owner" || body.op === "set_decider") && same(before, Object.fromEntries(Object.keys(before).map((k) => [k, after[k] ?? null])))) return json(422, { detail: "No change: it is so already" });
  if (body.op === "override_priority" && after.override === null && !before.override) return json(409, { detail: "It is at Oracle's rank already" });
  const change: Change = {
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: target.item_id ? stableUuid(`simple-doc/${seed(db, keyOf(db, target.item_id)!).roadmap}`) : null,
    draft_ids: [], op: body.op, target, before, after, status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (!applies) change.routed_to = route(db, ctx, change);
  if (applies) {
    writeTarget(db, change, change.after, false, ctx);
    session!.last_change_at = now;
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

/** item-milestone (changes._roadmap_milestone): why a goal milestone cannot be picked for the item, in its plain words; null when it can. */
function pickRefused(db: SimpleDb, itemId: unknown, milestoneId: unknown): string | null {
  const gm = (db.goal_milestones ?? []).find((m) => m.id === milestoneId);
  const k = keyOf(db, itemId);
  if (!gm || !k || gm.roadmap !== seed(db, k).roadmap) return "That milestone is not on this item's roadmap.";
  return gm.deleted ? "That milestone was deleted." : null;
}

/** A milestone as the item reads it: the goal milestone picked for it (its id), else its name
 * and day (changes._seen_milestone). */
function seenMilestone(m: unknown): string {
  const v = (m ?? {}) as Values;
  if (v.id) return JSON.stringify(["id", v.id]);
  return v.name || v.date ? JSON.stringify([v.name || null, v.date || null]) : "none";
}

/** The item's depends_on with only the change's own keys turned back (changes._depends_back); null: one changed since. */
function dependsBack(current: Values, before: Values, after: Values): Values | null {
  const now = (current.depends_on as string[] | null) ?? [];
  const was = (before.depends_on as string[] | null) ?? [];
  const made = (after.depends_on as string[] | null) ?? [];
  const added = made.filter((k) => !was.includes(k));
  const removed = was.filter((k) => !made.includes(k));
  if (added.some((k) => !now.includes(k)) || removed.some((k) => now.includes(k))) return null;
  return { depends_on: [...now.filter((k) => !added.includes(k)), ...removed] };
}

function writeTarget(db: SimpleDb, c: Change, values: Values, undo = false, ctx?: SimpleChangesCtx): void {
  const spec = TARGETS[c.op];
  // S9: a feature ask is a request in Requests (targets.py: a ProductRequest under target.request_id).
  if (c.op === "add_feature_ask" && ctx) {
    const id = String(c.target[spec.id]);
    if (undo) ctx.dropAsk?.(id);
    else
      ctx.fileAsk?.({
        id, title: String(values.title ?? ""), channel: String(values.channel ?? "other"), requester_name: (values.requester_name as string | null) ?? null,
        requester_kind: String(values.requester_kind ?? (values.requester_name ? "customer" : "unknown")), filed_by: c.by,
      });
  }
  const id = String(c.target[spec.id]);
  const targets = (db.targets ??= {});
  if (c.op === "set_goal_measure") {
    const k = roadmapGoalKey(id, db)!;
    writeRoadmapGoal(db, k, { title: roadmapGoal(db, k).title, metric: (values.measure as string | null) ?? null, target: (values.target as string | null) ?? null, due: (values.due as string | null) ?? null });
    return;
  }
  if (spec.adds && undo) delete targets[id];
  // walkc-roadmap-tasks: a task is stored under its item, open, as RoadmapItemTask is.
  else if (c.op === "add_item_task") targets[id] = { status: "todo", owner_id: null, due_date: null, ...values, kind: "item_task", item_id: c.target.item_id, at: c.at };
  else targets[id] = { ...(targets[id] ?? {}), ...values };
  // feature-panel (trash.drop_task, targets._task_trash): a dropped task goes to Settings › Trash
  // with the status it had; set back from dropped (an undo, a later status) it leaves Trash.
  if (KIND_TASK.has(c.op)) {
    const trash = (ctx ? (ctx.trash ??= { entries: [], estimates: {} }) : undefined);
    const t = targets[id] as { title?: string; status?: string } | undefined;
    const left = !t || (undo && c.op === "add_item_task") || t.status !== "dropped";
    if (trash && left) trash.entries = trash.entries.filter((e) => !(e.out.root.type === "task" && e.out.root.id === id));
    else if (trash && t && c.op === "set_item_task_status" && values.status === "dropped" && !trash.entries.some((e) => e.out.root.type === "task" && e.out.root.id === id)) {
      const now = iso(mockNowMs());
      const was = (undo ? c.after : c.before) as { status?: string };
      trash.entries.push({
        out: {
          id: crypto.randomUUID(),
          root: { type: "task", id, slug: null, title: String(t.title ?? ""), kind: "Task" },
          items: [], deleted_by: ctx!.id, deleted_by_name: ctx!.names[ctx!.id] ?? "someone", deleted_at: now,
          reason: null, published: false, purge_after: new Date(Date.parse(now) + 30 * DAY).toISOString(),
        },
        documents: [], versions: [], runs: [], intakes: [], task_status: was.status && was.status !== "dropped" ? was.status : "todo",
      });
    }
  }
  // feature-panel: a task's owner changed in its panel (or undone) reads by the person's name, as service._tasks does.
  if (c.op === "edit_item_task" && "owner_id" in values) targets[id].owner_name = values.owner_id ? (ctx?.names[String(values.owner_id)] ?? null) : null;
  // An item's own milestone (set_milestone, and its undo) is what the roadmap reads of it.
  if (c.op === "set_milestone") {
    const key = keyOf(db, c.target.item_id);
    const s = key ? db.items.find((x) => x.key === key) : undefined;
    const m = values.milestone as { name: string; date?: string | null; id?: string | null } | null | undefined;
    if (s) {
      const w = simpleWindows(companyToday())[s.horizon][0];
      s.milestone = m?.id
        ? { id: m.id, name: m.name, day: null }
        : m ? { name: m.name, day: m.date ? Math.round((Date.parse(`${m.date}T00:00:00Z`) - Date.parse(`${w}T00:00:00Z`)) / DAY) : null } : undefined;
    }
  }
}

/** A milestone's date as its day from the horizon's start (SeedItem.milestone), null with no date. */
function dayIn(horizon: SeedItem["horizon"], date: unknown): number | null {
  if (typeof date !== "string" || !date) return null;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${simpleWindows(companyToday())[horizon][0]}T00:00:00Z`)) / DAY);
}

/** An item's own milestone as RoadmapItem.milestone stores it: {name, date, date_source}, or null. */
function ownMilestone(db: SimpleDb, key: string): Values | null {
  const s = db.items.find((x) => x.key === key);
  // item-milestone: a picked goal milestone is held by its id (no date).
  if (s?.milestone?.id) return { id: s.milestone.id, name: pickedName(db, s.milestone), date: null, date_source: null };
  if (!s?.milestone || !(s.milestone.name || s.milestone.day != null)) return null;
  const date = s.milestone.day == null ? null : addDays(simpleWindows(companyToday())[s.horizon][0], s.milestone.day);
  // What the date engine stored besides (never shown, never compared).
  return { date_source: date ? "typed" : null, ...(s.milestone.engine ?? {}), name: s.milestone.name ?? null, date };
}

/** The new [start, end] of every item a fix moves (changes._fix_plan). */
function fixPlan(db: SimpleDb, op: string, itemId: string, depId: string): Record<string, [string, string]> {
  const items = new Map(roadmapOut(db, "owner", new URLSearchParams())!.items.map((i) => [i.id, i]));
  const item = items.get(itemId)!;
  if (op === "move_dependency") {
    const dep = items.get(depId)!;
    const end = addDays(item.start.date, -1);
    return { [depId]: [addDays(dep.start.date, days(dep.end.date, end)), end] };
  }
  return shiftPlan(items, itemId, depId);
}

/**
 * changes._move_feature: set_goals on an item with a baseline feature moves the feature too, as a
 * goal-bucket move does: the goal it now moves most becomes the feature's first goal link (what the
 * dated goal buckets place it by), and the goal it showed under is dropped unless the item still
 * serves it. A roadmap goal is the goal buckets' goal of the same name.
 */
function moveFeature(db: SimpleDb, key: string, goalIds: string[]): void {
  const code = featureKeyOf(db, key);
  const gb = goalBucketsDb(db);
  const f = gb.features.find((x) => x.key.toLowerCase() === code.toLowerCase());
  const ids = goalIds.flatMap((id) => {
    const name = GOALS[Object.keys(GOALS).find((k) => goalId(k) === id) ?? ""];
    const g = gb.goals.find((x) => !x.archived && (x.id === id || (!!name && x.title === name)));
    return g ? [g.id] : [];
  });
  if (!f || !ids.length) return;
  const shown = f.goal_ids[0];
  f.goal_ids = [ids[0], ...f.goal_ids.filter((g) => g !== ids[0] && (g !== shown || ids.includes(shown)))];
}

function apply(db: SimpleDb, c: Change, values: Values, undo = false): void {
  if (KEYED.includes(c.op)) for (const [id, v] of Object.entries(values)) write(db, keyOf(db, id)!, v as Values, c.target);
  else write(db, keyOf(db, c.target.item_id)!, values, c.target);
  if (c.op === "set_goals") moveFeature(db, keyOf(db, c.target.item_id)!, values.goal_ids as string[]);
  if (c.op === "accept_date_suggestion") {
    const s = db.suggestions.find((x) => x.id === c.target.suggestion_id);
    // plan-model: a slice's suggestion is decided with the item's other open slices (and undone with them).
    const others = (status: string) => (s?.slice_code != null ? db.suggestions.filter((x) => x !== s && x.item_id === s.item_id && x.status === status && (status === "open" || x.decided_at === s.decided_at)) : []);
    if (s && !undo && s.status === "open") {
      const decided = { status: c.target.edited ? "edited" : "accepted", decided_at: iso(mockNowMs()) } as const;
      for (const o of [s, ...others("open")]) Object.assign(o, decided);
    }
    if (s && undo && (s.status === "accepted" || s.status === "edited")) for (const o of [...others(s.status), s]) Object.assign(o, { status: "open", decided_by: null, decided_at: null });
  }
}

function current(db: SimpleDb, c: Change, like: Values): Values {
  if (KEYED.includes(c.op)) return Object.fromEntries(Object.entries(like).map(([id, v]) => [id, read(db, keyOf(db, id)!, Object.keys(v as Values), c.target)]));
  return read(db, keyOf(db, c.target.item_id)!, Object.keys(like), c.target);
}

function normal(fields: string[], values: Values): Values {
  return Object.fromEntries(fields.map((f) => [f, values[f] ?? null]));
}

/** The key date as the caller reads it (the working draft's when they see it). */
function keyDateNow(db: SimpleDb, ctx: SimpleChangesCtx, rm: string, id: string): MockKeyDate | null {
  const d = (db.drafts ?? []).find((x) => x.roadmap === rm && ["working", "submitted"].includes(x.out.status));
  const list = d && !seesDraft(d, ctx, db) ? (d.published.key_dates ?? []) : (db.key_dates?.[rm] ?? []);
  return list.find((k) => k.id === id) ?? null;
}

const kdValue = (k: MockKeyDate | null): Values | null => (k ? { name: k.name, date: k.date, note: k.note } : null);

function kdChecked(v: Values): Values | string {
  const name = String(v.name ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 120) return "after.name: 1 to 120 characters";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.date ?? ""))) return "after.date: a day as YYYY-MM-DD";
  const note = String(v.note ?? "").trim() || null;
  return { name, date: String(v.date), note };
}

/** milestone-rights (goal_milestones.create_change): a roadmap's own goal milestone, proposed
 * by who may not change it (an approver who is not its owner, a commenter); `after.milestone`
 * null proposes removing it. Routed as a key date's proposal is. */
const MILESTONE_OP = "edit_goal_milestone";

function createMilestoneChange(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Response {
  if (ctx.role === "viewer") return json(403, { detail: "Viewers may not propose a change" });
  const m = (db.goal_milestones ?? []).find((x) => x.id === body.target.milestone_id && !x.deleted);
  const kr = m ? null : ctx.ladder?.find(String(body.target.milestone_id));
  const gt = m || kr || (db.goal_milestones ?? []).some((x) => x.id === body.target.milestone_id) ? null : goalTargetOf(db, body.target.milestone_id);
  if (gt) return proposeTargetName(db, ctx, gt, body);
  if (!m && !kr) return json(404, { detail: "No such milestone" });
  if (m?.prd) return json(422, { detail: "A PRD's milestone: change it on its card (it asks the PRD's owner)" });
  if (m ? canEditRoadmap(db, m.roadmap, ctx) : kr!.can_change) return json(409, { detail: "You change this milestone directly" });
  if (!("milestone" in body.before) || !("milestone" in (body.after ?? {}))) return json(422, { detail: "before.milestone and after.milestone (null: remove it)" });
  const current = m ? milestoneValue(m, db.ids) : kr!.value;
  // every-field-editable (goal_milestones.create_change): before.milestone may name only the fields seen.
  const seenMs = body.before.milestone as Record<string, unknown> | null;
  if (!seenMs || typeof seenMs !== "object" || !Object.keys(seenMs).length || Object.keys(seenMs).some((k) => !(k in current))) return json(422, { detail: "before.milestone: the milestone as you saw it (name, date, goal_id, item_ids, counts_when)" });
  if (!same(seenMs, Object.fromEntries(Object.keys(seenMs).map((k) => [k, current[k]])))) return json(409, { detail: { message: "Changed since you saw it", current: { milestone: current }, changed_by: null, changed_at: null } });
  const wanted = body.after?.milestone as Record<string, unknown> | null;
  const after = wanted ? { ...current, ...Object.fromEntries(Object.entries(wanted).filter(([k, v]) => k in current && (v !== null || k === "goal_id"))) } : null;
  if (after && same(after, current)) return json(422, { detail: "after.milestone: nothing changes" });
  // milestone-rename: a Goal map milestone's proposal is its roadmap's, as a roadmap milestone's is.
  const doc = m ? stableUuid(`simple-doc/${m.roadmap}`) : kr!.roadmap ? stableUuid(`simple-doc/${kr!.roadmap}`) : null;
  // key_dates.route; a Goal map milestone off the Simple roadmap goes to the map's decider, else the owners.
  const roadmap = m ? m.roadmap : kr!.decider ? null : kr!.roadmap;
  const routed = roadmap ? roadmapRoute(db, roadmap, ctx.roles, ctx.owners) : kr!.decider ? [kr!.decider] : ctx.owners;
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: doc, draft_ids: [], op: body.op, target: { milestone_id: String(body.target.milestone_id), roadmap_id: doc, name: m?.name ?? kr!.name },
    before: { milestone: current }, after: { milestone: after }, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: routed, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

/** milestone-rename (goal_milestones._propose_target): a proposed name for a goal's own milestone
 * (before and after.milestone: its name alone), routed to who decides its roadmap. */
function proposeTargetName(db: SimpleDb, ctx: SimpleChangesCtx, gt: NonNullable<ReturnType<typeof goalTargetOf>>, body: Schemas["SimpleChangeIn"]): Response {
  if (canEditRoadmap(db, gt.roadmap, ctx)) return json(409, { detail: "You change this milestone directly" });
  const seenMs = (body.before ?? {}).milestone as Values | null | undefined;
  const wanted = (body.after ?? {}).milestone as Values | null | undefined;
  const nameOnly = (v: Values | null | undefined): v is Values => !!v && typeof v === "object" && Object.keys(v).join() === "name";
  if (!nameOnly(seenMs) || !nameOnly(wanted) || !String(wanted.name ?? "").trim()) return json(422, { detail: "A goal's milestone: before.milestone and after.milestone name it alone" });
  const current = gt.goal.name;
  if (seenMs.name !== current) return json(409, { detail: { message: "Changed since you saw it", current: { milestone: { name: current } }, changed_by: null, changed_at: null } });
  const name = String(wanted.name).trim().slice(0, 200);
  if (name === current) return json(422, { detail: "after.milestone: nothing changes" });
  const doc = stableUuid(`simple-doc/${gt.roadmap}`);
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: doc, draft_ids: [], op: MILESTONE_OP,
    target: { milestone_id: gt.goal.id, roadmap_id: doc, name: current, goal_target: true },
    before: { milestone: { name: current } }, after: { milestone: { name } }, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: roadmapRoute(db, gt.roadmap, ctx.roles, ctx.owners), undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

function writeKeyDate(db: SimpleDb, c: Change, value: unknown): void {
  const rm = roadmapOfDoc(db, c.target.document_id)!;
  const id = String(c.target.key_date_id);
  const list = (db.key_dates ??= {})[rm] ?? [];
  const v = value as Values | null;
  db.key_dates[rm] = v ? [...list.filter((k) => k.id !== id), { id, name: String(v.name), date: String(v.date), note: (v.note as string | null) ?? null }] : list.filter((k) => k.id !== id);
}

/**
 * trash-features-goals (oracle.simple.trash_items): DELETE .../roadmap/items/{id} moves the
 * feature to Settings › Trash; who may not decide on it proposes it instead, as a
 * `delete_item` change (routed, accepted or declined like any other). Restore brings it back
 * with its links, goal and milestone, which were never touched.
 */
function trashFeature(db: SimpleDb, ctx: SimpleChangesCtx, key: string, reason: string | null, now: string): TrashEntryRow {
  const s = seed(db, key);
  s.trashed = true;
  closeProposals(db, ctx, "delete_item", "item_id", db.ids[key], now);
  const row: TrashEntryRow = {
    out: {
      id: crypto.randomUUID(),
      root: { type: "feature", id: db.ids[key], slug: key, title: s.title, kind: "feature", code: prdCode(s.section) },
      items: [], deleted_by: ctx.id, deleted_by_name: ctx.names[ctx.id] ?? "someone", deleted_at: now,
      reason, published: false, purge_after: new Date(Date.parse(now) + 30 * DAY).toISOString(),
    },
    documents: [], versions: [], runs: [], intakes: [], roadmap: s.roadmap,
  };
  const trash = (ctx.trash ??= { entries: [], estimates: {} });
  trash.entries.push(row);
  return row;
}

/** trash_items._close_proposals: a proposal to delete what just went to Trash is closed, "Already in Trash". */
export function closeProposals(db: { changes?: Change[] }, ctx: { id: string }, op: string, ref: string, id: string, now: string) {
  for (const c of db.changes ?? []) {
    if (c.op === op && c.status === "proposed" && c.target[ref] === id) {
      Object.assign(c, { status: "declined", decided_by: ctx.id, decided_at: now, decision_reason: ALREADY });
    }
  }
}

const ALREADY = "Already in Trash";

/** trash_items._propose_goal: a commenter's goal delete, proposed to the company's owners (an
 * approver or up decides it). */
export function proposeGoalDelete(db: SimpleDb, ctx: SimpleChangesCtx, goal: { id: string; title: string }, to: string | null, reason: string | null): Change | Response {
  if ((db.changes ?? []).some((c) => c.op === "delete_goal" && c.status === "proposed" && c.target.goal_id === goal.id)) {
    return json(409, { detail: "Moving this to Trash is proposed already" });
  }
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: null, draft_ids: [],
    op: "delete_goal", target: { goal_id: goal.id, title: goal.title, to_goal_id: to }, before: { deleted: false }, after: { deleted: true },
    status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason, decision_reason: null, routed_to: ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  (db.changes ??= []).push(change);
  return view(db, ctx, change);
}

/** trash_items._propose: a `delete_item` already waits on this item (409). */
function openDelete(db: SimpleDb, itemId: unknown): boolean {
  return (db.changes ?? []).some((c) => c.op === "delete_item" && c.status === "proposed" && c.target.item_id === itemId);
}

/** Applies (the decider) or proposes (everyone else) a feature's delete, shared by the
 * `delete_item` change and the DELETE route. */
function doDeleteItem(db: SimpleDb, ctx: SimpleChangesCtx, itemId: string, reason: string | null): { change: Change; row: TrashEntryRow | null } | Response {
  const key = keyOf(db, itemId);
  if (!key || seed(db, key).trashed) return json(404, { detail: "No such roadmap item" });
  const applies = decides(db, ctx, itemId);
  if (!applies && openDelete(db, itemId)) return json(409, { detail: "Moving this to Trash is proposed already" });
  const now = iso(mockNowMs());
  const s = seed(db, key);
  const name = `${prdCode(s.section) ?? ""} ${s.title}`.trim();
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: stableUuid(`simple-doc/${s.roadmap}`), draft_ids: [],
    op: "delete_item", target: { item_id: itemId, title: s.title, name }, before: { deleted: false }, after: { deleted: true },
    status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  const row = applies ? trashFeature(db, ctx, key, reason, now) : null;
  if (!applies) change.routed_to = route(db, ctx, change);
  (db.changes ??= []).push(change);
  return { change, row };
}

/** POST /v1/simple/changes op `delete_item` (target.item_id): the same as the DELETE route, as a change. */
function createDeleteItem(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Response {
  const res = doDeleteItem(db, ctx, String(body.target.item_id ?? ""), body.reason ?? null);
  if (res instanceof Response) return res;
  return json(201, { change: view(db, ctx, res.change), flags: [] });
}

/** DELETE /v1/simple/roadmap/items/{id}: a `TrashedOut` (the entry, or the change proposed). */
function deleteItemRoute(db: SimpleDb, ctx: SimpleChangesCtx, itemId: string, reason: string | null): Response {
  const res = doDeleteItem(db, ctx, itemId, reason);
  if (res instanceof Response) return res;
  return json(200, {
    entry: res.row ? entryOut(res.row, iso(mockNowMs()), true) : null,
    change: res.row ? null : view(db, ctx, res.change),
    // Whoever deleted it restores it too (mayRestore); a proposal waits, so only an owner.
    can_restore: res.row ? true : ctx.role === "owner",
  });
}

/** POST /v1/simple/roadmap/items/{id}/restore (an owner, or whoever deleted it): puts the feature back from Trash. */
function restoreItemRoute(db: SimpleDb, ctx: SimpleChangesCtx, itemId: string): Response {
  if (ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  const entry = ctx.trash?.entries.find((e) => e.out.root.type === "feature" && e.out.root.id === itemId);
  if (!entry) return json(404, { detail: "No such roadmap item" });
  if (!mayRestore(entry, ctx)) return json(403, { detail: "Only an owner, or whoever deleted it, restores this" });
  const taken = restoreCodeTaken(db, ctx, entry);
  if (taken) return json(409, { detail: taken });
  return json(200, restoreFromTrash(ctx.trash!, entry, iso(mockNowMs()), db, ctx.id));
}

/** trash_items._codes_free: an item coming back whose code another item took while it was in Trash (its title's, as an add
 * checks it; its feature's or PRD's, against other items' title codes), in set_code's words; null when it is free. Every
 * restore goes through it, a feature's and a goal's: as the API, it checks the items the entry brings back (a goal's entry
 * holds the goal alone, so a goal comes back and an item deleted before stays in Trash). */
export function restoreCodeTaken(db: SimpleDb, me: { id: string; role: Role }, entry: TrashEntryRow): string | null {
  const root = entry.out.root;
  const back = root.type === "feature" ? db.items.filter((x) => x.key === root.slug && x.trashed && (!entry.roadmap || x.roadmap === entry.roadmap)).slice(0, 1) : [];
  const seen = back.length ? readerDb(db, me) : null;
  for (const s of back) {
    const own = (s.feature_id && db.feature_codes?.[s.feature_id]) || prdCode(s.section);
    const taken = own ? ownCodeTaken(seen!, s.key, own) : titleCodeTaken(db, seen!, null, s.title);
    if (taken) return `${taken}: rename it first`;
  }
  return null;
}

/** add_key_date / edit_key_date / remove_key_date (key_dates.create). */
function createKeyDate(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"], session: Session | undefined, applies: boolean): Response {
  const now = iso(mockNowMs());
  const rm = roadmapOfDoc(db, body.target.document_id);
  if (!rm) return json(404, { detail: "No such roadmap" });
  if (!("key_date" in body.before)) return json(422, { detail: "before.key_date: the key date as you saw it (or null)" });
  const target: Values = { document_id: body.target.document_id };
  let current: Values | null = null;
  let after: Values | string | null;
  if (body.op === "add_key_date") {
    target.key_date_id = crypto.randomUUID();
    after = kdChecked(body.after ?? {});
  } else {
    target.key_date_id = body.target.key_date_id;
    current = kdValue(keyDateNow(db, ctx, rm, String(body.target.key_date_id)));
    if (!current) return json(404, { detail: "No such key date on this roadmap" });
    after = body.op === "edit_key_date" ? kdChecked({ ...current, ...(body.after ?? {}) }) : null;
  }
  if (typeof after === "string") return json(422, { detail: after });
  if (!same(body.before.key_date ?? null, current)) return json(409, { detail: { message: "Changed since you saw it", current: { key_date: current }, changed_by: null, changed_at: null } });
  const deciders = db.deciders?.[rm];
  const change: Change = {
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: String(body.target.document_id), draft_ids: [], op: body.op, target,
    before: { key_date: current }, after: { key_date: after }, status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: applies ? [] : deciders ? [deciders] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (applies) {
    const drafts = intoDrafts(db, change, session!);
    if (drafts instanceof Response) return drafts;
    change.draft_ids = drafts;
    writeKeyDate(db, change, after);
    session!.last_change_at = now;
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

async function create(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Promise<Response> {
  if (S7_OPS.includes(body.op)) return createS7(db, ctx, body);
  if (body.op === "delete_item") return createDeleteItem(db, ctx, body);
  if (body.op === MILESTONE_OP) return createMilestoneChange(db, ctx, body);
  if (GOAL_ASK_OPS.includes(body.op) || body.op === "delete_goal") return createGoalAsk(db, ctx, body);
  if (body.op === "merge_twin") return createTwinMerge(db, ctx, body);
  if (body.op === MAP_LINK_OP) return createMapLink(db, ctx, body);
  const now = iso(mockNowMs());
  if (KEY_DATE_OPS.includes(body.op)) {
    // The Roadmap filter names the roadmap as roadmap_id (as add_item does); either works.
    const named = [...new Set([body.target.document_id, body.target.roadmap_id].filter(Boolean))];
    if (named.length > 1) return json(422, { detail: "target: document_id and roadmap_id name different roadmaps" });
    const target: Record<string, unknown> = { ...body.target, document_id: named[0] };
    delete target.roadmap_id;
    body = { ...body, target };
    const rm = roadmapOfDoc(db, body.target.document_id);
    if (rm && !readsRoadmap(rm, ctx.role)) return json(404, { detail: "No such roadmap" });
    const applies = !!rm && canEditRoadmap(db, rm, ctx);
    let session: Session | undefined;
    if (applies) session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    return createKeyDate(db, ctx, body, session, applies);
  }
  const target: Values = { ...body.target };
  const key = TARGETS[body.op] ? "" : keyOf(db, target.item_id);
  if (key === undefined) return json(404, { detail: "No such roadmap item" });
  // Review major (changes.create): a cut with its dependents applies when the caller decides every item it cuts.
  const cutAll = body.op === CUT_ALL && key ? [String(target.item_id), ...cutDependents(roadmapOut(readerDb(db, ctx), "owner", new URLSearchParams())!.items, String(target.item_id)).map((i) => i.id)] : null;
  const applies = cutAll ? cutAll.every((id) => decides(db, ctx, id)) : decides(db, ctx, target.item_id);
  let session: Session | undefined;
  if (body.session_id) {
    session = (db.sessions ?? []).find((s) => s.id === body.session_id && s.started_by === ctx.id);
    if (!session) return json(404, { detail: "No such session of yours" });
    if (session.closed_at || idle(session)) {
      session.closed_at ??= now;
      return json(409, { detail: "This session is closed; start a new one" });
    }
  } else if (applies) session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
  if (TARGETS[body.op]) return createTarget(db, ctx, body, session);
  // fix4 qa-simple-roadmap-9: as the API (changes.create reads through drafts.overlays_for), the
  // stale check and a fix's plan read the items as the caller reads them: a commenter who may
  // not see the working draft is checked against the published items their roadmap shows.
  const seen = readerDb(db, ctx);
  if (!seen.items.some((s) => s.key === key)) return json(404, { detail: "No such roadmap item" });
  let before: Values;
  let after: Values;
  if (FIXES.includes(body.op)) {
    const dep = String(target.subject ?? "");
    const deps = roadmapOut(seen, "owner", new URLSearchParams())!.items.find((i) => i.id === target.item_id)?.depends_on ?? [];
    if (!deps.includes(dep)) return json(422, { detail: "target.subject: an item the target depends on" });
    const stale: Values = {};
    for (const id of [String(target.item_id), dep]) {
      const given = body.before[id] as Values | undefined;
      if (!given || !("start_date" in given) || !("end_date" in given)) return json(422, { detail: `before.${id}: start_date and end_date as seen` });
      const now_ = read(seen, keyOf(db, id)!, ["start_date", "end_date"], target);
      if (!same(normal(["start_date", "end_date"], given), now_)) stale[id] = now_;
    }
    if (Object.keys(stale).length) return conflict(db, ctx, stale, Object.keys(stale), "Changed since you saw it");
    const moves = fixPlan(seen, body.op, String(target.item_id), dep);
    // roadmap-decide: the draft's change list names the item, then what else moved.
    const titleOf = (id: string) => seed(seen, keyOf(db, id)!).title;
    target.titles = [titleOf(String(target.item_id)), ...Object.keys(moves).filter((id) => id !== target.item_id).map(titleOf)];
    before = Object.fromEntries(Object.keys(moves).map((id) => [id, read(seen, keyOf(db, id)!, ["start_date", "end_date", "date_source"], target)]));
    after = Object.fromEntries(Object.entries(moves).map(([id, [s, e]]) => [id, { start_date: s, end_date: e, date_source: "typed" }]));
  } else if (body.op === CUT_ALL) {
    // As a cut: before is the item's own {cut} as seen; keyed by item id, the item and its dependents.
    if (!("cut" in body.before)) return json(422, { detail: "before: cut as you saw it" });
    const now_ = read(seen, key, ["cut"], target);
    if (!same(normal(["cut"], body.before), now_)) return conflict(db, ctx, now_, [String(target.item_id)], "Changed since you saw it");
    const items = roadmapOut(seen, "owner", new URLSearchParams())!.items;
    const deps = cutDependents(items, String(target.item_id));
    if (!deps.length) return json(422, { detail: "No item depends on this one: cut it alone" });
    // Review minor: the dependents the caller saw; others waiting on it now are refused.
    const saw = body.before.dependents;
    const now_ids = deps.map((i) => i.id);
    if (Array.isArray(saw) && [...saw].map(String).sort().join() !== [...now_ids].sort().join()) return conflict(db, ctx, { dependents: now_ids }, now_ids, "Changed since you saw it");
    const cut = [items.find((i) => i.id === target.item_id)!, ...deps];
    target.titles = cut.map((i) => i.title);
    before = Object.fromEntries(cut.map((i) => [i.id, read(seen, keyOf(db, i.id)!, ["cut"], target)]));
    after = Object.fromEntries(cut.map((i) => [i.id, { cut: true }]));
  } else {
    const fields = FIELDS[body.op];
    // roadmap-decide review (changes.py): the page may not see every stored key; only the subject is checked.
    if (body.op === "remove_dependency") body.before = read(seen, key, fields, target);
    const missing = fields.filter((f) => !(f in body.before));
    if (missing.length) return json(422, { detail: `before: ${missing.join(", ")} as you saw them` });
    const now_ = read(seen, key, fields, target);
    // A suggestion accepted after the item got dates is "outdated" (S2-minor).
    const lead = body.op === "accept_date_suggestion" ? "outdated" : "Changed since you saw it";
    const seenNow = normal(fields, body.before);
    if (body.op === "move_dates" && !same(seenNow, now_)) {
      // hotfix-2 (changes._plan): a move's before is the dates the read shows; the stored ones still pass.
      const r = readDates(seen, key);
      const shown = { start_date: r.start, end_date: r.end };
      if (!same(seenNow, shown)) return conflict(db, ctx, shown, [String(target.item_id)], lead);
    } else if (body.op === "change_horizon") {
      // board-quarters (changes.py SHOWN): before is the column the read shows, from the dates.
      const shown = { horizon: readColumn(seen, key).horizon };
      if (!same(seenNow, shown)) return conflict(db, ctx, shown, [String(target.item_id)], lead);
    } else if (body.op === "edit_title" && !same(seenNow, now_)) {
      // roadmap-edit-fixes: the read shows a title's code apart from its name.
      const s = seed(seen, key);
      if (!same(seenNow, { title: codedTitle(s.title, prdCode(s.section))[1] })) return conflict(db, ctx, now_, [String(target.item_id)], lead);
    } else if (!same(seenNow, now_)) return conflict(db, ctx, now_, [String(target.item_id)], lead);
    const a = body.after ?? {};
    let stored = fields;
    if (body.op === "move_dates") {
      if (!a.start_date || !a.end_date || String(a.end_date) < String(a.start_date)) return json(422, { detail: "after: start_date and end_date, the end not before the start" });
      after = { start_date: a.start_date, end_date: a.end_date, date_source: "typed" };
      stored = ["start_date", "end_date", "date_source"];
    } else if (body.op === "accept_date_suggestion") {
      const s = db.suggestions.find((x) => x.id === target.suggestion_id && x.item_id === target.item_id);
      if (!s) return json(404, { detail: "No such date suggestion on this item" });
      if (s.status !== "open") return json(409, { detail: `This suggestion is ${s.status} already` });
      let [start, end] = [s.start_date, s.end_date];
      if (s.slice_code != null)
        // plan-model: a slice's dates: the item takes the span of all its open slices.
        for (const o of db.suggestions.filter((x) => x.item_id === s.item_id && x.status === "open")) {
          if (o.start_date < start) start = o.start_date;
          if (o.end_date > end) end = o.end_date;
        }
      after = { start_date: start, end_date: end, date_source: "accepted" };
      if (a.start_date != null || a.end_date != null) {
        // The edit variant (D-b): the person's dates.
        if (!a.start_date || !a.end_date || String(a.end_date) < String(a.start_date)) return json(422, { detail: "after: start_date and end_date, the end not before the start" });
        after = { start_date: a.start_date, end_date: a.end_date, date_source: "accepted" };
        target.edited = true;
      }
      stored = ["start_date", "end_date", "date_source"];
    } else if (body.op === "change_horizon") {
      if (!["now", "next", "later"].includes(String(a.horizon))) return json(422, { detail: "after.horizon: now, next or later" });
      // board-quarters (changes.py): the shown dates move by whole quarters into the new
      // column, length kept, typed; an undated item takes the quarter; horizon is history.
      const r = readColumn(seen, key);
      const [start, end] = shiftToQuarter(r.undated ? null : r.start, r.undated ? null : r.end, a.horizon as "now" | "next" | "later", quarterWindows(companyToday()));
      after = { horizon: a.horizon, start_date: start, end_date: end, date_source: "typed" };
      stored = ["horizon", "start_date", "end_date", "date_source"];
    } else if (body.op === "reorder") after = { position: Number(a.position) };
    else if (body.op === "cut" || body.op === "restore") after = { cut: body.op === "cut" };
    else if (body.op === "remove_dependency") {
      const depKey = keyOf(db, String(target.subject ?? ""));
      const own = seed(seen, key);
      if (!depKey || !(own.depends ?? []).includes(depKey)) return json(422, { detail: "target.subject: an item the target depends on" });
      target.titles = [own.title, seed(seen, depKey).title];
      after = { depends_on: (own.depends ?? []).filter((k) => k !== depKey) };
    } else if (body.op === "confirm_item") {
      if (!seed(seen, key).draft) return json(422, { detail: "Only a draft item is confirmed" });
      after = { draft: false };
    }
    else if (body.op === "edit_title") {
      let title = String(a.title ?? "").trim();
      if (!title || title.length > TITLE_MAX) return json(422, { detail: `after.title: 1 to ${TITLE_MAX} characters` });
      // roadmap-edit-fixes: a rename changes the name only; a code the title carries stays.
      const s = seed(seen, key);
      const [code, name] = codedTitle(s.title, prdCode(s.section));
      if (code && name !== s.title && !codedTitle(title, null)[0]) {
        // changes._with_code: the name is never cut.
        const room = TITLE_MAX - code.length - 1;
        if (title.length > room) return json(422, { detail: `The name is too long to carry the code ${code}: shorten it to ${room} characters first` });
        title = `${code} ${title}`;
      }
      // changes._title_code: a code the new title leads with is checked as set_code checks it.
      const taken = titleCodeTaken(db, seen, key, title);
      if (taken) return json(422, { detail: taken });
      after = { title };
    } else if (body.op === "edit_outcome") after = { outcome: a.outcome ?? null };
    else if (body.op === "edit_note") {
      const note = a.note == null ? null : String(a.note).trim();
      if (note && note.length > 500) return json(422, { detail: "after.note: at most 500 characters" });
      after = { note: note || null };
    }
    else if (body.op === "set_confidence") {
      if (a.confidence != null && !["low", "medium", "high"].includes(String(a.confidence))) return json(422, { detail: "after.confidence: low, medium, high or null" });
      after = { confidence: a.confidence ?? null };
    } else if (body.op === "set_feature") {
      // The route checks it names a feature (server.ts), as changes.py's set_feature.
      after = { feature_id: a.feature_id ?? null };
    } else if (body.op === "set_track" || body.op === "set_prd" || body.op === "set_goal") {
      const f = fields[0];
      const v = a[f] ?? null;
      const known = (x: (typeof seen.items)[number]) => read(seen, x.key, [f], target)[f];
      if (v !== null && !seen.items.some((x) => known(x) === v) && !(f === "track_id" && Object.keys(TRACKS).some((k) => stableUuid(`simple-track/${k}`) === v)) && !(f === "goal_id" && (Object.keys(GOALS).some((k) => goalId(k) === v && !goalInTrash(seen, k)) || !!mapGoalRef(seen, String(v))))) return json(422, { detail: `after.${f}: ${{ track_id: "a product track", prd_document_id: "a PRD", goal_id: "a goal" }[f]}` });
      after = { [f]: v };
      // roadmap-edit-fixes (changes._track_of_prd): a track is one PRD's, so it follows the PRD.
      const track = f === "prd_document_id" && v ? seen.items.find((x) => ownPrd(x).id === v && x.track)?.track : undefined;
      if (track && track !== seed(seen, key).track) {
        after.track_id = stableUuid(`simple-track/${track}`);
        stored = ["prd_document_id", "track_id"];
      }
    } else if (body.op === "set_depends") {
      const keys = a.depends_on;
      if (!Array.isArray(keys) || keys.length > 50) return json(422, { detail: "after.depends_on: a list of at most 50 keys" });
      let clean = [...new Set(keys.map((k) => String(k ?? "").trim()))];
      // roadmap-edit-fixes round 1 (changes._plan): a removed key's item goes, by every key that names it.
      const stored = seed(seen, key).depends ?? [];
      const target = (k: string) => dependencyOf(seen.items, k)?.key;
      const gone = new Set(stored.filter((k) => !clean.includes(k)).map(target).filter((k) => !!k));
      clean = clean.filter((k) => !(stored.includes(k) && gone.has(target(k))));
      if (clean.some((k) => !k) || clean.includes(key)) return json(422, { detail: "after.depends_on: item or feature keys, never the item's own" });
      // changes._unknown_keys: a new key names an item (its key or code) or a feature.
      const names = new Set(seen.items.flatMap((x) => [x.key, prdCode(x.section), codedTitle(x.title, prdCode(x.section))[0], x.feature_key]).filter((k): k is string => !!k).map((k) => k.toLowerCase()));
      const unknown = clean.find((k) => !(seen.items.find((x) => x.key === key)?.depends ?? []).includes(k) && !names.has(k.toLowerCase()));
      if (unknown) return json(422, { detail: `after.depends_on: no item or feature has the key ${unknown}` });
      // roadmap-edit-fixes (changes.loop_of): never a loop.
      const have = seed(seen, key).depends ?? [];
      const loop = loopOf(seen.items, key, clean.filter((k) => !have.includes(k)));
      if (loop) return json(422, { detail: loop });
      after = { depends_on: clean };
    } else if (body.op === "set_status") {
      if (!["planned", "done", "cut"].includes(String(a.status))) return json(422, { detail: "after.status: planned, done or cut" });
      after = statusAfter(seed(seen, key), String(a.status), ctx.id);
      stored = ["cut", "shipped"];
    } else if (body.op === "set_code") {
      // changes._free_code: a feature code no other item or Ground Truth feature has; the title carries it.
      const s = seed(seen, key);
      if ((s.feature_id && db.feature_codes?.[s.feature_id]) || prdCode(s.section)) return json(422, { detail: "Its code comes from its Ground Truth feature or its PRD" });
      const code = a.code == null || !String(a.code).trim() ? null : String(a.code).trim().toUpperCase();
      if (code && !/^[A-Z]{1,3}-\d+[a-j]?$/.test(code)) return json(422, { detail: "after.code: a feature code, like F-31" });
      const taken = code ? codeTaken(db, seen, key, code) : null;
      if (taken) return json(422, { detail: taken });
      const name = codedTitle(s.title, prdCode(s.section))[1];
      // changes._with_code: the name is never cut.
      const room = TITLE_MAX - (code?.length ?? 0) - 1;
      if (code && name.length > room) return json(422, { detail: `The name is too long to carry the code ${code}: shorten it to ${room} characters first` });
      target.code = code;
      after = { title: code ? `${code} ${name}` : name };
      stored = ["title"];
    } else if (body.op === "set_parent") {
      const v = a.parent_key == null ? null : String(a.parent_key);
      const me = seed(seen, key);
      const refused = parentRefusal(seen, key, v);
      if (refused) return json(422, { detail: refused });
      const parent = v === null ? undefined : seen.items.find((x) => x.key === v && !x.trashed);
      const named = parent ?? (me.parent ? seen.items.find((x) => x.key === me.parent) : undefined);
      if (named) Object.assign(target, { code: prdCode(named.section) ?? "", title: named.title });
      after = { parent_key: v };
    }
    else if (body.op === "set_goals") {
      // A goal by its id: the roadmap's, or the goal buckets' of the same name (as add_item reads it).
      const raw = Array.isArray(a.goal_ids) ? (a.goal_ids as unknown[]).map(String) : [];
      const keys = raw.map((v) => {
        const bucket = db.goal_buckets?.goals.find((g) => g.id === v)?.title;
        return Object.keys(GOALS).find((k) => goalId(k) === v || (!!bucket && GOALS[k] === bucket));
      });
      if (!raw.length) return json(422, { detail: "after.goal_ids: one goal or more" });
      if (keys.some((k) => !k)) return json(422, { detail: "after.goal_ids: goals of this company" });
      after = { goal_ids: [...new Set(keys.map((k) => goalId(k!)))] };
    } else {
      const note = String((a.risk as Values | undefined)?.note ?? "").trim();
      if (!note) return json(422, { detail: "after.risk.note: 1 to 500 characters" });
      target.subject = target.subject ?? null;
      after = { risk: { flag: target.flag, subject: target.subject, note, by: ctx.id, at: now } };
    }
    before = read(seen, key, stored, target);
  }
  const change: Change = {
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: stableUuid(`simple-doc/${seed(db, key).roadmap}`), draft_ids: [], op: body.op, target, before, after,
    status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (!applies) change.routed_to = route(db, ctx, change);
  let flags: Schemas["SimpleItemFlags"][];
  if (applies) {
    const drafts = intoDrafts(db, change, session!);
    if (drafts instanceof Response) return drafts;
    change.draft_ids = drafts;
    apply(db, change, after);
    flags = flagsFor(db, touched(change));
    session!.last_change_at = now;
  } else {
    // As if applied: on a copy of the roadmap.
    const copy = structuredClone({ items: db.items, own: db.own, suggestions: db.suggestions, goal_buckets: db.goal_buckets });
    apply(db, change, after);
    flags = flagsFor(db, touched(change));
    Object.assign(db, copy);
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags });
}

/** /v1/simple/sessions and /v1/simple/changes (api/oracle/simple/changes_router.py). */
export async function routeSimpleChanges(db: SimpleDb, ctx: SimpleChangesCtx, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "simple" || !["sessions", "changes", "drafts", "roadmap", "priorities", "goal-suggestions", "goals"].includes(p[2] ?? "")) return null;
  const m = req.method;
  settleDrafting(db);
  if (p[2] === "goal-suggestions" || p[2] === "goals") {
    if (m === "POST" && ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
    return routeGoalSuggestions(db, ctx, req, p, q, (body) => create(db, ctx, body));
  }
  if (p[2] === "priorities") {
    if (p[3] === "twins" && p[4] && p[5] === "merge" && !p[6] && m === "POST") return mergeTwin(db, ctx, p[4], (await req.json()) as { into: string });
    if (m !== "GET" || p[3]) return null;
    return json(200, prioritiesOut(db, ctx, (c) => route(db, ctx, c), (itemId) => decides(db, ctx, itemId), q.get("line")));
  }
  const now = iso(mockNowMs());
  // trash-features-goals: DELETE .../roadmap/items/{id} and its restore (oracle.simple.trash_items).
  if (p[2] === "roadmap" && p[3] === "items" && p[4] && !p[5] && m === "DELETE") {
    if (ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
    return deleteItemRoute(db, ctx, p[4], q.get("reason"));
  }
  if (p[2] === "roadmap" && p[3] === "items" && p[4] && p[5] === "restore" && m === "POST") return restoreItemRoute(db, ctx, p[4]);
  const accepting = p[2] === "roadmap" && p[3] === "date-suggestions" && m === "POST" && ["accept", "edit"].includes(p[5] ?? "");
  if (p[2] === "roadmap" && !accepting) return null;
  if (m === "POST" && ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
  if (accepting) {
    // D-b: accept and edit are an accept_date_suggestion change (suggestions.accept).
    const s = db.suggestions.find((x) => x.id === p[4]);
    if (!s) return json(404, { detail: "No such date suggestion" });
    const dates = p[5] === "edit" ? ((await req.json().catch(() => ({}))) as Values) : {};
    if (p[5] === "edit" && (!dates.start_date || !dates.end_date)) return json(422, { detail: "start_date and end_date" });
    const res = await create(db, ctx, {
      op: "accept_date_suggestion", target: { item_id: s.item_id, suggestion_id: s.id },
      before: { start_date: null, end_date: null }, after: p[5] === "edit" ? { start_date: dates.start_date, end_date: dates.end_date } : {},
    } as Schemas["SimpleChangeIn"]);
    return res.status === 201 ? new Response(res.body, { status: 200, headers: res.headers }) : res;
  }
  if (p[2] === "drafts") return routeDrafts(db, ctx, m, p, q);
  if (p[2] === "sessions") {
    if (!p[3] && m === "POST") {
      const body = (await req.json().catch(() => ({}))) as { kind?: Session["kind"] };
      const kind = body.kind ?? "editing";
      return json(200, (kind === "editing" && openEditing(db, ctx.id)) || newSession(db, ctx.id, kind));
    }
    if (p[3] === "current" && m === "GET") return json(200, openEditing(db, ctx.id) ?? null);
    if (p[4] === "close" && m === "POST") {
      const s = (db.sessions ?? []).find((x) => x.id === p[3]);
      if (!s) return json(404, { detail: "No such session" });
      if (s.started_by !== ctx.id) return json(403, { detail: "Only the person who started a session closes it" });
      s.closed_at ??= now;
      return json(200, s);
    }
    return null;
  }
  if (!p[3] && m === "POST") return create(db, ctx, (await req.json()) as Schemas["SimpleChangeIn"]);
  if (!p[3] && m === "GET") {
    const status = q.get("status");
    const rows = madeOrder(db.changes ?? [], (c) => [c.at], true)
      .filter((c) => (!q.get("session") || c.session_id === q.get("session")) && (!q.get("document") || c.document_id === q.get("document")) && (!status || c.status === status) && (q.get("mine") !== "true" || c.by === ctx.id))
      .filter((c) => sees(db, ctx, c) && !onReplacedPrd(db, c));
    return json(200, rows.map((c) => view(db, ctx, c)));
  }
  const c = (db.changes ?? []).find((x) => x.id === p[3]);
  if (m !== "POST" || !["undo", "accept", "decline", "withdraw"].includes(p[4] ?? "")) return null;
  if (!c) return json(404, { detail: "No such change" });
  // qa-simple-plan-30: the proposer takes it back (changes.py `withdraw`): closed as declined.
  if (p[4] === "withdraw") {
    if (c.by !== ctx.id) return json(403, { detail: "Only the person who proposed it withdraws it" });
    if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
    if (c.op === "add_item" || c.op === MILESTONE_OP) return json(409, { detail: "This kind of proposal is not withdrawn here" });
    Object.assign(c, { status: "declined", decided_by: ctx.id, decided_at: now, decision_reason: "Withdrawn by the person who proposed it" });
    return json(200, { change: view(db, ctx, c), flags: [] });
  }
  if (p[4] === "undo") {
    if (c.status !== "applied") return json(409, { detail: `Only an applied change undoes; this one is ${c.status}` });
    if (c.by !== ctx.id) return json(403, { detail: "Only the person who made a change undoes it" });
    if ((db.changes ?? []).some((x) => x.undoes_id === c.id)) return json(409, { detail: "This change is undone already" });
    const s = (db.sessions ?? []).find((x) => x.id === c.session_id);
    if (!s || s.closed_at || idle(s)) return json(409, { detail: "Its session is closed: undo works only in the change's session" });
    if (c.op === "set_goal_measure" && !same(goalMeasure(db, c.target.goal_id), c.after)) return conflict(db, ctx, goalMeasure(db, c.target.goal_id)!, [String(c.target.goal_id)], "Changed since");
    let undone: { before: Values; after: Values } | undefined;
    // As changes.undo: the milestone put back is checked as a pick is (it may be in Trash since).
    const backMs = c.op === "set_milestone" ? (c.before.milestone as Values | null | undefined) : undefined;
    const gone = backMs && typeof backMs === "object" && backMs.id ? pickRefused(db, c.target.item_id, backMs.id) : null;
    if (gone) return json(422, { detail: gone });
    if (TARGETS[c.op]) writeTarget(db, c, c.before, true, ctx);
    else if (KEY_DATE_OPS.includes(c.op)) {
      const rm = roadmapOfDoc(db, c.target.document_id)!;
      if (!same(kdValue(keyDateNow(db, ctx, rm, String(c.target.key_date_id))), c.after.key_date ?? null)) return json(409, { detail: "Changed since" });
      const drafts = intoDrafts(db, c, s, true);
      if (drafts instanceof Response) return drafts;
      writeKeyDate(db, c, c.before.key_date);
    }
    else if (S7_OPS.includes(c.op)) {
      if (!holdsS7(db, c)) return conflict(db, ctx, {}, touched(c), "Changed since");
      const drafts = intoDrafts(db, anchored(db, c), s, true);
      if (drafts instanceof Response) return drafts;
      applyS7(db, c, true);
    } else if (c.op === "set_depends") {
      // ask-oracle-actions (changes._depends_back): only the keys the change added or removed
      // go back; the item's other dependencies stay as they are now.
      const now_ = current(db, c, c.after);
      const back = dependsBack(now_, c.before, c.after);
      if (!back) return conflict(db, ctx, now_, touched(c), "Changed since");
      const drafts = intoDrafts(db, c, s, true);
      if (drafts instanceof Response) return drafts;
      apply(db, c, back, true);
      undone = { before: now_, after: back };
    } else {
      const now_ = current(db, c, c.after);
      if (!same(now_, c.after)) return conflict(db, ctx, now_, touched(c), "Changed since");
      // As changes.undo: the old parent written back is checked as create checks it.
      const refused = c.op === "set_parent" ? parentRefusal(readerDb(db, ctx), keyOf(db, c.target.item_id)!, (c.before.parent_key as string | null) ?? null) : null;
      if (refused) return json(422, { detail: refused });
      // As changes.undo: the code the old title carries may be another item's or a feature's since.
      const taken = (c.op === "set_code" || c.op === "edit_title") && c.before.title ? titleCodeTaken(db, readerDb(db, ctx), keyOf(db, c.target.item_id)!, String(c.before.title)) : null;
      if (taken) return json(409, { detail: taken });
      const drafts = intoDrafts(db, c, s, true);
      if (drafts instanceof Response) return drafts;
      apply(db, c, c.before, true);
    }
    const u: Change = { ...c, id: crypto.randomUUID(), before: undone?.before ?? c.after, after: undone?.after ?? c.before, status: "undone", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now, undoes_id: c.id, routed_to: [], decided_by: null, decided_at: null };
    db.changes!.push(u);
    s.last_change_at = now;
    return json(201, { change: view(db, ctx, u), flags: TARGETS[c.op] || KEY_DATE_OPS.includes(c.op) ? [] : flagsFor(db, touched(c)) });
  }
  if (!decidesChange(db, ctx, c)) return json(403, { detail: "Only an owner or the roadmap's decider (with no decider, its owner) decides proposals" });
  if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
  const body = (await req.json().catch(() => ({}))) as { reason?: string | null };
  if (p[4] === "accept" && c.op === "set_goal_measure" && !same(goalMeasure(db, c.target.goal_id), c.before)) return conflict(db, ctx, goalMeasure(db, c.target.goal_id)!, [String(c.target.goal_id)], "outdated");
  // item-milestone: a proposed pick's milestone may be deleted since (changes.decide checks it again).
  const pickedOnAccept = p[4] === "accept" && c.op === "set_milestone" ? (c.after?.milestone as Values | null | undefined) : undefined;
  const refusedOnAccept = pickedOnAccept?.id ? pickRefused(db, c.target.item_id, pickedOnAccept.id) : null;
  if (refusedOnAccept) return json(422, { detail: refusedOnAccept });
  if (p[4] === "accept" && TARGETS[c.op]) writeTarget(db, c, c.after, false, ctx);
  // goal_milestones.decide: a milestone card's change (before.milestone); a change asked of a
  // PRD's milestone (before.date) is decided below.
  else if (p[4] === "accept" && c.op === MILESTONE_OP && "milestone" in (c.before ?? {})) {
    const ms = (db.goal_milestones ?? []).find((x) => x.id === c.target.milestone_id && !x.deleted);
    const kr = ms ? null : ctx.ladder?.find(String(c.target.milestone_id));
    // milestone-rename: a goal's own milestone takes the name asked.
    const gt = ms || kr || !c.target.goal_target ? null : goalTargetOf(db, c.target.milestone_id);
    if (gt) {
      const before = (c.before.milestone as Values).name;
      if (gt.goal.name !== before) return json(409, { detail: { message: "outdated: the milestone changed since the proposal", current: { milestone: { name: gt.goal.name } }, changed_by: null, changed_at: null } });
      setTargetName(db, gt.goal, String((c.after.milestone as Values).name));
    } else if (kr) {
      // every-field-editable: a Goal ladder key result's new goal (milestone-rename: its name and date too).
      if (!same(kr.value, c.before.milestone)) return json(409, { detail: { message: "outdated: the milestone changed since the proposal", current: { milestone: kr.value }, changed_by: null, changed_at: null } });
      const after = c.after.milestone as Record<string, unknown> | null;
      ctx.ladder!.write(String(c.target.milestone_id), after);
    } else if (c.target.goal_target || !ms) return json(404, { detail: "The milestone is gone" });
    else {
    if (!same(milestoneValue(ms, db.ids), c.before.milestone)) return json(409, { detail: { message: "outdated: the milestone changed since the proposal", current: { milestone: milestoneValue(ms, db.ids) }, changed_by: null, changed_at: null } });
    writeMilestone(ms, db.ids, c.after.milestone as Record<string, unknown> | null);
    }
  }
  else if (p[4] === "accept" && KEY_DATE_OPS.includes(c.op)) {
    const rm = roadmapOfDoc(db, c.target.document_id)!;
    if (!same(kdValue(keyDateNow(db, ctx, rm, String(c.target.key_date_id))), c.before.key_date ?? null)) return json(409, { detail: "outdated: the key date changed since the proposal" });
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    const drafts = intoDrafts(db, c, session);
    if (drafts instanceof Response) return drafts;
    c.draft_ids = drafts;
    session.last_change_at = now;
    writeKeyDate(db, c, c.after.key_date);
  } else if (p[4] === "accept" && S7_OPS.includes(c.op)) {
    if (!validS7(db, c)) return json(409, { detail: "outdated: the items changed since it was proposed" });
    // As additions.decide: a code its title carries that another item or a feature took since; the proposal stays open, to decline.
    const taken = c.op === "add_item" ? titleCodeTaken(db, readerDb(db, ctx), null, String(c.after.title ?? "")) : null;
    if (taken) return json(409, { detail: taken });
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    const drafts = intoDrafts(db, anchored(db, c), session);
    if (drafts instanceof Response) return drafts;
    c.draft_ids = drafts;
    session.last_change_at = now;
    applyS7(db, c);
  } else if (c.op === "edit_goal_milestone") {
    // roadmap-decide: accepting writes the PRD milestone's date and rule; either way it waits no more.
    // As goal_milestones.decide: one whose milestone is gone (or in the Trash) or waits on another
    // change is only declined (the milestone left as it is); accepting it is refused.
    const m = (db.goal_milestones ?? []).find((x) => x.id === c.target.milestone_id);
    const waits = !!m && m.pending?.change_id === c.id;
    if (p[4] === "accept" && (!m || m.deleted)) return json(404, { detail: "The milestone is gone" });
    if (p[4] === "accept" && !waits) return json(409, { detail: { message: "This proposal no longer waits on this milestone", current: null, changed_by: null, changed_at: null } });
    if (m && p[4] === "accept") Object.assign(m, { date: (c.after.date as string | null) ?? m.date, counts_when: (c.after.counts_when as string | null) ?? m.counts_when });
    // milestone-rename (goal_milestones._apply_prd): an asked name too.
    if (m && p[4] === "accept" && typeof c.after.name === "string" && c.after.name.trim()) m.name = c.after.name.trim();
    if (m && waits) m.pending = null;
  } else if (p[4] === "decline" && c.op === "add_item") reopenSuggestion(db, c);
  else if (p[4] === "accept" && (c.op === "add_track" || c.op === "edit_track")) {
    // tracks-goal (owner Nov 9): a proposed track change, applied already by ./simple-removed.ts (only its PRD).
  }
  else if (p[4] === "accept" && c.op === "merge_twin") {
    // twin_merges.decide: the same merge_twin, as the decider (its 409 and 422, nothing written).
    const r = await mergeTwin(db, ctx, String(c.target.feature_id), { into: String(c.target.into_id) });
    if (r.status >= 300) return r;
  } else if (p[4] === "accept" && GOAL_ASK_OPS.includes(c.op)) {
    const err = applyGoalAsk(db, ctx, c);
    if (err) return err;
  } else if (p[4] === "accept" && c.op === MAP_LINK_OP) {
    const err = applyMapLink(ctx, c);
    if (err) return err;
  } else if (p[4] === "accept" && c.op === "delete_item") {
    const key = keyOf(db, c.target.item_id);
    if (!key) return json(404, { detail: "The feature is gone" });
    if (seed(db, key).trashed) return alreadyInTrash(db, ctx, c, now);
    trashFeature(db, ctx, key, c.reason ?? null, now);
  } else if (p[4] === "accept" && c.op === "delete_goal") {
    const gb = goalBucketsDb(db, ctx.goalBin?.people);
    const g = gb.goals.find((x) => x.id === c.target.goal_id);
    if (!g) return json(404, { detail: "The goal is gone" });
    if (g.trashed) return alreadyInTrash(db, ctx, c, now);
    const to = typeof c.target.to_goal_id === "string" ? c.target.to_goal_id : null;
    const bin = { trash: (ctx.trash ??= { entries: [], estimates: {} }), id: ctx.id, name: ctx.names[ctx.id] ?? null, now: () => now };
    trashGoal(gb, bin, g.id, to, c.reason ?? null, db);
  } else if (p[4] === "accept") {
    const now_ = current(db, c, c.before);
    if (!same(now_, c.before)) return conflict(db, ctx, now_, touched(c), "outdated");
    // As changes.decide: a proposed parent is checked again, as create checks it.
    const refused = c.op === "set_parent" ? parentRefusal(readerDb(db, ctx), keyOf(db, c.target.item_id)!, (c.after.parent_key as string | null) ?? null) : null;
    if (refused) return json(422, { detail: refused });
    // As changes.decide: a code another item or a Ground Truth feature took since is refused;
    // the proposal stays open, to decline.
    const taken = c.op === "set_code" && c.target.code ? codeTaken(db, readerDb(db, ctx), keyOf(db, c.target.item_id)!, String(c.target.code)) : null;
    if (taken) return json(409, { detail: taken });
    const renamed = c.op === "edit_title" ? titleCodeTaken(db, readerDb(db, ctx), keyOf(db, c.target.item_id)!, String(c.after.title ?? "")) : null;
    if (renamed) return json(409, { detail: renamed });
    // Into the decider's working draft (their editing session's).
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    const drafts = intoDrafts(db, c, session);
    if (drafts instanceof Response) return drafts;
    c.draft_ids = drafts;
    session.last_change_at = now;
    apply(db, c, c.after);
  }
  Object.assign(c, { status: p[4] === "accept" ? "accepted" : "declined", decided_by: ctx.id, decided_at: now, decision_reason: body.reason ?? null });
  return json(200, { change: view(db, ctx, c), flags: TARGETS[c.op] || KEY_DATE_OPS.includes(c.op) || c.op === MAP_LINK_OP ? [] : flagsFor(db, touched(c)) });
}

/** changes._free_code: who already has ``code`` (another item of the roadmap or a Ground Truth feature), in plain words; null when it is free. */
function codeTaken(db: SimpleDb, seen: SimpleDb, key: string, code: string): string | null {
  const other = seen.items.find((x) => x.key !== key && !x.trashed && String(read(seen, x.key, ["code"], {}).code ?? "").toUpperCase() === code);
  if (other) return `${code} is already the code of ${shownName(other, (id) => seen.feature_codes?.[id])}`;
  if (Object.values(db.feature_codes ?? {}).some((k) => k.toUpperCase() === code)) return `${code} is already the code of a Ground Truth feature`;
  return null;
}

/** changes._title_code: a title leading with a code other than the item's own ("F-31 Alerts", any code the read takes from a title) gives the item that code, checked as set_code checks it; an item coded by its feature or PRD keeps that one. ``key`` null: an item being added. */
function titleCodeTaken(db: SimpleDb, seen: SimpleDb, key: string | null, title: string): string | null {
  const s = key ? seed(seen, key) : null;
  if (s && ((s.feature_id && db.feature_codes?.[s.feature_id]) || prdCode(s.section))) return null;
  const lead = codedTitle(title, null)[0];
  if (!lead || (s && lead === codedTitle(s.title, null)[0])) return null;
  return codeTaken(db, seen, key ?? "", lead);
}

/** changes._merge_plan: another item showing ``code`` as its own (its title's, not its feature's or PRD's), in set_code's words; ``seen``: the items the reader reads. */
function ownCodeTaken(seen: SimpleDb, key: string, code: string): string | null {
  const other = seen.items.find((x) => x.key !== key && !x.trashed && !(x.feature_id && seen.feature_codes?.[x.feature_id]) && !prdCode(x.section) && codedTitle(x.title, null)[0]?.toUpperCase() === code.toUpperCase());
  return other ? `${code} is already the code of ${code} ${codedTitle(other.title, null)[1]}` : null;
}

/** A proposal whose feature or goal went to Trash meanwhile: closed, not left open. */
function alreadyInTrash(db: SimpleDb, ctx: SimpleChangesCtx, c: Change, now: string): Response {
  Object.assign(c, { status: "declined", decided_by: ctx.id, decided_at: now, decision_reason: ALREADY });
  return json(200, { change: view(db, ctx, c), flags: [] });
}

/**
 * A proposal made before the page opened (S1 Home's "simple-home" scenario): `by` proposes
 * `op` on `itemKey`, routed as the engine routes it.
 */
export function seedSimpleProposal(
  db: SimpleDb,
  who: Pick<SimpleChangesCtx, "owners" | "roles"> & { id: string; name: string },
  op: Change["op"],
  itemKey: string,
  before: Values,
  after: Values,
  at: string,
  reason: string | null = null,
): void {
  const c: Change = {
    id: stableUuid(`simple-proposal/${itemKey}/${op}/${who.id}`), session_id: null, document_id: stableUuid(`simple-doc/${seed(db, itemKey).roadmap}`), draft_ids: [],
    op, target: { item_id: db.ids[itemKey] }, before, after, status: "proposed", by: who.id, by_name: who.name, at,
    decided_by: null, decided_at: null, reason, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  c.routed_to = route(db, who, c);
  (db.changes ??= []).push(c);
}

/**
 * inbox-meeting-proposals fix: a feature ask proposed by a teammate, on no roadmap (its
 * document_id null), waiting on the company's owners; decided in its Inbox row and, accepted, filed in Requests.
 */
export function seedFeatureAskProposal(db: SimpleDb, who: Pick<SimpleChangesCtx, "owners"> & { id: string; name: string }, title: string, at: string): void {
  (db.changes ??= []).push({
    id: stableUuid(`simple-proposal/ask/${title}`), session_id: null, document_id: null, draft_ids: [],
    op: "add_feature_ask", target: { request_id: stableUuid(`simple-ask/${title}`) }, before: {}, after: { title, requester_name: null, requester_kind: "unknown", channel: "other" }, status: "proposed", by: who.id, by_name: who.name, at,
    decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: [...who.owners], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  });
}

/**
 * meeting-changes-only-its-agenda (changes.create): a change a meeting makes to an item it does
 * not review is never applied: a proposal for the item's own decider (never the meeting's),
 * naming the meeting that asked for it.
 */
export function proposeOffAgenda(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"], meeting: { id: string; title: string }, sessionId: string): Schemas["SimpleChangeResult"] | Response {
  const key = keyOf(db, body.target.item_id);
  if (!key) return json(404, { detail: "No such roadmap item" });
  const fields = FIELDS[body.op] ?? Object.keys(body.after ?? {});
  const after = body.op === "cut" ? { cut: true } : body.op === "restore" ? { cut: false } : body.op === "set_status" ? statusAfter(seed(db, key), String(body.after?.status), ctx.id) : { ...(body.after ?? {}) };
  const c: Change = {
    id: crypto.randomUUID(), session_id: sessionId, document_id: stableUuid(`simple-doc/${seed(db, key).roadmap}`), draft_ids: [],
    op: body.op, target: { ...body.target }, before: body.op === "set_status" ? read(db, key, ["cut", "shipped"], body.target) : (body.before ?? read(db, key, fields, body.target)), after, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
    from_meeting: meeting, off_agenda: true,
  };
  c.routed_to = route(db, ctx, c);
  (db.changes ??= []).push(c);
  return { change: view(db, ctx, c), flags: [] };
}

/** A title in curly quotes, as change_words._quoted; null when blank. */
function quotedTitle(value: unknown, limit = 80): string | null {
  const text = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  return text ? `“${text.slice(0, limit)}${text.length > limit ? "…" : ""}”` : null;
}

/** Inbox rows (changes.inbox_rows): proposals waiting for me, decisions on mine. */
export function simpleInboxRows(
  db: SimpleDb | undefined,
  me: string,
  seen: string | null,
  who: Pick<SimpleChangesCtx, "owners" | "roles"> & { role?: Role; names?: Record<string, string> } = { owners: [] },
): { simple_proposals: Schemas["InboxSimpleChange"][]; simple_decisions: Schemas["InboxSimpleChange"][]; simple_approvals: Schemas["InboxSimpleApproval"][] } {
  // As changes.inbox_rows: newest decision first, then newest made, a tie by the order made.
  const changes = madeOrder(db?.changes ?? [], (c) => [c.decided_at, c.at], true);
  const row = (c: Change, at: string | null, state?: Schemas["InboxSimpleChange"]["state"]): Schemas["InboxSimpleChange"] => {
    const key = db ? keyOf(db, c.target.item_id) : undefined;
    const title = key ? seed(db!, key).title : null;
    return {
      id: c.id, op: c.op, status: c.status, item_id: (c.target.item_id as string) ?? null, item_title: title ?? (typeof c.after.title === "string" ? c.after.title : null),
      document_id: c.document_id, by: c.by, by_name: c.by_name, at: c.at, decided_by: c.decided_by, decided_at: c.decided_at,
      reason: c.reason, decision_reason: c.decision_reason, state: state ?? (!seen || (at && at > seen) ? "new" : "open"),
      from_meeting: c.from_meeting ?? null,
      // inbox-meeting-proposals: what was asked, the item by its name, and whether I may decide it now.
      // A feature ask is not filed in Requests until it is accepted (changes.inbox_rows).
      asked:
        c.op === "add_feature_ask" && (c.status === "proposed" || c.status === "declined")
          ? `proposed ${quotedTitle(c.after.title) ? `the feature ask ${quotedTitle(c.after.title)}` : "a feature ask"}`
          : changePhrase(c.op, c.target, c.before, c.after, title),
      can_decide: !!db && !!who.role && c.status === "proposed" && decidesChange(db, { ...who, id: me, role: who.role, names: {} }, c),
      // inbox-meeting-proposals owner: asked through Ask Oracle, not on the page nor in a meeting.
      from_ask: !c.from_meeting && c.status === "proposed" && !!db?.ask_proposals?.includes(c.id),
    };
  };
  return {
    simple_proposals: changes.filter((c) => c.status === "proposed" && (db ? route(db, who, c) : c.routed_to).includes(me)).map((c) => row(c, c.at)),
    simple_decisions: changes
      .filter((c) => c.by === me && (c.status === "accepted" || c.status === "declined"))
      .map((c) => row(c, c.decided_at, !seen || (c.decided_at ?? "") > seen ? undefined : "done")),
    // S3b (drafts.inbox_rows): drafts submitted with me among the required reviewers they wait
    // on, or with me their decider (drafts._approver_of) whose approval is not in yet.
    simple_approvals: (db?.drafts ?? [])
      .filter((d) => d.out.status === "submitted" && (d.out.waiting_on.includes(me) || (!d.out.decider_approved && !!who.role && approverOf(db!, { id: me, role: who.role }, d))))
      .sort((a, b) => ((a.out.submitted_at ?? "") < (b.out.submitted_at ?? "") ? -1 : 1))
      .map((d) => ({
        draft_id: d.out.id, document: { id: d.out.document.id, slug: d.out.document.slug, title: d.out.document.title }, document_kind: "roadmap" as const, version: d.out.version ?? null, submitted_by: d.out.submitted_by ?? null,
        submitted_by_name: d.out.submitted_by ? (who.names?.[d.out.submitted_by] ?? null) : null, submitted_at: d.out.submitted_at ?? null,
        decider_approved: !!d.out.decider_approved, state: !seen || (d.out.submitted_at ?? "") > seen ? ("new" as const) : ("open" as const),
      })),
  };
}

// --------------------------------------------------------------------------- S7: add, merge, keep both

/** S7's ops (changes.py add_item, merge_item, keep_both): editors apply, others propose. */
const S7_OPS: string[] = ["add_item", "merge_item", "keep_both"];
/** How long Oracle's drafting job of a quick-added draft runs in the mock (ms of the mock clock). */
export const DRAFTING_MS = 2_500;
/** Tests set this localStorage key to hold Oracle's drafting longer (ms of the mock clock). */
export const MOCK_DRAFTING_MS_KEY = "po-mock-drafting-ms";
const draftingMs = () => Number(globalThis.localStorage?.getItem(MOCK_DRAFTING_MS_KEY)) || DRAFTING_MS;

/** The change as intoDrafts reads it: an add_item names an item of its roadmap (the new one may not exist yet). */
function anchored(db: SimpleDb, c: Change): Change {
  if (c.op !== "add_item") return c;
  const slug = slugOf(c.target.roadmap_id)!;
  return { ...c, target: { ...c.target, item_id: db.ids[db.items.find((x) => x.roadmap === slug)!.key] } };
}

const slug = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-$/, "") || "item";

function quarterSpan(value: string): { start: string; end: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]) - 1;
  const start = new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** Validates an S7 change and works out its target and values; a Response when refused. */
function planS7(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): { target: Values; before: Values; after: Values; roadmap: string; applies: boolean } | Response {
  const target: Values = { ...body.target };
  const a = body.after ?? {};
  if (body.op === "add_item") {
    const title = String(a.title ?? "").trim();
    if (!title || title.length > 200) return json(422, { detail: "after.title: 1 to 200 characters" });
    const where = target.where as { kind?: string; value?: string } | undefined;
    const value = String(where?.value ?? "");
    const w = simpleWindows(companyToday());
    let horizon: SeedItem["horizon"] = "next";
    let goal: string | undefined;
    let quarter: { start: string; end: string } | null = null;
    if (where?.kind === "goal") {
      // The goal buckets' goals (./goal-buckets.ts) are the same goals, by their name.
      const bucket = db.goal_buckets?.goals.find((g) => g.id === value)?.title;
      goal = Object.keys(GOALS).find((k) => goalId(k) === value || k === value || (!!bucket && GOALS[k] === bucket));
      // A Goal map goal (the goal-suggestions list names it by its id) is a confirmed goal too.
      const mapped = Object.values(db.map_goals ?? {}).find((g) => g.id === value);
      if (!goal && mapped) MAP_GOALS[value] ??= mapped.title;
      if (!goal && !(value in MAP_GOALS)) return json(422, { detail: "target.where.value: a goal's id" });
    } else if (where?.kind === "horizon") {
      if (!["now", "next", "later"].includes(value)) return json(422, { detail: "target.where.value: now, next or later" });
      horizon = value as SeedItem["horizon"];
    } else if (where?.kind === "quarter") {
      quarter = quarterSpan(value);
      if (!quarter) return json(422, { detail: "target.where.value: a quarter like 2026-Q4" });
      if (quarter.end < w.now[0]) return json(422, { detail: "target.where.value: a quarter not yet over" });
      horizon = quarter.start <= w.now[1] ? "now" : quarter.start <= w.next[1] ? "next" : "later";
    } else return json(422, { detail: "target.where: a quarter, a horizon or a goal" });
    const visible = ROADMAP_SLUGS().filter((r) => ctx.role === "owner" || ctx.role === "approver" || r !== "pricing-roadmap");
    let roadmap = target.roadmap_id ? slugOf(target.roadmap_id) : undefined;
    if (target.roadmap_id && (!roadmap || !visible.includes(roadmap))) return json(404, { detail: "No such roadmap" });
    roadmap ??= (goal ? db.items.find((x) => x.goal === goal && !closed(x) && visible.includes(x.roadmap))?.roadmap : undefined) ?? visible.find((r) => canEditRoadmap(db, r, ctx)) ?? visible[0];
    target.roadmap_id = roadmapId(roadmap);
    target.item_id = crypto.randomUUID();
    const after: Values = { title, horizon, goal_ids: goal ? [goalId(goal)] : value in MAP_GOALS ? [value] : [], ...(quarter ? { quarter } : {}) };
    if (typeof a.outcome === "string" && a.outcome.trim()) after.outcome = a.outcome.trim();
    // tb-mk (additions._live_track): a quick add on a track band names the band's track; the item lands on it.
    if (a.track_id != null) {
      if (!Object.keys(TRACKS).some((k) => stableUuid(`simple-track/${k}`) === a.track_id)) return json(422, { detail: "after.track_id: a product track" });
      after.track_id = String(a.track_id);
    }
    // An item added with its milestone (additions._plan: after.milestone {name, date}).
    const m = a.milestone as { name?: unknown; date?: unknown } | null | undefined;
    if (m && typeof m === "object") {
      const name = String(m.name ?? "").trim();
      if (!name || name.length > 200) return json(422, { detail: "after.milestone.name: 1 to 200 characters" });
      after.milestone = { name, date: typeof m.date === "string" ? m.date : null, date_source: typeof m.date === "string" ? "typed" : null };
    }
    // As additions._plan: a title leading with a code another item or a feature has is refused, in set_code's words.
    const taken = titleCodeTaken(db, readerDb(db, ctx), null, title);
    if (taken) return json(422, { detail: taken });
    return { target, before: {}, after, roadmap, applies: canEditRoadmap(db, roadmap, ctx) };
  }
  const key = keyOf(db, target.item_id);
  if (!key) return json(404, { detail: "No such roadmap item" });
  const s = seed(db, key);
  // panel-menu: any open item merges into another (changes._merge_plan); keep both and a feature link stay a draft's.
  if (closed(s) || (!s.draft && !(body.op === "merge_item" && target.into_id))) return json(422, { detail: body.op === "merge_item" && !target.into_id ? "Only a draft item is linked to a feature" : "target.item_id: an open draft item" });
  const applies = canDecideItem(db, s, ctx);
  if (body.op === "keep_both") {
    if (!!s.kept_both !== !!body.before?.kept_both) return conflict(db, ctx, { kept_both: !!s.kept_both }, [String(target.item_id)], "Changed since you saw it");
    return { target, before: { kept_both: false }, after: { kept_both: true }, roadmap: s.roadmap, applies };
  }
  if (target.into_id) {
    const into = keyOf(db, target.into_id);
    const kept = into ? seed(db, into) : undefined;
    if (!kept || into === key || kept.roadmap !== s.roadmap || closed(kept)) return json(422, { detail: "target.into_id: another live item of the same roadmap" });
    // roadmap-edit-fixes (changes._merge_plan): the kept item never takes a dependency that waits on it.
    const loop = loopOf(db.items, kept.key, (s.depends ?? []).filter((d) => d !== kept.key), [s.key]);
    if (loop) return json(422, { detail: loop });
    Object.assign(target, { code: prdCode(kept.section) ?? kept.key, title: kept.title });
    return { target, before: { status: s.draft ? "draft" : (s.status ?? "planned") }, after: { status: "merged", merged_into: { id: target.into_id, code: prdCode(kept.section) ?? kept.key, title: kept.title } }, roadmap: s.roadmap, applies };
  }
  if (typeof target.feature_id === "string" && target.feature_id) {
    // As the API: the draft becomes the feature's item (linked, kept beside look-alikes), still a draft.
    // Its code (the feature's key, before any ".", and its short code, a published PRD section's) is no other item's own.
    const fid = target.feature_id;
    const short = db.items.find((x) => x.feature_id === fid && !x.draft && prdCode(x.section))?.section;
    const codes = [db.feature_keys?.[fid] ?? db.feature_codes?.[fid], short ? prdCode(short) : null].map((k) => k?.split(".")[0]);
    for (const code of new Set(codes.filter((k): k is string => !!k && /^[A-Z]{1,3}-\d+[a-j]?$/.test(k)))) {
      const taken = ownCodeTaken(readerDb(db, ctx), key, code);
      if (taken) return json(422, { detail: taken });
    }
    return { target, before: { [String(target.item_id)]: { feature_id: null, kept_both: !!s.kept_both } }, after: { [String(target.item_id)]: { feature_id: target.feature_id, kept_both: true } }, roadmap: s.roadmap, applies };
  }
  return json(422, { detail: "target: into_id or feature_id" });
}

async function createS7(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Promise<Response> {
  const now = iso(mockNowMs());
  const plan = planS7(db, ctx, body);
  if (plan instanceof Response) return plan;
  const { target, before, after, roadmap, applies } = plan;
  let session: Session | undefined;
  if (body.session_id) {
    session = (db.sessions ?? []).find((s) => s.id === body.session_id && s.started_by === ctx.id);
    if (!session) return json(404, { detail: "No such session of yours" });
    if (session.closed_at || idle(session)) {
      session.closed_at ??= now;
      return json(409, { detail: "This session is closed; start a new one" });
    }
  } else if (applies) session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
  const change: Change = {
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: roadmapId(roadmap), draft_ids: [], op: body.op, target, before, after,
    status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  let flags: Schemas["SimpleItemFlags"][] = [];
  if (applies) {
    const drafts = intoDrafts(db, anchored(db, change), session!);
    if (drafts instanceof Response) return drafts;
    change.draft_ids = drafts;
    applyS7(db, change);
    flags = flagsFor(db, touched(change));
    session!.last_change_at = now;
  } else change.routed_to = route(db, ctx, change);
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags });
}

/** Whether an S7 proposal still fits the items (its draft open, the kept item live). */
function validS7(db: SimpleDb, c: Change): boolean {
  if (c.op === "add_item") return !keyOf(db, c.target.item_id) && !!slugOf(c.target.roadmap_id);
  const key = keyOf(db, c.target.item_id);
  const s = key ? seed(db, key) : undefined;
  if (!s || closed(s) || (!s.draft && !(c.op === "merge_item" && c.target.into_id))) return false;
  if (c.op === "keep_both") return !s.kept_both;
  if (!c.target.into_id) return true;
  const into = keyOf(db, c.target.into_id);
  return !!into && !closed(seed(db, into));
}

/** Whether the items still hold an applied S7 change (its undo then restores them). */
function holdsS7(db: SimpleDb, c: Change): boolean {
  const key = keyOf(db, c.target.item_id);
  const s = key ? seed(db, key) : undefined;
  if (!s) return false;
  if (c.op === "add_item") return !!s.draft && !closed(s);
  if (c.op === "keep_both") return !!s.kept_both;
  return !!s.merged_into || !!s.linked_feature;
}

function reopenSuggestion(db: SimpleDb, c: Change): void {
  const g = (db.goal_suggestions ?? []).find((x) => x.id === c.target.suggestion_id);
  if (g && g.status === "accepted") Object.assign(g, { status: "open", change_id: null, item_id: null, decided_by_name: null, decided_at: null });
}

function applyS7(db: SimpleDb, c: Change, undo = false): void {
  const id = String(c.target.item_id);
  if (c.op === "add_item") {
    if (undo) {
      const key = keyOf(db, id)!;
      db.items = db.items.filter((x) => x.key !== key);
      delete db.ids[key];
      db.suggestions = db.suggestions.filter((x) => x.item_id !== id);
      reopenSuggestion(db, c);
      return;
    }
    const a = c.after;
    const roadmap = slugOf(c.target.roadmap_id)!;
    let key = slug(String(a.title));
    for (let n = 2; db.ids[key]; n++) key = `${slug(String(a.title))}-${n}`;
    const goalKey = Object.keys(GOALS).find((k) => (a.goal_ids as string[]).includes(goalId(k)));
    db.ids[key] = id;
    const added: SeedItem = {
      key, title: String(a.title), horizon: a.horizon as SeedItem["horizon"], roadmap, goal: goalKey,
      track: db.items.find((x) => x.roadmap === roadmap && x.track)?.track, draft: true, outcome: typeof a.outcome === "string" ? a.outcome : null,
      drafting_until: mockNowMs() + draftingMs(), quarter: (a.quarter as { start: string; end: string } | undefined) ?? undefined,
      ...(a.milestone ? { milestone: { name: String((a.milestone as Values).name), day: dayIn(a.horizon as SeedItem["horizon"], (a.milestone as Values).date) } } : {}),
      looks_like: lookalikes(db, String(a.title), roadmap),
    };
    // simple-replaced-prds: never filed under a replaced PRD, which Simple leaves out.
    fileUnderCurrentPrd(db, added);
    // tb-mk (additions: track_id): the band's track (after.track_id), its PRD left as filed.
    const band = Object.keys(TRACKS).find((k) => !!a.track_id && stableUuid(`simple-track/${k}`) === a.track_id);
    if (band) added.track = band;
    db.items.push(added);
    return;
  }
  const s = seed(db, keyOf(db, id)!);
  if (c.op === "keep_both") {
    s.kept_both = !undo;
    return;
  }
  // merge_item: the seeds it touches are kept as they were for the undo.
  const snaps = (db.snapshots ??= {});
  if (undo) {
    for (const was of snaps[c.id] ?? []) db.items = db.items.map((x) => (x.key === was.key ? structuredClone(was) : x));
    delete snaps[c.id];
    return;
  }
  const intoKey = c.target.into_id ? keyOf(db, c.target.into_id) : undefined;
  const dependents = db.items.filter((x) => x.depends?.includes(s.key));
  // feature-parts: its parts move to the kept item; the kept item, when one of its parts at any
  // depth, takes its place under its parent (changes._merge_plan: no part under a closed item, no loop).
  const parts = db.items.filter((x) => x.parent === s.key && !dependents.includes(x));
  snaps[c.id] = structuredClone([s, ...(intoKey ? [seed(db, intoKey)] : []), ...[...dependents, ...parts].filter((x) => x.key !== intoKey)]);
  if (!intoKey) {
    s.linked_feature = String(c.target.feature_id);
    s.kept_both = true;
    return;
  }
  const kept = seed(db, intoKey);
  const goals = [...(s.goal ? [s.goal] : []), ...(s.goals ?? [])].filter((g) => g !== kept.goal && !(kept.goals ?? []).includes(g));
  if (goals.length) kept.goals = [...(kept.goals ?? []), ...goals];
  const deps = (s.depends ?? []).filter((d) => d !== kept.key && !(kept.depends ?? []).includes(d));
  if (deps.length) kept.depends = [...(kept.depends ?? []), ...deps];
  for (const d of dependents) d.depends = [...new Set(d.depends!.map((k) => (k === s.key ? kept.key : k)))].filter((k) => k !== d.key);
  kept.notes = [...(kept.notes ?? []), `Merged ${s.title} (${s.key}) into it.`];
  const under = new Set<string>();
  for (let k = kept.parent; k && !under.has(k); k = db.items.find((y) => y.key === k && !y.trashed)?.parent) under.add(k);
  if (under.has(s.key)) kept.parent = s.parent;
  for (const x of db.items) if (x.parent === s.key && x !== kept && !x.trashed) x.parent = kept.key;
  s.parent = undefined;
  s.merged_into = kept.key;
}

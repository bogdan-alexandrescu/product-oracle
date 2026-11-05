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
import { changeSentence } from "./simple-change-words";
import { milestoneValue, writeMilestone } from "./simple-milestones";
import { archiveGoal, goalBucketsDb, seedGoalBuckets, trashGoal, unarchiveGoal, type GoalBucketsTrash } from "./goal-buckets";
import { addToCompany, featureItem, featureKeyOf, priorityAfter, priorityBefore, prioritiesOut } from "./simple-priorities";
import {
  canDecideItem,
  canEditRoadmap,
  closed,
  companyToday,
  deciderIds,
  draftChanges,
  GOALS,
  goalId,
  goalIdsOf,
  goalOfSeed,
  itemDeciderId,
  lookalikes,
  fileUnderCurrentPrd,
  ofReplacedPrd,
  shiftPlan,
  ownDates,
  prdCode,
  ROADMAP_SLUGS,
  readerDb,
  readsRoadmap,
  roadmapId,
  roadmapOut,
  draftPrds,
  readableRoadmap,
  seesDraft,
  settleDrafting,
  simpleWindows,
  storedDates,
  type MockDraft,
  type MockKeyDate,
  type SeedItem,
  type SimpleDb,
} from "./simple-roadmap";
import { routeGoalSuggestions } from "./simple-suggestions";
import { goalSetOf, linkPlan, overrideOf } from "./feature-panel";
import { entryOut, mayRestore, restoreFromTrash, type TrashDb, type TrashEntryRow } from "./trash";

type Change = Schemas["SimpleChangeOut"];
type Session = Schemas["SimpleSessionOut"];
type Role = Schemas["Me"]["role"];
type Values = Record<string, unknown>;

export interface SimpleChangesCtx {
  id: string;
  role: Role;
  /** The company's owners (who decide proposals with no decider or roadmap owner). */
  owners: string[];
  /** Person id -> name. */
  names: Record<string, string>;
  /** Person id -> role (D-a: whether a track owner decides). */
  roles?: Record<string, Role>;
  /** The company's confirmed goals (the baseline's), as the API lists them for suggestions (qa4-simple-home-4). */
  companyGoals?: { id: string; key: string; title: string }[];
  /** simple-replaced-prds: the slugs and ids of the PRDs marked replaced (their open drafts are never listed in Simple). */
  replaced?: string[];
  /** trash-features-goals: Settings › Trash (./trash.ts), shared with documents, intakes and runs. */
  trash?: TrashDb;
  /** edit-goals-prds: the goal buckets' Trash, writer and members (an accepted Ask to delete a goal). */
  goalBin?: GoalBucketsTrash;
}

/** edit-goals-prds (oracle.simple.goal_asks): a goal archived, moved to Trash or restored, asked by who may not. */
const GOAL_ASK_OPS = ["archive_goal", "delete_goal", "unarchive_goal"];
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
  const row = trashGoal(gb, bin, id, to, c.reason ?? null);
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
  edit_note: ["note"],
  accept_risk: ["risk"],
  // S6: a draft item confirmed (changes.py confirm_item).
  confirm_item: ["draft"],
  // ask-oracle-actions: an item's own depends_on, item keys of its roadmap (changes.py set_depends_on).
  set_depends_on: ["depends_on"],
  // goal-buckets-tasks: the goals an item serves (changes.py set_goals).
  set_goals: ["goal_ids"],
  // build-feature-panel: an item's links, and Oracle's dates put back (./feature-panel.ts).
  add_link: ["depends_on"],
  remove_link: ["depends_on"],
  restore_link: ["depends_on"],
  restore_dates: ["start_date", "end_date"],
  // build-feature-panel review 2: an item's own goal, and Oracle's put back (./feature-panel.ts).
  set_goal: ["goal_ids"],
  restore_goal: ["goal_ids"],
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
  add_feature_ask: { id: "ask_id", adds: true },
  // Chat actions: an item's owner or decider (stored by item id; simple-roadmap's itemOwnerId / itemDeciderId read them).
  set_owner: { id: "item_id" },
  set_decider: { id: "item_id" },
};

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

/** The roadmap slug of a key-date change's target document. */
function roadmapOfDoc(db: SimpleDb, docId: unknown): string | undefined {
  return [...new Set(db.items.map((s) => s.roadmap))].find((r) => stableUuid(`simple-doc/${r}`) === docId);
}


/** Whether the caller applies a change to this item (service.can_decide); no item: owners. */
function decides(db: SimpleDb, ctx: SimpleChangesCtx, itemId: unknown): boolean {
  const key = itemId ? keyOf(db, itemId) : undefined;
  return key ? canDecideItem(db, seed(db, key), ctx) : ctx.role === "owner";
}

/** S7: the roadmap (slug) an add_item change writes. */
const slugOf = (id: unknown): string | undefined => ROADMAP_SLUGS().find((r) => roadmapId(r) === id);

/** Whether the caller applies (or accepts) this change: a key date's by the roadmap's rule
 * (drafts.can_edit), an add_item's by its roadmap's editors, else the item's deciders. */
function decidesChange(db: SimpleDb, ctx: SimpleChangesCtx, c: Pick<Change, "op" | "target"> & Partial<Pick<Change, "routed_to" | "after">>): boolean {
  // Review major (changes.decides_all): a cut with its dependents needs rights on every item it cuts.
  if (c.op === CUT_ALL && c.after) return Object.keys(c.after).every((id) => decides(db, ctx, id));
  // A goal ask is decided by the owners it is sent to (goal_asks.may_decide).
  if (GOAL_ASK_OPS.includes(c.op)) return ctx.role === "owner";
  if (KEY_DATE_OPS.includes(c.op) || c.op === MILESTONE_OP) {
    const rm = roadmapOfDoc(db, c.target.document_id);
    return ctx.role === "owner" || (c.routed_to ?? []).includes(ctx.id) || (!!rm && canEditRoadmap(db, rm, ctx));
  }
  if (c.op === "add_item" && !keyOf(db, c.target.item_id)) return canEditRoadmap(db, slugOf(c.target.roadmap_id) ?? "", ctx);
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
  if (c.status !== "proposed" || KEY_DATE_OPS.includes(c.op) || c.op === MILESTONE_OP) return c.routed_to;
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
function read(db: SimpleDb, key: string, fields: string[], target: Values): Values {
  const s = seed(db, key);
  const own = ownDates(db, s);
  const out: Values = {};
  for (const f of fields) {
    // The API's stored dates: typed or accepted ones (storedDates), never estimates.
    if (f === "start_date") out[f] = storedDates(db, key).start;
    else if (f === "end_date") out[f] = storedDates(db, key).end;
    else if (f === "date_source") out[f] = own ? (own.source ?? "accepted") : s.source === "typed" || s.source === "accepted" ? s.source : null;
    else if (f === "horizon") out[f] = s.horizon;
    else if (f === "position") out[f] = s.position ?? db.items.indexOf(s);
    else if (f === "cut") out[f] = s.status === "cut";
    else if (f === "title") out[f] = s.title;
    else if (f === "outcome") out[f] = s.outcome ?? null;
    else if (f === "note") out[f] = s.note ?? null;
    else if (f === "draft") out[f] = !!s.draft;
    else if (f === "depends_on") out[f] = [...(s.depends ?? [])];
    else if (f === "goal_ids") out[f] = goalIdsOf(s);
    // The mock's own: the goal set in the panel ("" none), null when Oracle's (an undo puts it back).
    else if (f === "own_goal") out[f] = s.own_goal ?? null;
    else if (f === "risk") out[f] = (s.risks ?? []).find((r) => r.flag === target.flag && (r.subject ?? null) === (target.subject ?? null)) ?? null;
  }
  return out;
}

function write(db: SimpleDb, key: string, values: Values, target: Values): void {
  const s = seed(db, key);
  if ("start_date" in values) {
    if (values.start_date && values.end_date) db.own[key] = { start: String(values.start_date), end: String(values.end_date), source: (values.date_source as "typed" | "accepted") ?? "typed" };
    else delete db.own[key];
  }
  if ("horizon" in values) s.horizon = values.horizon as typeof s.horizon;
  if ("position" in values) s.position = values.position as number;
  if ("cut" in values) s.status = values.cut ? "cut" : "planned";
  if ("title" in values) s.title = String(values.title);
  if ("draft" in values) s.draft = !!values.draft;
  if ("goal_ids" in values && !("own_goal" in values)) {
    // set_goals (the goal buckets' move): the goals it serves; a goal set in its panel follows.
    const keys = (values.goal_ids as string[]).map((id) => Object.keys(GOALS).find((k) => goalId(k) === id)).filter((k): k is string => !!k);
    s.goal = keys[0];
    s.goals = keys.slice(1);
    if (s.own_goal !== undefined) s.own_goal = keys[0] ?? "";
  }
  if ("depends_on" in values) s.depends = [...((values.depends_on as string[] | null) ?? [])];
  if ("outcome" in values) s.outcome = (values.outcome as string | null) ?? null;
  if ("note" in values) s.note = (values.note as string | null) ?? null;
  if ("own_goal" in values) {
    if (values.own_goal == null) delete s.own_goal;
    else s.own_goal = String(values.own_goal);
  }
  if ("risk" in values) {
    const kept = (s.risks ?? []).filter((r) => !(r.flag === target.flag && (r.subject ?? null) === (target.subject ?? null)));
    const risk = values.risk as { flag: never; note: string; subject?: string | null } | null;
    s.risks = risk ? [...kept, risk] : kept;
  }
}

function touched(c: Pick<Change, "op" | "target" | "after" | "before">): string[] {
  return KEYED.includes(c.op) ? [...new Set([...Object.keys(c.after), ...Object.keys(c.before)])] : [String(c.target.item_id)];
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

function conflict(db: SimpleDb, ctx: SimpleChangesCtx, current: Values, ids: string[], lead: string): Response {
  const last = (db.changes ?? [])
    .filter((c) => ["applied", "accepted", "undone"].includes(c.status) && touched(c).some((i) => ids.includes(i)))
    .map((c) => ({ at: c.status === "accepted" && c.decided_at ? c.decided_at : c.at, who: c.status === "accepted" && c.decided_by ? c.decided_by : c.by }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
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
    words: changeSentence(c, c.by_name, itemLabel(db, c.target.item_id), undone),
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
  return (db.sessions ?? []).some((s) => s.id === c.session_id && s.started_by === ctx.id);
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
      const items = db.items.filter((x) => x.roadmap === rm);
      const keys = new Set(items.map((x) => x.key));
      d = {
        roadmap: rm,
        published: structuredClone({ items, own: Object.fromEntries(Object.entries(db.own).filter(([k]) => keys.has(k))), key_dates: db.key_dates?.[rm] ?? [] }),
        out: {
          id: crypto.randomUUID(), document: { id: stableUuid(`simple-doc/${rm}`), slug: rm, title: rm.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()) },
          status: "working", base_version: 1, version: null, created_by: session.started_by, created_at: iso(mockNowMs()), participant_ids: [session.started_by],
          submitted_at: null, submitted_by: null, decider_approved: false, waiting_on: [], approved_at: null, blocked_by: [], decision_notes: [],
        },
      };
      drafts.push(d);
    }
    if (!d.out.participant_ids.includes(session.started_by)) d.out.participant_ids.push(session.started_by);
    out.push(d.out.id);
  }
  return out;
}

/** D-d: the draft's applied changes, not undone: who, when, and whether in a meeting. */
function changeLog(db: SimpleDb, id: string): Schemas["SimpleDraftChange"][] {
  const cs = db.changes ?? [];
  return cs
    .filter((c) => ["applied", "accepted"].includes(c.status) && (c.draft_ids ?? []).includes(id) && !cs.some((u) => u.undoes_id === c.id))
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((c) => {
      const kind = (db.sessions ?? []).find((x) => x.id === c.session_id)?.kind ?? null;
      const titles = c.op === CUT_ALL ? ((c.target.titles as string[] | undefined) ?? []) : [];
      return { id: c.id, op: c.op, item_id: (c.target.item_id as string) ?? null, by: c.by, by_name: c.by_name, at: c.at, session_kind: kind, in_meeting: kind === "meeting", titles };
    });
}

function draftOut(db: SimpleDb, ctx: SimpleChangesCtx, d: MockDraft): Schemas["SimpleDraftOut"] {
  const edits = canEditRoadmap(db, d.roadmap, ctx);
  const decider = db.deciders?.[d.roadmap];
  return {
    ...d.out, changes: draftChanges(db, d.out.id), change_log: changeLog(db, d.out.id), from_prds: draftPrds(d),
    can_submit: d.out.status === "working" && edits,
    can_resume: d.out.status === "working" && (d.out.created_by === ctx.id || decider === ctx.id),
    can_approve: d.out.status === "submitted" && edits,
    can_withdraw: d.out.status === "submitted" && (d.out.created_by === ctx.id || edits),
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
    Object.assign(d.out, { status: "submitted", version: (d.out.base_version ?? 1) + 1, submitted_at: now, submitted_by: ctx.id });
    return json(200, draftOut(db, ctx, d));
  }
  if (p[4] === "approve") {
    if (d.out.status !== "submitted") return json(409, { detail: `This draft is ${d.out.status}: only a submitted draft is approved` });
    if (!canEditRoadmap(db, d.roadmap, ctx)) return json(403, { detail: "Only the decider and the required reviewers approve this draft" });
    // No required reviewers in the mock: the approval publishes the version.
    Object.assign(d.out, { decider_approved: true, status: "approved", approved_at: now });
    return json(200, draftOut(db, ctx, d));
  }
  if (p[4] === "withdraw") {
    // S3b-1: back to working, its changes kept; the version is withdrawn (never approved).
    if (d.out.created_by !== ctx.id && !canEditRoadmap(db, d.roadmap, ctx)) return json(403, { detail: "Only the draft's author or the roadmap's decider withdraws it" });
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
    const key = body.op === "override_priority" ? addToCompany(db, target.feature_id) : featureItem(db, target.feature_id);
    if (!key) return json(404, { detail: "No such feature" });
    target.item_id = db.ids[key];
  }
  if (spec.adds) target[spec.id] = crypto.randomUUID();
  const id = String(target[spec.id] ?? "");
  const stored = (db.targets ??= {})[id] ?? {};
  const after = ranking ? priorityAfter(body.op, body.after ?? {}) : { ...body.after };
  if (typeof after === "string") return json(422, { detail: after });
  // changes.py set_owner: null allowed, else an existing active member.
  if (body.op === "set_owner" && after.owner_id != null && !ctx.roles?.[String(after.owner_id)]) {
    return json(422, { detail: "after.owner_id: a member of this company" });
  }
  // changes.py set_milestone: the name's words collapsed to single spaces, 1 to 200 characters;
  // a date that is not a valid YYYY-MM-DD refused.
  if (body.op === "set_milestone" && after.milestone != null) {
    const m = after.milestone as Values;
    const name = String(m.name ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!name || name.length > 200) return json(422, { detail: "after.milestone.name: 1 to 200 characters" });
    const date = m.date == null ? null : String(m.date);
    if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(422, { detail: "after.milestone.date: a day as YYYY-MM-DD" });
    after.milestone = { ...m, name, date };
  }
  // walkc-roadmap-tasks: a task's owner is a person (targets.py stores owner_id); the chat's
  // "for <name>" names them.
  if (body.op === "add_item_task" && !after.owner_id && typeof after.owner_name === "string") {
    const asked = after.owner_name.trim().toLowerCase();
    const hit = Object.entries(ctx.names).find(([, n]) => n.toLowerCase() === asked) ?? Object.entries(ctx.names).find(([, n]) => n.toLowerCase().split(" ")[0] === asked);
    if (hit) Object.assign(after, { owner_id: hit[0], owner_name: hit[1] });
  }
  // The item's owner reads by name, as the API's SimpleOwnerRef does.
  if (body.op === "set_owner" && after.owner_id && ctx.names[String(after.owner_id)]) (db.people ??= {})[String(after.owner_id)] ??= ctx.names[String(after.owner_id)];
  if (body.op === "add_item_task" && after.owner_id && !after.owner_name) after.owner_name = ctx.names[String(after.owner_id)] ?? null;
  const before: Values = ranking
    ? priorityBefore(db, keyOf(db, target.item_id)!, body.op, id)
    : (body.op as string) === "set_owner"
      ? { owner_id: ownOwnerId(db, String(target.item_id)) }
      : (body.op as string) === "set_decider"
        ? { decider_id: itemDeciderId(db, keyOf(db, target.item_id)!, ctx.roles) }
        : body.op === "set_milestone"
          ? { milestone: ownMilestone(db, keyOf(db, target.item_id)!) }
          : spec.adds ? {} : Object.fromEntries(Object.keys(body.before).map((k) => [k, stored[k] ?? null]));
  const seen = ranking ? Object.fromEntries(Object.keys(before).map((k) => [k, body.before[k] ?? null])) : body.before;
  // build-feature-panel review 2: a milestone is matched by its name and date as the item reads them (changes._seen_milestone).
  const matches = body.op === "set_milestone" ? seenMilestone(before.milestone) === seenMilestone(seen.milestone) : same(before, seen);
  // build-feature-panel review 3: as changes.py, a stale `before` is a 409 before a no-op is a 422.
  if (!spec.adds && !matches) return conflict(db, ctx, before, [id], "Changed since you saw it");
  if ((body.op === "set_owner" || body.op === "set_decider") && same(before, after)) return json(422, { detail: "No change: it is so already" });
  if (body.op === "override_priority" && after.override === null && !before.override) return json(409, { detail: "It is at Oracle's rank already" });
  const change: Change = {
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: target.item_id ? stableUuid(`simple-doc/${seed(db, keyOf(db, target.item_id)!).roadmap}`) : null,
    draft_ids: [], op: body.op, target, before, after, status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  if (!applies) change.routed_to = route(db, ctx, change);
  if (applies) {
    writeTarget(db, change, change.after);
    session!.last_change_at = now;
  }
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
}

/** The item's own owner as the API stores it (changes.py set_owner's before): null when it has only its track's. */
function ownOwnerId(db: SimpleDb, itemId: string): string | null {
  const t = db.targets?.[itemId];
  return t && typeof t.owner_id === "string" ? t.owner_id : null;
}

/** A milestone as the item reads it: its name and day (changes._seen_milestone). */
function seenMilestone(m: unknown): string {
  const v = (m ?? {}) as Values;
  return v.name || v.date ? JSON.stringify([v.name || null, v.date || null]) : "none";
}

function writeTarget(db: SimpleDb, c: Change, values: Values, undo = false): void {
  const spec = TARGETS[c.op];
  const id = String(c.target[spec.id]);
  const targets = (db.targets ??= {});
  if (spec.adds && undo) delete targets[id];
  // walkc-roadmap-tasks: a task is stored under its item, open, as RoadmapItemTask is.
  else if (c.op === "add_item_task") targets[id] = { status: "todo", owner_id: null, due_date: null, ...values, kind: "item_task", item_id: c.target.item_id, at: c.at };
  else targets[id] = { ...(targets[id] ?? {}), ...values };
  // An item's own milestone (set_milestone, and its undo) is what the roadmap reads of it.
  if (c.op === "set_milestone") {
    const key = keyOf(db, c.target.item_id);
    const s = key ? db.items.find((x) => x.key === key) : undefined;
    const m = values.milestone as { name: string; date?: string | null } | null | undefined;
    if (s) {
      const w = simpleWindows(companyToday())[s.horizon][0];
      s.milestone = m ? { name: m.name, day: m.date ? Math.round((Date.parse(`${m.date}T00:00:00Z`) - Date.parse(`${w}T00:00:00Z`)) / DAY) : null } : undefined;
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
  const gb = (db.goal_buckets ??= seedGoalBuckets());
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

function writeKeyDate(db: SimpleDb, c: Change, value: unknown): void {
  const rm = roadmapOfDoc(db, c.target.document_id)!;
  const id = String(c.target.key_date_id);
  const list = (db.key_dates ??= {})[rm] ?? [];
  const v = value as Values | null;
  db.key_dates[rm] = v ? [...list.filter((k) => k.id !== id), { id, name: String(v.name), date: String(v.date), note: (v.note as string | null) ?? null }] : list.filter((k) => k.id !== id);
}

/** milestone-rights (goal_milestones.create_change): a roadmap's own goal milestone, proposed
 * by who may not change it (an approver who is not its owner, a commenter); `after.milestone`
 * null proposes removing it. Routed as a key date's proposal is. */
const MILESTONE_OP = "edit_goal_milestone";

function createMilestoneChange(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Response {
  const m = (db.goal_milestones ?? []).find((x) => x.id === body.target.milestone_id && !x.deleted);
  if (!m) return json(404, { detail: "No such milestone" });
  if (m.prd) return json(422, { detail: "A PRD's milestone: change it on its card (it asks the PRD's owner)" });
  if (db.company_roadmap && m.roadmap !== db.company_roadmap) return json(409, { detail: "That roadmap is history" });
  if (canEditRoadmap(db, m.roadmap, ctx)) return json(409, { detail: "You change this milestone directly" });
  if (!("milestone" in body.before) || !("milestone" in (body.after ?? {}))) return json(422, { detail: "before.milestone and after.milestone (null: remove it)" });
  const current = milestoneValue(m, db.ids);
  if (!same(body.before.milestone, current)) return json(409, { detail: { message: "Changed since you saw it", current: { milestone: current }, changed_by: null, changed_at: null } });
  const wanted = body.after?.milestone as Values | null;
  const after = wanted ? { ...current, ...Object.fromEntries(Object.entries(wanted).filter(([k, v]) => k in current && (v !== null || k === "goal_id"))) } : null;
  if (after && same(after, current)) return json(422, { detail: "after.milestone: nothing changes" });
  const doc = stableUuid(`simple-doc/${m.roadmap}`);
  const decider = db.deciders?.[m.roadmap];
  const change: Change = {
    id: crypto.randomUUID(), session_id: null, document_id: doc, draft_ids: [], op: body.op, target: { milestone_id: m.id, roadmap_id: doc, name: m.name },
    before: { milestone: current }, after: { milestone: after }, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: decider ? [decider] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  (db.changes ??= []).push(change);
  return json(201, { change: view(db, ctx, change), flags: [] });
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
  const row: TrashEntryRow = {
    out: {
      id: crypto.randomUUID(),
      root: { type: "feature", id: db.ids[key], slug: key, title: s.title, kind: "feature", code: prdCode(s.section) },
      items: [], deleted_by: ctx.id, deleted_by_name: ctx.names[ctx.id] ?? "someone", deleted_at: now,
      reason, published: false, purge_after: new Date(Date.parse(now) + 30 * DAY).toISOString(),
    },
    documents: [], versions: [], runs: [], intakes: [],
  };
  const trash = (ctx.trash ??= { entries: [], estimates: {} });
  trash.entries.push(row);
  return row;
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
  return json(200, restoreFromTrash(ctx.trash!, entry, iso(mockNowMs()), db));
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
  if (body.op === MILESTONE_OP) return createMilestoneChange(db, ctx, body);
  if (body.op === "delete_item") return createDeleteItem(db, ctx, body);
  if (GOAL_ASK_OPS.includes(body.op)) return createGoalAsk(db, ctx, body);
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
    const missing = fields.filter((f) => !(f in body.before));
    if (missing.length) return json(422, { detail: `before: ${missing.join(", ")} as you saw them` });
    const now_ = read(seen, key, fields, target);
    // A suggestion accepted after the item got dates is "outdated" (S2-minor).
    const lead = body.op === "accept_date_suggestion" ? "outdated" : "Changed since you saw it";
    if (!same(normal(fields, body.before), now_)) return conflict(db, ctx, now_, [String(target.item_id)], lead);
    const a = body.after ?? {};
    let stored = fields;
    if (body.op === "move_dates") {
      if (!a.start_date || !a.end_date || String(a.end_date) < String(a.start_date)) return json(422, { detail: "after: start_date and end_date, the end not before the start" });
      after = { start_date: a.start_date, end_date: a.end_date, date_source: "typed" };
      stored = ["start_date", "end_date", "date_source"];
      // build-feature-panel: Oracle's dates as the item showed them, for the panel's override line.
      const shownNow = roadmapOut(seen, "owner", new URLSearchParams())!.items.find((i) => i.id === target.item_id);
      if (shownNow && shownNow.source !== "typed" && !shownNow.end.estimated) target.oracle = { start_date: shownNow.start.date, end_date: shownNow.end.date, source: shownNow.source, start_source: shownNow.start.source };
    } else if (body.op === "add_link" || body.op === "remove_link" || body.op === "restore_link") {
      const depKey = keyOf(db, target.subject);
      const dep = depKey ? seen.items.find((x) => x.key === depKey) : undefined;
      if (!dep || depKey === key) return json(422, { detail: "target.subject: another item of the roadmap" });
      if (dep.roadmap !== seed(seen, key).roadmap) return json(422, { detail: "A link joins two items of one roadmap" });
      target.subject_key = depKey;
      target.subject_title = dep.title;
      const waitsOn = (from: string): boolean => {
        const seenKeys = new Set<string>();
        const queue = [from];
        while (queue.length) {
          const k = queue.shift()!;
          for (const d of seen.items.find((x) => x.key === k)?.depends ?? []) {
            if (d === key) return true;
            if (!seenKeys.has(d)) {
              seenKeys.add(d);
              queue.push(d);
            }
          }
        }
        return false;
      };
      const plan = linkPlan(body.op, seed(seen, key).title, [...(seed(seen, key).depends ?? [])], depKey!, dep.title, waitsOn);
      if (typeof plan === "string") return json(422, { detail: plan });
      after = { depends_on: plan };
    } else if (body.op === "restore_dates") {
      const kept = overrideOf(db.changes ?? [], String(target.item_id));
      if (!kept || !kept.end_date) return json(422, { detail: "No dates of Oracle's to restore" });
      after = { ...kept.restore };
      stored = ["start_date", "end_date", "date_source"];
    } else if (body.op === "set_goal" || body.op === "restore_goal") {
      const own = goalSetOf(db.changes ?? [], String(target.item_id));
      const it = seed(seen, key);
      if (body.op === "restore_goal") {
        if (!own) return json(422, { detail: "No goal of Oracle's to restore" });
        after = { goal_ids: goalIdsOf({ ...it, own_goal: undefined }), own_goal: null };
      } else {
        const ids = Array.isArray(a.goal_ids) ? (a.goal_ids as string[]) : null;
        if (!ids || ids.length > 1) return json(422, { detail: "after.goal_ids: one goal, or none" });
        const goal = ids.length ? Object.keys(GOALS).find((k) => goalId(k) === ids[0]) : "";
        if (goal === undefined) return json(422, { detail: "after.goal_ids: a goal of this company" });
        const measure = String(a.measure ?? "").split(/\s+/).filter(Boolean).join(" ") || null;
        const now = goalOfSeed(it);
        if ((goal || undefined) === now && measure === (own?.measure ?? null)) return json(422, { detail: "No change: it is so already" });
        target.measure = measure;
        if (!own) target.oracle = now ? { id: goalId(now), title: GOALS[now] } : null;
        after = { goal_ids: goal ? [goalId(goal)] : [], own_goal: goal };
      }
      stored = ["goal_ids", "own_goal"];
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
      after = { horizon: a.horizon };
    } else if (body.op === "reorder") after = { position: Number(a.position) };
    else if (body.op === "cut" || body.op === "restore") after = { cut: body.op === "cut" };
    else if (body.op === "confirm_item") {
      if (!seed(seen, key).draft) return json(422, { detail: "Only a draft item is confirmed" });
      after = { draft: false };
    }
    else if (body.op === "edit_title") {
      // changes.py edit_title: the title's words, collapsed to single spaces, 1 to 200 characters.
      const title = String(a.title ?? "").split(/\s+/).filter(Boolean).join(" ");
      if (!title || title.length > 200) return json(422, { detail: "after.title: 1 to 200 characters" });
      after = { title };
    } else if (body.op === "edit_outcome") {
      // changes.py edit_outcome: trimmed, at most 1000 characters.
      const outcome = a.outcome == null ? null : String(a.outcome).trim();
      if (outcome != null && outcome.length > 1000) return json(422, { detail: "after.outcome: at most 1000 characters" });
      after = { outcome: outcome || null };
    }
    else if (body.op === "edit_note") {
      const note = a.note == null ? "" : String(a.note).trim();
      if (note.length > 500) return json(422, { detail: "after.note: at most 500 characters" });
      after = { note: note || null };
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
    }
    else if ((body.op as string) === "set_depends_on") {
      const keys = a.depends_on;
      const mine = new Set(seen.items.filter((x) => x.roadmap === seed(seen, key).roadmap && x.key !== key).map((x) => x.key));
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string" || !mine.has(k))) return json(422, { detail: "after.depends_on: items of the same roadmap" });
      after = { depends_on: [...new Set(keys as string[])] };
    }
    else {
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
    const rows = (db.changes ?? [])
      .filter((c) => (!q.get("session") || c.session_id === q.get("session")) && (!q.get("document") || c.document_id === q.get("document")) && (!status || c.status === status) && (q.get("mine") !== "true" || c.by === ctx.id))
      .filter((c) => sees(db, ctx, c) && !onReplacedPrd(db, c))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
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
    if (TARGETS[c.op]) writeTarget(db, c, c.before, true);
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
    } else {
      const now_ = current(db, c, c.after);
      if (!same(now_, c.after)) return conflict(db, ctx, now_, touched(c), "Changed since");
      const drafts = intoDrafts(db, c, s, true);
      if (drafts instanceof Response) return drafts;
      apply(db, c, c.before, true);
    }
    const u: Change = { ...c, id: crypto.randomUUID(), before: c.after, after: c.before, status: "undone", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now, undoes_id: c.id, routed_to: [], decided_by: null, decided_at: null };
    db.changes!.push(u);
    s.last_change_at = now;
    return json(201, { change: view(db, ctx, u), flags: TARGETS[c.op] || KEY_DATE_OPS.includes(c.op) ? [] : flagsFor(db, touched(c)) });
  }
  if (!decidesChange(db, ctx, c)) return json(403, { detail: "Only an owner or the roadmap's decider (with no decider, its owner) decides proposals" });
  if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
  const body = (await req.json().catch(() => ({}))) as { reason?: string | null };
  if (p[4] === "accept" && TARGETS[c.op]) writeTarget(db, c, c.after);
  else if (p[4] === "accept" && c.op === MILESTONE_OP) {
    const ms = (db.goal_milestones ?? []).find((x) => x.id === c.target.milestone_id && !x.deleted);
    if (!ms) return json(404, { detail: "The milestone is gone" });
    if (!same(milestoneValue(ms, db.ids), c.before.milestone)) return json(409, { detail: { message: "outdated: the milestone changed since the proposal", current: { milestone: milestoneValue(ms, db.ids) }, changed_by: null, changed_at: null } });
    writeMilestone(ms, db.ids, c.after.milestone as Values | null);
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
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    const drafts = intoDrafts(db, anchored(db, c), session);
    if (drafts instanceof Response) return drafts;
    c.draft_ids = drafts;
    session.last_change_at = now;
    applyS7(db, c);
  } else if (p[4] === "decline" && c.op === "add_item") reopenSuggestion(db, c);
  else if (p[4] === "accept" && GOAL_ASK_OPS.includes(c.op)) {
    const err = applyGoalAsk(db, ctx, c);
    if (err) return err;
  } else if (p[4] === "accept" && c.op === "delete_item") {
    const key = keyOf(db, c.target.item_id);
    if (!key || seed(db, key).trashed) return json(404, { detail: "The feature is gone" });
    trashFeature(db, ctx, key, c.reason ?? null, now);
  } else if (p[4] === "accept") {
    const now_ = current(db, c, c.before);
    if (!same(now_, c.before)) return conflict(db, ctx, now_, touched(c), "outdated");
    // Into the decider's working draft (their editing session's).
    const session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    const drafts = intoDrafts(db, c, session);
    if (drafts instanceof Response) return drafts;
    c.draft_ids = drafts;
    session.last_change_at = now;
    apply(db, c, c.after);
  }
  Object.assign(c, { status: p[4] === "accept" ? "accepted" : "declined", decided_by: ctx.id, decided_at: now, decision_reason: body.reason ?? null });
  return json(200, { change: view(db, ctx, c), flags: TARGETS[c.op] || KEY_DATE_OPS.includes(c.op) ? [] : flagsFor(db, touched(c)) });
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
 * meeting-changes-only-its-agenda (changes.create): a change a meeting makes to an item it does
 * not review is never applied: a proposal for the item's own decider (never the meeting's),
 * naming the meeting that asked for it.
 */
export function proposeOffAgenda(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"], meeting: { id: string; title: string }, sessionId: string): Schemas["SimpleChangeResult"] | Response {
  const key = keyOf(db, body.target.item_id);
  if (!key) return json(404, { detail: "No such roadmap item" });
  const fields = FIELDS[body.op] ?? Object.keys(body.after ?? {});
  const after = body.op === "cut" ? { cut: true } : body.op === "restore" ? { cut: false } : { ...(body.after ?? {}) };
  const c: Change = {
    id: crypto.randomUUID(), session_id: sessionId, document_id: stableUuid(`simple-doc/${seed(db, key).roadmap}`), draft_ids: [],
    op: body.op, target: { ...body.target }, before: body.before ?? read(db, key, fields, body.target), after, status: "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: iso(mockNowMs()),
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
    from_meeting: meeting, off_agenda: true,
  };
  c.routed_to = route(db, ctx, c);
  (db.changes ??= []).push(c);
  return { change: view(db, ctx, c), flags: [] };
}

/** Inbox rows (changes.inbox_rows): proposals waiting for me, decisions on mine. */
export function simpleInboxRows(
  db: SimpleDb | undefined,
  me: string,
  seen: string | null,
  who: Pick<SimpleChangesCtx, "owners" | "roles"> = { owners: [] },
): { simple_proposals: Schemas["InboxSimpleChange"][]; simple_decisions: Schemas["InboxSimpleChange"][]; simple_approvals: Schemas["InboxSimpleApproval"][] } {
  const changes = db?.changes ?? [];
  const row = (c: Change, at: string | null, state?: Schemas["InboxSimpleChange"]["state"]): Schemas["InboxSimpleChange"] => {
    const key = db ? keyOf(db, c.target.item_id) : undefined;
    return {
      id: c.id, op: c.op, status: c.status, item_id: (c.target.item_id as string) ?? null, item_title: key ? seed(db!, key).title : typeof c.after.title === "string" ? c.after.title : null,
      document_id: c.document_id, by: c.by, by_name: c.by_name, at: c.at, decided_by: c.decided_by, decided_at: c.decided_at,
      reason: c.reason, decision_reason: c.decision_reason, state: state ?? (!seen || (at && at > seen) ? "new" : "open"),
      from_meeting: c.from_meeting ?? null,
    };
  };
  return {
    simple_proposals: changes.filter((c) => c.status === "proposed" && (db ? route(db, who, c) : c.routed_to).includes(me)).map((c) => row(c, c.at)),
    simple_decisions: changes
      .filter((c) => c.by === me && (c.status === "accepted" || c.status === "declined"))
      .map((c) => row(c, c.decided_at, !seen || (c.decided_at ?? "") > seen ? undefined : "done")),
    // S3b: the mock's roadmaps name no required reviewers, so no draft waits on anyone.
    simple_approvals: [],
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
      if (!goal) return json(422, { detail: "target.where.value: a goal's id" });
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
    const after: Values = { title, horizon, goal_ids: goal ? [goalId(goal)] : [], ...(quarter ? { quarter } : {}) };
    if (typeof a.outcome === "string" && a.outcome.trim()) after.outcome = a.outcome.trim();
    // An item added with its milestone (additions._plan: after.milestone {name, date}).
    const m = a.milestone as { name?: unknown; date?: unknown } | null | undefined;
    if (m && typeof m === "object") {
      const name = String(m.name ?? "").trim();
      if (!name || name.length > 200) return json(422, { detail: "after.milestone.name: 1 to 200 characters" });
      after.milestone = { name, date: typeof m.date === "string" ? m.date : null, date_source: typeof m.date === "string" ? "typed" : null };
    }
    return { target, before: {}, after, roadmap, applies: canEditRoadmap(db, roadmap, ctx) };
  }
  const key = keyOf(db, target.item_id);
  if (!key) return json(404, { detail: "No such roadmap item" });
  const s = seed(db, key);
  if (!s.draft || closed(s)) return json(422, { detail: "target.item_id: an open draft item" });
  const applies = canDecideItem(db, s, ctx);
  if (body.op === "keep_both") {
    if (!!s.kept_both !== !!body.before?.kept_both) return conflict(db, ctx, { kept_both: !!s.kept_both }, [String(target.item_id)], "Changed since you saw it");
    return { target, before: { kept_both: false }, after: { kept_both: true }, roadmap: s.roadmap, applies };
  }
  if (target.into_id) {
    const into = keyOf(db, target.into_id);
    const kept = into ? seed(db, into) : undefined;
    if (!kept || into === key || kept.roadmap !== s.roadmap || closed(kept)) return json(422, { detail: "target.into_id: another live item of the same roadmap" });
    return { target, before: { status: "draft" }, after: { status: "merged", merged_into: { id: target.into_id, code: kept.key, title: kept.title } }, roadmap: s.roadmap, applies };
  }
  if (typeof target.feature_id === "string" && target.feature_id) {
    // As the API: the draft becomes the feature's item (linked, kept beside look-alikes), still a draft.
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
  if (!s || !s.draft || closed(s)) return false;
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
  snaps[c.id] = structuredClone([s, ...(intoKey ? [seed(db, intoKey)] : []), ...dependents.filter((x) => x.key !== intoKey)]);
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
  s.merged_into = kept.key;
}

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
import { stableUuid } from "./ids";
import { priorityAfter, priorityBefore, prioritiesOut } from "./simple-priorities";
import {
  canDecideItem,
  canEditRoadmap,
  closed,
  deciderIds,
  draftChanges,
  GOALS,
  goalId,
  lookalikes,
  ownDates,
  ROADMAP_SLUGS,
  roadmapId,
  roadmapOut,
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
  accept_risk: ["risk"],
  // S6: a draft item confirmed (changes.py confirm_item).
  confirm_item: ["draft"],
};
const FIXES = ["shift_dependents", "move_dependency"];
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
function decidesChange(db: SimpleDb, ctx: SimpleChangesCtx, c: Pick<Change, "op" | "target"> & Partial<Pick<Change, "routed_to">>): boolean {
  if (KEY_DATE_OPS.includes(c.op)) {
    const rm = roadmapOfDoc(db, c.target.document_id);
    return ctx.role === "owner" || (c.routed_to ?? []).includes(ctx.id) || (!!rm && canEditRoadmap(db, rm, ctx));
  }
  if (c.op === "add_item" && !keyOf(db, c.target.item_id)) return canEditRoadmap(db, slugOf(c.target.roadmap_id) ?? "", ctx);
  return decides(db, ctx, c.target.item_id);
}

/** changes.current_route: who decides an open proposal now; else its stored route. */
function route(db: SimpleDb, ctx: Pick<SimpleChangesCtx, "owners" | "roles">, c: Change): string[] {
  if (c.status !== "proposed" || KEY_DATE_OPS.includes(c.op)) return c.routed_to;
  if (c.op === "add_item" && !keyOf(db, c.target.item_id)) {
    const decider = db.deciders?.[slugOf(c.target.roadmap_id) ?? ""];
    return decider ? [decider] : ctx.owners;
  }
  const key = c.target.item_id ? keyOf(db, c.target.item_id) : undefined;
  if (!key) return ctx.owners;
  const ids = deciderIds(db, seed(db, key), ctx.roles);
  return ids.length ? ids : ctx.owners;
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
    else if (f === "draft") out[f] = !!s.draft;
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
  if ("outcome" in values) s.outcome = (values.outcome as string | null) ?? null;
  if ("risk" in values) {
    const kept = (s.risks ?? []).filter((r) => !(r.flag === target.flag && (r.subject ?? null) === (target.subject ?? null)));
    const risk = values.risk as { flag: never; note: string; subject?: string | null } | null;
    s.risks = risk ? [...kept, risk] : kept;
  }
}

function touched(c: Pick<Change, "op" | "target" | "after" | "before">): string[] {
  return FIXES.includes(c.op) ? [...new Set([...Object.keys(c.after), ...Object.keys(c.before)])] : [String(c.target.item_id)];
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
  };
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
          submitted_at: null, submitted_by: null, decider_approved: false, waiting_on: [], approved_at: null, blocked_by: [],
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
      return { id: c.id, op: c.op, item_id: (c.target.item_id as string) ?? null, by: c.by, by_name: c.by_name, at: c.at, session_kind: kind, in_meeting: kind === "meeting" };
    });
}

function draftOut(db: SimpleDb, ctx: SimpleChangesCtx, d: MockDraft): Schemas["SimpleDraftOut"] {
  const edits = canEditRoadmap(db, d.roadmap, ctx);
  const decider = db.deciders?.[d.roadmap];
  return {
    ...d.out, changes: draftChanges(db, d.out.id), change_log: changeLog(db, d.out.id),
    can_submit: d.out.status === "working" && edits,
    can_resume: d.out.status === "working" && (d.out.created_by === ctx.id || decider === ctx.id),
    can_approve: d.out.status === "submitted" && edits,
    can_withdraw: d.out.status === "submitted" && (d.out.created_by === ctx.id || edits),
  };
}

/** /v1/simple/drafts (drafts.listing, submit, approve, resume). */
function routeDrafts(db: SimpleDb, ctx: SimpleChangesCtx, m: string, p: string[]): Response | null {
  const now = iso(mockNowMs());
  const open = (db.drafts ?? []).filter((d) => ["working", "submitted"].includes(d.out.status));
  if (!p[3] && m === "GET") return json(200, open.filter((d) => seesDraft(d, ctx, db)).map((d) => draftOut(db, ctx, d)));
  const d = (db.drafts ?? []).find((x) => x.out.id === p[3] && seesDraft(x, ctx, db));
  if (!d) return json(404, { detail: "No such draft" });
  if (!p[4] && m === "GET") return json(200, draftOut(db, ctx, d));
  if (m !== "POST") return null;
  if (p[4] === "submit") {
    if (!canEditRoadmap(db, d.roadmap, ctx)) return json(403, { detail: "Only an owner or the roadmap's decider (with none, its owner) submits" });
    if (d.out.status !== "working") return json(409, { detail: `This draft is ${d.out.status} already` });
    if (!draftChanges(db, d.out.id)) return json(422, { detail: "Nothing to submit: the draft has no changes" });
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
  if (spec.adds) target[spec.id] = crypto.randomUUID();
  const id = String(target[spec.id] ?? "");
  const stored = (db.targets ??= {})[id] ?? {};
  // S6 (./simple-priorities.ts): a pin and an estimate are compared and stored as targets.py does.
  const ranking = body.op === "override_priority" || body.op === "estimate_feature";
  const after = ranking ? priorityAfter(body.op, body.after ?? {}) : { ...body.after };
  if (typeof after === "string") return json(422, { detail: after });
  const before: Values = ranking
    ? priorityBefore(db, keyOf(db, target.item_id)!, body.op, id)
    : spec.adds ? {} : Object.fromEntries(Object.keys(body.before).map((k) => [k, stored[k] ?? null]));
  const seen = ranking ? Object.fromEntries(Object.keys(before).map((k) => [k, body.before[k] ?? null])) : body.before;
  if (!spec.adds && !same(before, seen)) return conflict(db, ctx, before, [id], "Changed since you saw it");
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

function writeTarget(db: SimpleDb, c: Change, values: Values, undo = false): void {
  const spec = TARGETS[c.op];
  const id = String(c.target[spec.id]);
  const targets = (db.targets ??= {});
  if (spec.adds && undo) delete targets[id];
  else targets[id] = { ...(targets[id] ?? {}), ...values };
}

/** The new [start, end] of every item a fix moves (changes._fix_plan). */
function fixPlan(db: SimpleDb, op: string, itemId: string, depId: string): Record<string, [string, string]> {
  const items = new Map(roadmapOut(db, "owner", new URLSearchParams())!.items.map((i) => [i.id, i]));
  const item = items.get(itemId)!;
  const dep = items.get(depId)!;
  if (op === "move_dependency") {
    const end = addDays(item.start.date, -1);
    return { [depId]: [addDays(dep.start.date, days(dep.end.date, end)), end] };
  }
  const shift = days(item.start.date, addDays(dep.end.date, 1));
  const moves: Record<string, [string, string]> = { [itemId]: [addDays(item.start.date, shift), addDays(item.end.date, shift)] };
  const queue = [itemId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of items.get(cur)!.needed_by) {
      const next = items.get(n);
      if (!next || moves[n] || next.status === "cut") continue;
      if (next.start.date <= moves[cur][1]) {
        const delta = days(next.start.date, addDays(moves[cur][1], 1));
        moves[n] = [addDays(next.start.date, delta), addDays(next.end.date, delta)];
        queue.push(n);
      }
    }
  }
  return moves;
}

function apply(db: SimpleDb, c: Change, values: Values, undo = false): void {
  if (FIXES.includes(c.op)) for (const [id, v] of Object.entries(values)) write(db, keyOf(db, id)!, v as Values, c.target);
  else write(db, keyOf(db, c.target.item_id)!, values, c.target);
  if (c.op === "accept_date_suggestion") {
    const s = db.suggestions.find((x) => x.id === c.target.suggestion_id);
    if (s && !undo && s.status === "open") Object.assign(s, { status: c.target.edited ? "edited" : "accepted", decided_at: iso(mockNowMs()) });
    if (s && undo && (s.status === "accepted" || s.status === "edited")) Object.assign(s, { status: "open", decided_by: null, decided_at: null });
  }
}

function current(db: SimpleDb, c: Change, like: Values): Values {
  if (FIXES.includes(c.op)) return Object.fromEntries(Object.entries(like).map(([id, v]) => [id, read(db, keyOf(db, id)!, Object.keys(v as Values), c.target)]));
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
  const now = iso(mockNowMs());
  if (KEY_DATE_OPS.includes(body.op)) {
    const rm = roadmapOfDoc(db, body.target.document_id);
    const applies = !!rm && canEditRoadmap(db, rm, ctx);
    let session: Session | undefined;
    if (applies) session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
    return createKeyDate(db, ctx, body, session, applies);
  }
  const target: Values = { ...body.target };
  const key = TARGETS[body.op] ? "" : keyOf(db, target.item_id);
  if (key === undefined) return json(404, { detail: "No such roadmap item" });
  const applies = decides(db, ctx, target.item_id);
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
  let before: Values;
  let after: Values;
  if (FIXES.includes(body.op)) {
    const dep = String(target.subject ?? "");
    const deps = roadmapOut(db, "owner", new URLSearchParams())!.items.find((i) => i.id === target.item_id)?.depends_on ?? [];
    if (!deps.includes(dep)) return json(422, { detail: "target.subject: an item the target depends on" });
    const stale: Values = {};
    for (const id of [String(target.item_id), dep]) {
      const given = body.before[id] as Values | undefined;
      if (!given || !("start_date" in given) || !("end_date" in given)) return json(422, { detail: `before.${id}: start_date and end_date as seen` });
      const now_ = read(db, keyOf(db, id)!, ["start_date", "end_date"], target);
      if (!same(normal(["start_date", "end_date"], given), now_)) stale[id] = now_;
    }
    if (Object.keys(stale).length) return conflict(db, ctx, stale, Object.keys(stale), "Changed since you saw it");
    const moves = fixPlan(db, body.op, String(target.item_id), dep);
    before = Object.fromEntries(Object.keys(moves).map((id) => [id, read(db, keyOf(db, id)!, ["start_date", "end_date", "date_source"], target)]));
    after = Object.fromEntries(Object.entries(moves).map(([id, [s, e]]) => [id, { start_date: s, end_date: e, date_source: "typed" }]));
  } else {
    const fields = FIELDS[body.op];
    const missing = fields.filter((f) => !(f in body.before));
    if (missing.length) return json(422, { detail: `before: ${missing.join(", ")} as you saw them` });
    const now_ = read(db, key, fields, target);
    // A suggestion accepted after the item got dates is "outdated" (S2-minor).
    const lead = body.op === "accept_date_suggestion" ? "outdated" : "Changed since you saw it";
    if (!same(normal(fields, body.before), now_)) return conflict(db, ctx, now_, [String(target.item_id)], lead);
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
      after = { start_date: s.start_date, end_date: s.end_date, date_source: "accepted" };
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
      if (!seed(db, key).draft) return json(422, { detail: "Only a draft item is confirmed" });
      after = { draft: false };
    }
    else if (body.op === "edit_title") {
      const title = String(a.title ?? "").trim();
      if (!title) return json(422, { detail: "after.title: 1 to 200 characters" });
      after = { title };
    } else if (body.op === "edit_outcome") after = { outcome: a.outcome ?? null };
    else {
      const note = String((a.risk as Values | undefined)?.note ?? "").trim();
      if (!note) return json(422, { detail: "after.risk.note: 1 to 500 characters" });
      target.subject = target.subject ?? null;
      after = { risk: { flag: target.flag, subject: target.subject, note, by: ctx.id, at: now } };
    }
    before = read(db, key, stored, target);
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
    const copy = structuredClone({ items: db.items, own: db.own, suggestions: db.suggestions });
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
  if (p[2] === "drafts") return routeDrafts(db, ctx, m, p);
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
      .filter((c) => sees(db, ctx, c))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return json(200, rows.map((c) => view(db, ctx, c)));
  }
  const c = (db.changes ?? []).find((x) => x.id === p[3]);
  if (m !== "POST" || !["undo", "accept", "decline"].includes(p[4] ?? "")) return null;
  if (!c) return json(404, { detail: "No such change" });
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
  else if (p[4] === "accept") {
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
    const w = simpleWindows(new Date(mockNowMs()).toISOString().slice(0, 10));
    let horizon: SeedItem["horizon"] = "next";
    let goal: string | undefined;
    let quarter: { start: string; end: string } | null = null;
    if (where?.kind === "goal") {
      goal = Object.keys(GOALS).find((k) => goalId(k) === value || k === value);
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
    db.items.push({
      key, title: String(a.title), horizon: a.horizon as SeedItem["horizon"], roadmap, goal: goalKey,
      track: db.items.find((x) => x.roadmap === roadmap && x.track)?.track, draft: true, outcome: typeof a.outcome === "string" ? a.outcome : null,
      drafting_until: mockNowMs() + DRAFTING_MS, quarter: (a.quarter as { start: string; end: string } | undefined) ?? undefined,
      looks_like: lookalikes(db, String(a.title), roadmap),
    });
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

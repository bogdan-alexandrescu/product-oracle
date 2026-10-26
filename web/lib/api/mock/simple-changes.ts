/**
 * Simple S3a (#723): the change engine (/v1/simple/sessions, /v1/simple/changes), as
 * api/oracle/simple/changes.py serves it, over the mock's company-wide roadmap
 * (./simple-roadmap.ts).
 *
 * The mock's roadmaps name no decider and no track owner, so owners apply every change and
 * approvers and commenters propose it to the company's owners; viewers are refused. A
 * change whose `before` differs from the stored values answers 409 with the current values
 * and who changed them last; undo works for its author, in its open session, while the item
 * still holds the change's `after`. Sessions close after 30 minutes without a change.
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";
import { roadmapOut, type SimpleDb } from "./simple-roadmap";

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
};
const FIXES = ["shift_dependents", "move_dependency"];
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

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

/** The stored values of one item's fields (the API's changes.read). */
function read(db: SimpleDb, key: string, fields: string[], target: Values): Values {
  const s = seed(db, key);
  const own = db.own[key];
  const out: Values = {};
  for (const f of fields) {
    if (f === "start_date") out[f] = own?.start ?? null;
    else if (f === "end_date") out[f] = own?.end ?? null;
    else if (f === "date_source") out[f] = own ? (own.source ?? "accepted") : null;
    else if (f === "horizon") out[f] = s.horizon;
    else if (f === "position") out[f] = s.position ?? db.items.indexOf(s);
    else if (f === "cut") out[f] = s.status === "cut";
    else if (f === "title") out[f] = s.title;
    else if (f === "outcome") out[f] = s.outcome ?? null;
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
    undone,
    can_decide: c.status === "proposed" && ctx.role === "owner",
    can_undo: c.status === "applied" && c.by === ctx.id && !undone && !!s && !s.closed_at && !idle(s),
  };
}

function sees(db: SimpleDb, ctx: SimpleChangesCtx, c: Change): boolean {
  if (ctx.role === "owner" || c.by === ctx.id || c.routed_to.includes(ctx.id)) return true;
  return (db.sessions ?? []).some((s) => s.id === c.session_id && s.started_by === ctx.id);
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
    if (s && !undo && s.status === "open") Object.assign(s, { status: "accepted", decided_at: iso(mockNowMs()) });
    if (s && undo && s.status === "accepted") Object.assign(s, { status: "open", decided_by: null, decided_at: null });
  }
}

function current(db: SimpleDb, c: Change, like: Values): Values {
  if (FIXES.includes(c.op)) return Object.fromEntries(Object.entries(like).map(([id, v]) => [id, read(db, keyOf(db, id)!, Object.keys(v as Values), c.target)]));
  return read(db, keyOf(db, c.target.item_id)!, Object.keys(like), c.target);
}

function normal(fields: string[], values: Values): Values {
  return Object.fromEntries(fields.map((f) => [f, values[f] ?? null]));
}

async function create(db: SimpleDb, ctx: SimpleChangesCtx, body: Schemas["SimpleChangeIn"]): Promise<Response> {
  const now = iso(mockNowMs());
  const target: Values = { ...body.target };
  const key = keyOf(db, target.item_id);
  if (!key) return json(404, { detail: "No such roadmap item" });
  const applies = ctx.role === "owner";
  let session: Session | undefined;
  if (body.session_id) {
    session = (db.sessions ?? []).find((s) => s.id === body.session_id && s.started_by === ctx.id);
    if (!session) return json(404, { detail: "No such session of yours" });
    if (session.closed_at || idle(session)) {
      session.closed_at ??= now;
      return json(409, { detail: "This session is closed; start a new one" });
    }
  } else if (applies) session = openEditing(db, ctx.id) ?? newSession(db, ctx.id, "editing");
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
    if (!same(normal(fields, body.before), now_)) return conflict(db, ctx, now_, [String(target.item_id)], "Changed since you saw it");
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
      stored = ["start_date", "end_date", "date_source"];
    } else if (body.op === "change_horizon") {
      if (!["now", "next", "later"].includes(String(a.horizon))) return json(422, { detail: "after.horizon: now, next or later" });
      after = { horizon: a.horizon };
    } else if (body.op === "reorder") after = { position: Number(a.position) };
    else if (body.op === "cut" || body.op === "restore") after = { cut: body.op === "cut" };
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
    id: crypto.randomUUID(), session_id: session?.id ?? null, document_id: stableUuid(`simple-doc/${seed(db, key).roadmap}`), op: body.op, target, before, after,
    status: applies ? "applied" : "proposed", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now,
    decided_by: null, decided_at: null, reason: body.reason ?? null, decision_reason: null,
    routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
  };
  let flags: Schemas["SimpleItemFlags"][];
  if (applies) {
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
  if (p[1] !== "simple" || (p[2] !== "sessions" && p[2] !== "changes")) return null;
  const m = req.method;
  const now = iso(mockNowMs());
  if (m === "POST" && ctx.role === "viewer") return json(403, { detail: "Requires the commenter role" });
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
    const now_ = current(db, c, c.after);
    if (!same(now_, c.after)) return conflict(db, ctx, now_, touched(c), "Changed since");
    apply(db, c, c.before, true);
    const u: Change = { ...c, id: crypto.randomUUID(), before: c.after, after: c.before, status: "undone", by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone", at: now, undoes_id: c.id, routed_to: [], decided_by: null, decided_at: null };
    db.changes!.push(u);
    s.last_change_at = now;
    return json(201, { change: view(db, ctx, u), flags: flagsFor(db, touched(c)) });
  }
  if (RANK[ctx.role] < RANK.owner) return json(403, { detail: "Only an owner or the roadmap's decider (with no decider, its owner) decides proposals" });
  if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
  const body = (await req.json().catch(() => ({}))) as { reason?: string | null };
  if (p[4] === "accept") {
    const now_ = current(db, c, c.before);
    if (!same(now_, c.before)) return conflict(db, ctx, now_, touched(c), "outdated");
    apply(db, c, c.after);
  }
  Object.assign(c, { status: p[4] === "accept" ? "accepted" : "declined", decided_by: ctx.id, decided_at: now, decision_reason: body.reason ?? null });
  return json(200, { change: view(db, ctx, c), flags: flagsFor(db, touched(c)) });
}

/** Inbox rows (changes.inbox_rows): proposals waiting for me, decisions on mine. */
export function simpleInboxRows(db: SimpleDb | undefined, me: string, seen: string | null): { simple_proposals: Schemas["InboxSimpleChange"][]; simple_decisions: Schemas["InboxSimpleChange"][] } {
  const changes = db?.changes ?? [];
  const row = (c: Change, at: string | null, state?: Schemas["InboxSimpleChange"]["state"]): Schemas["InboxSimpleChange"] => {
    const key = db ? keyOf(db, c.target.item_id) : undefined;
    return {
      id: c.id, op: c.op, status: c.status, item_id: (c.target.item_id as string) ?? null, item_title: key ? seed(db!, key).title : null,
      document_id: c.document_id, by: c.by, by_name: c.by_name, at: c.at, decided_by: c.decided_by, decided_at: c.decided_at,
      reason: c.reason, decision_reason: c.decision_reason, state: state ?? (!seen || (at && at > seen) ? "new" : "open"),
    };
  };
  return {
    simple_proposals: changes.filter((c) => c.status === "proposed" && c.routed_to.includes(me)).map((c) => row(c, c.at)),
    simple_decisions: changes
      .filter((c) => c.by === me && (c.status === "accepted" || c.status === "declined"))
      .map((c) => row(c, c.decided_at, !seen || (c.decided_at ?? "") > seen ? undefined : "done")),
  };
}

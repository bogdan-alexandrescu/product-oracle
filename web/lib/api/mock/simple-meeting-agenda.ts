/**
 * agenda-sheet (mk-edit-meetings-tracks, proposal b, the owner's pick Nov 5): the mock of a
 * live meeting's agenda rows and POST /v1/simple/meetings/{id}/agenda, as
 * oracle.simple.meetings (_agenda_out, edit_agenda): add a feature or a typed topic, rename,
 * move, remove, Undo the sheet's batch; an owner or the PRD's decider saves, an approver who
 * is not the decider proposes (the decider accepts, the proposer withdraws), others read.
 */
import type { Schemas } from "@/lib/api/client";

type Role = "viewer" | "commenter" | "approver" | "owner";
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
export const FEATURE_MINS = 10;
export const TOPIC_MINS = 5;

/** One stored row: a feature of the PRD (its id is the feature's) or a typed topic. */
export type AgendaRowDb = { id: string; feature_id: string | null; title: string | null; was?: string | null; mins: number; by?: string | null };
/** One op's clause for the Undo line (meetings._agenda_apply): what it did to which item. */
export type AgendaClause = { op: "add" | "remove" | "move" | "rename"; id: string; name: string; dir?: "up" | "down"; to?: string };
export type AgendaOp = Schemas["SimpleAgendaEditIn"];
/** What a meeting keeps beside the chat's next and skipped (meetings.agenda's other keys). */
export type AgendaSheetDb = {
  items?: AgendaRowDb[];
  done?: string[];
  before?: AgendaRowDb[];
  batch?: string | null;
  clauses?: AgendaClause[];
  words?: string[];
  proposal?: { by: string; decider: string | null; ops: AgendaOp[]; said: AgendaClause[]; words: string[]; dropped: string[] } | null;
};

export type AgendaCtx = {
  me: { id: string; role: Role };
  nameOf: (id: string) => string;
  features: { id: string; title: string }[];
  decider: string | null;
  skipped: string[];
  live: boolean;
};

class AgendaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function agendaRight(ctx: AgendaCtx): "save" | "propose" | "read" {
  if (ctx.me.role === "owner" || (ctx.me.id === ctx.decider && RANK[ctx.me.role] >= RANK.commenter)) return "save";
  return RANK[ctx.me.role] >= RANK.approver ? "propose" : "read";
}

function rowsOf(s: AgendaSheetDb, ctx: AgendaCtx): AgendaRowDb[] {
  if (s.items) return s.items.map((x) => ({ ...x }));
  return ctx.features.map((f) => ({ id: f.id, feature_id: f.id, title: null, was: f.title, mins: FEATURE_MINS }));
}

/** A row's name: its own, its feature's, else the name its feature last had here (meetings._row_name). */
function rowName(x: AgendaRowDb, titles: Map<string, string>, none: string): string {
  return x.title || titles.get(x.feature_id ?? "") || x.was || none;
}

/** The batch's clauses as words; a move and a rename of one item read as one clause (meetings._agenda_words). */
export function agendaWords(clauses: AgendaClause[]): string[] {
  type Out = Omit<AgendaClause, "op"> & { op: AgendaClause["op"] | "both" };
  const out: Out[] = [];
  for (const c of clauses) {
    const same = c.op === "move" || c.op === "rename" ? out.find((o) => o.id === c.id && (o.op === "move" || o.op === "rename" || o.op === "both")) : undefined;
    if (!same) out.push({ ...c });
    else if (c.op === "move") Object.assign(same, { op: same.op !== "move" ? "both" : "move", dir: c.dir });
    else Object.assign(same, { op: same.op !== "rename" ? "both" : "rename", to: c.to });
  }
  return out.map((c) =>
    c.op === "add" ? `added ${c.name}` : c.op === "remove" ? `removed ${c.name}` : c.op === "move" ? `moved ${c.name} ${c.dir}` : c.op === "rename" ? `renamed ${c.name} to ${c.to}` : `moved ${c.name} ${c.dir} and renamed it`,
  );
}

function states(s: AgendaSheetDb, ctx: AgendaCtx, rows: AgendaRowDb[]): Schemas["SimpleAgendaRow"]["state"][] {
  const done = new Set(s.done ?? []);
  const skipped = new Set(ctx.skipped);
  let now = false;
  return rows.map((x) => {
    if (x.feature_id && done.has(x.feature_id)) return "done";
    if (skipped.has(x.id) || (x.feature_id && skipped.has(x.feature_id))) return "skipped";
    if (!now) {
      now = true;
      return "now";
    }
    return "next";
  });
}

export function agendaRowsOut(s: AgendaSheetDb, ctx: AgendaCtx): Pick<Schemas["SimpleAgenda"], "items" | "addable" | "batch" | "words" | "proposal" | "decider"> {
  const rows = rowsOf(s, ctx);
  const titles = new Map(ctx.features.map((f) => [f.id, f.title]));
  const st = states(s, ctx, rows);
  const on = new Set(rows.map((x) => x.feature_id));
  const p = s.proposal;
  return {
    items: rows.map((x, i) => ({
      id: x.id,
      kind: x.feature_id ? "feature" : "topic",
      feature_id: x.feature_id,
      title: rowName(x, titles, "Untitled"),
      mins: x.mins || FEATURE_MINS,
      by_name: x.by ? ctx.nameOf(x.by) : null,
      state: st[i]!,
    })),
    addable: ctx.features.filter((f) => !on.has(f.id)).map((f) => ({ id: f.id, title: f.title })),
    batch: s.batch ?? null,
    words: [...(s.words ?? [])],
    decider: ctx.decider ? { id: ctx.decider, name: ctx.nameOf(ctx.decider) } : null,
    proposal: p ? { by: { id: p.by, name: ctx.nameOf(p.by) }, decider: p.decider ? { id: p.decider, name: ctx.nameOf(p.decider) } : null, words: [...p.words], dropped: [...(p.dropped ?? [])] } : null,
  };
}

function applyOp(s: AgendaSheetDb, ctx: AgendaCtx, rows: AgendaRowDb[], by: string, b: AgendaOp): AgendaClause {
  const titles = new Map(ctx.features.map((f) => [f.id, f.title]));
  const st = new Map(rows.map((x, i) => [x.id, states(s, ctx, rows)[i]!]));
  if (b.op === "add") {
    if (b.feature_id) {
      const t = titles.get(b.feature_id);
      if (!t) throw new AgendaError(404, "That feature is not in the meeting's PRD");
      if (rows.some((x) => x.feature_id === b.feature_id)) throw new AgendaError(409, "That feature is on the agenda already");
      rows.push({ id: b.feature_id, feature_id: b.feature_id, title: null, was: t, mins: FEATURE_MINS, by });
      return { op: "add", id: b.feature_id, name: t };
    }
    const title = (b.title ?? "").trim();
    if (!title) throw new AgendaError(422, "Give the topic a name");
    const id = crypto.randomUUID();
    rows.push({ id, feature_id: null, title, mins: TOPIC_MINS, by });
    return { op: "add", id, name: title };
  }
  const x = rows.find((r) => r.id === b.item_id);
  if (!x) throw new AgendaError(404, "That item is not on the agenda");
  if (st.get(x.id) === "done" || st.get(x.id) === "now") throw new AgendaError(409, "The current item and done ones stay where they are");
  const was = rowName(x, titles, "the item");
  if (b.op === "rename") {
    const title = (b.title ?? "").trim();
    if (!title) throw new AgendaError(422, "Give the item a name");
    x.title = title;
    return { op: "rename", id: x.id, name: was, to: title };
  }
  if (b.op === "remove") {
    rows.splice(rows.indexOf(x), 1);
    return { op: "remove", id: x.id, name: was };
  }
  let first = 0;
  rows.forEach((y, k) => {
    if (st.get(y.id) === "done" || st.get(y.id) === "now") first = k + 1;
  });
  const at = rows.indexOf(x);
  const to = Math.max(first, Math.min(b.to ?? 0, rows.length - 1));
  rows.splice(at, 1);
  rows.splice(to, 0, x);
  return { op: "move", id: x.id, name: was, dir: to < at ? "up" : "down" };
}

/** One op of the sheet (meetings.edit_agenda); returns the status and detail of a refusal, else null. */
export function editAgenda(s: AgendaSheetDb, ctx: AgendaCtx, b: AgendaOp): { status: number; detail: string } | null {
  try {
    if (!ctx.live) throw new AgendaError(409, "This meeting has ended");
    const right = agendaRight(ctx);
    if (right === "read" || RANK[ctx.me.role] < RANK.commenter) throw new AgendaError(403, "Only an owner or the PRD's decider changes the agenda");
    const rows = rowsOf(s, ctx);
    const p = s.proposal;
    if (b.op === "withdraw") {
      if (!p || (p.by !== ctx.me.id && right !== "save")) throw new AgendaError(404, "No proposal to withdraw");
      s.proposal = null;
    } else if (b.op === "accept") {
      if (right !== "save" || !p) throw new AgendaError(p ? 403 : 404, "Only the decider accepts the proposal");
      // The accept is the decider's batch: their sheet named it, so their Undo line shows.
      s.before = rows.map((x) => ({ ...x }));
      s.batch = b.batch || `accept-${crypto.randomUUID()}`;
      const clauses: AgendaClause[] = [];
      for (const o of p.ops) {
        try {
          clauses.push(applyOp(s, ctx, rows, p.by, o));
        } catch {
          // an item the proposal named is gone since
        }
      }
      Object.assign(s, { items: rows, clauses, words: agendaWords(clauses), proposal: null });
    } else if (b.op === "undo") {
      if (right !== "save" || !s.before) throw new AgendaError(404, "Nothing to undo");
      if ((b.batch ?? null) !== (s.batch ?? null)) throw new AgendaError(409, "Someone changed the agenda since");
      Object.assign(s, { items: s.before, clauses: [], words: [], batch: null });
      delete s.before;
    } else if (right === "propose") {
      // An op of the earlier proposal whose item is gone since is dropped, and the proposal says so.
      const mine = p && p.by === ctx.me.id ? p : null;
      const trial = rowsOf(s, ctx);
      const kept: AgendaOp[] = [];
      const clauses: AgendaClause[] = [];
      const dropped = [...(mine?.dropped ?? [])];
      (mine?.ops ?? []).forEach((o, k) => {
        try {
          clauses.push(applyOp(s, ctx, trial, ctx.me.id, o));
          kept.push(o);
        } catch (e) {
          if (!(e instanceof AgendaError)) throw e;
          const said = mine?.said?.[k];
          if (said) dropped.push(...agendaWords([said]));
        }
      });
      clauses.push(applyOp(s, ctx, trial, ctx.me.id, b));
      s.proposal = { by: ctx.me.id, decider: ctx.decider, ops: [...kept, b], said: clauses, words: agendaWords(clauses), dropped };
    } else {
      if (s.batch !== (b.batch ?? null) || !s.before) Object.assign(s, { before: rows.map((x) => ({ ...x })), batch: b.batch ?? null, clauses: [] });
      const clauses = [...(s.clauses ?? []), applyOp(s, ctx, rows, ctx.me.id, b)];
      Object.assign(s, { items: rows, clauses, words: agendaWords(clauses) });
    }
    return null;
  } catch (e) {
    if (e instanceof AgendaError) return { status: e.status, detail: e.message };
    throw e;
  }
}

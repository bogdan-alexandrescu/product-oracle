/**
 * Simple S5 (#723): one-pagers, as api/oracle/simple/one_pager.py serves them:
 * GET /v1/simple/one-pagers/{doc} (and .../pdf), and the change engine's `edit_line` op on
 * POST /v1/simple/changes with its accept, decline and undo. One invented PRD,
 * "guided-setup", version 3, its six fallback blocks; each line names its source sections.
 *
 * Who (D4, D-a): owners and the PRD's decider (none in the default seed) apply a line edit
 * into the PRD's one shared working draft with a section patch for EVERY source section of
 * the line; approvers and commenters propose it to the decider, else the company's owners;
 * viewers read. Those who see the draft (owners, its people) read the edited lines and the
 * margin notes; everyone else the published lines and a `changes_in_review` count. Undo
 * works for the change's author while its session is open.
 */
import type { Schemas } from "@/lib/api/client";
import { mockNowMs } from "./clock";
import { stableUuid } from "./ids";

type Role = Schemas["Me"]["role"];
type Change = Schemas["SimpleChangeOut"];
type Line = Schemas["OnePagerLine"];
type Patch = Schemas["OnePagerSectionPatch"];

export interface OnePagerCtx {
  id: string;
  role: Role;
  owners: string[];
  names: Record<string, string>;
}

interface Sec {
  key: string;
  heading: string;
  body: string;
}

interface SeedLine {
  id: string;
  text: string;
  keys: string[];
  metric?: { name: string; from: string; to: string };
}

export interface OnePagerDb {
  doc: { id: string; slug: string; title: string };
  version: number;
  sections: Sec[];
  blocks: { key: string; title: string; rules: string; kind: Schemas["OnePagerBlock"]["kind"]; lines: SeedLine[] }[];
  draft: null | { id: string; base: number; participants: string[]; lines: Record<string, string>; sections: Record<string, string> };
  changes: (Change & { session_open: boolean; in_meeting: boolean; meeting_title?: string | null })[];
  /** S8: decided decisions that changed each line (by line id), newest first (./simple-meetings.ts). */
  decisions?: Record<string, { id: string; number: number; title: string }[]>;
  /** S8: the decider approved the draft in a meeting: its title and who it still waits on. */
  approval?: { approved_in: string; waiting_on: { id: string; name: string }[] } | null;
}

const DOC_ID = stableUuid("simple-one-pager-doc");

export function seedOnePager(): OnePagerDb {
  const sections: Sec[] = [
    { key: "problem", heading: "Problem", body: "New workspace admins stall during setup and never invite a teammate in the first week." },
    { key: "who", heading: "Who has it", body: "Admins of new teams with fewer than ten people." },
    { key: "build", heading: "What we will build", body: "- A setup checklist that shows the next step\n- Invite suggestions from the admin's calendar\n- A sample project created on day one" },
    { key: "outcomes", heading: "Outcomes", body: "- Teammate invited in week one from 48% to 65%\n- Setup finished in a day from 30% to 50%" },
    { key: "not-doing", heading: "Not doing", body: "- Single sign-on setup\n- A mobile setup flow" },
    { key: "risks", heading: "Risks and open decisions", body: "- Calendar access may scare admins away\n- Decide whether the sample project can be deleted" },
  ];
  return {
    doc: { id: DOC_ID, slug: "guided-setup", title: "Guided setup" },
    version: 3,
    sections,
    blocks: [
      { key: "problem", title: "Problem and who has it", rules: "At most 60 words", kind: "text", lines: [
        { id: "problem-1", text: "New workspace admins stall during setup and never invite a teammate in the first week. Admins of new teams with fewer than ten people.", keys: ["problem", "who"] },
      ] },
      { key: "bets", title: "What we will build", rules: "3-5 bets", kind: "lines", lines: [
        { id: "bets-1", text: "A setup checklist that shows the next step", keys: ["build"] },
        { id: "bets-2", text: "Invite suggestions from the admin's calendar", keys: ["build"] },
        { id: "bets-3", text: "A sample project created on day one", keys: ["build"] },
      ] },
      { key: "outcomes", title: "Outcomes and how we measure them", rules: "2-4 metrics, from → to", kind: "metrics", lines: [
        { id: "outcomes-1", text: "Teammate invited in week one from 48% to 65%", keys: ["outcomes"], metric: { name: "Teammate invited in week one", from: "48%", to: "65%" } },
        { id: "outcomes-2", text: "Setup finished in a day from 30% to 50%", keys: ["outcomes"], metric: { name: "Setup finished in a day", from: "30%", to: "50%" } },
      ] },
      { key: "not_doing", title: "Not doing", rules: "At most 5 lines", kind: "lines", lines: [
        { id: "not_doing-1", text: "Single sign-on setup", keys: ["not-doing"] },
        { id: "not_doing-2", text: "A mobile setup flow", keys: ["not-doing"] },
      ] },
      { key: "risks", title: "Risks and open decisions", rules: "At most 5", kind: "lines", lines: [
        { id: "risks-1", text: "Calendar access may scare admins away", keys: ["risks"] },
        { id: "risks-2", text: "Decide whether the sample project can be deleted", keys: ["risks"] },
      ] },
      { key: "timeline", title: "Timeline", rules: "The PRD's roadmap slice", kind: "timeline", lines: [] },
    ],
    draft: null,
    changes: [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

function decides(ctx: OnePagerCtx): boolean {
  return ctx.role === "owner";
}

function seesDraft(db: OnePagerDb, ctx: OnePagerCtx): boolean {
  return ctx.role === "owner" || (db.draft?.participants.includes(ctx.id) ?? false);
}

function seedLine(db: OnePagerDb, id: string): SeedLine | undefined {
  return db.blocks.flatMap((b) => b.lines).find((l) => l.id === id);
}

function lineNow(db: OnePagerDb, id: string): string | undefined {
  return db.draft?.lines[id] ?? seedLine(db, id)?.text;
}

function sectionNow(db: OnePagerDb, key: string, sees = true): string {
  return (sees ? db.draft?.sections[key] : undefined) ?? db.sections.find((s) => s.key === key)!.body;
}

/** As the API's one_pager.patch_all: the facts (bullets, else sentences) the old line says
 * are replaced by the new line in its first section and dropped from the others; null when
 * a section holds none of them (the edit is refused, never appended). */
function plain(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}
function patch(body: string, old: string, next: string, first: boolean): string | null {
  const bullets = body.split("\n").map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
  const spans = bullets.length ? bullets : body.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const o = plain(old).replace(/…$/, "");
  const hits = spans.filter((r) => plain(r) && (o.includes(plain(r)) || (o.split(" ").length > 2 && plain(r).includes(o))));
  if (!hits.length) return null;
  let out = body;
  hits.forEach((raw, i) => {
    if (first && i === 0) out = out.replace(raw, next);
    else if (bullets.length) out = out.split("\n").filter((l) => !(l.includes(raw) && /^\s*(?:[-*+]|\d+[.)])\s/.test(l))).join("\n");
    else out = out.replace(new RegExp(raw.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "\\s*"), "");
  });
  return out;
}

/** As the API's metric_of: "name from X to Y". */
function metricOf(text: string): Line["metric"] {
  const m = /^(.*?)[:\s,-]*\s(?:from\s+)?(\S+)\s*(?:→|->|\bto\b)\s*(\S+)/i.exec(text);
  return m ? { name: m[1].trim() || text, from: m[2], to: m[3] } : null;
}

function write(db: OnePagerDb, ctx: OnePagerCtx, lineId: string, values: Record<string, unknown>) {
  db.draft ??= { id: stableUuid(`simple-one-pager-draft-${mockNowMs()}`), base: db.version, participants: [], lines: {}, sections: {} };
  if (!db.draft.participants.includes(ctx.id)) db.draft.participants.push(ctx.id);
  const line = String(values.line);
  if (line === seedLine(db, lineId)?.text) delete db.draft.lines[lineId];
  else db.draft.lines[lineId] = line;
  for (const [k, v] of Object.entries((values.sections ?? {}) as Record<string, { body: string }>)) {
    if (v.body === db.sections.find((s) => s.key === k)?.body) delete db.draft.sections[k];
    else db.draft.sections[k] = v.body;
  }
}

function liveChanges(db: OnePagerDb) {
  const undone = new Set(db.changes.filter((c) => c.status === "undone").map((c) => c.undoes_id));
  return db.changes.filter((c) => (c.status === "applied" || c.status === "accepted") && !undone.has(c.id));
}

function out(db: OnePagerDb, ctx: OnePagerCtx, c: Change): Change {
  return {
    ...c,
    can_decide: c.status === "proposed" && (ctx.role === "owner" || c.routed_to.includes(ctx.id)),
    can_undo: c.status === "applied" && c.by === ctx.id && !db.changes.some((u) => u.undoes_id === c.id),
  };
}

function patches(c: Change): Patch[] {
  const before = (c.before.sections ?? {}) as Record<string, { heading: string; body: string }>;
  return Object.entries((c.after.sections ?? {}) as Record<string, { heading: string; body: string }>).map(([key, v]) => ({
    key, heading: v.heading, before: before[key]?.body ?? "", after: v.body,
  }));
}

function onePager(db: OnePagerDb, ctx: OnePagerCtx): Schemas["OnePagerOut"] {
  const sees = seesDraft(db, ctx);
  const proposals = db.changes.filter((c) => c.status === "proposed");
  const shown = proposals.filter((c) => c.by === ctx.id || ctx.role === "owner" || c.routed_to.includes(ctx.id));
  const live = sees ? liveChanges(db).filter((c) => c.status !== "undone") : [];
  const note = (c: (typeof db.changes)[number], kind: "change" | "proposal"): Schemas["OnePagerNote"] => {
    const lineId = String(c.target.line_id);
    return {
      change_id: c.id, line_id: lineId, kind, by: c.by, by_name: c.by_name, at: c.at, in_meeting: c.in_meeting,
      before: String(c.before.line ?? ""), after: String(c.after.line ?? ""), sections: patches(c),
      can_undo: kind === "change" && c.by === ctx.id && c.session_open,
      can_decide: kind === "proposal" && (ctx.role === "owner" || c.routed_to.includes(ctx.id)),
      adds_feature: lineId.startsWith("bets-"), flow: null, meeting_title: c.meeting_title ?? null,
    };
  };
  const notes = [...live.map((c) => note(c, "change")), ...shown.map((c) => note(c, "proposal"))];
  const proposed = new Set(notes.filter((n) => n.kind === "proposal").map((n) => n.line_id));
  const hiddenDraft = !sees && db.draft ? Object.keys(db.draft.lines).length : 0;
  const owner = ctx.owners[0];
  return {
    document: db.doc,
    version: db.version,
    published_at: "2026-10-20T15:00:00Z",
    owner: owner ? { id: owner, name: ctx.names[owner] ?? "Owner" } : null,
    decider: null,
    span_start: "2026-10-05",
    span_end: "2027-02-26",
    built_by: "oracle",
    built_at: "2026-10-20T15:05:00Z",
    blocks: db.blocks.map((b) => ({
      key: b.key, title: b.title, rules: b.rules, kind: b.kind,
      lines: b.lines.map((l): Line => {
        const edited = sees && db.draft?.lines[l.id] !== undefined;
        const text = edited ? db.draft!.lines[l.id] : l.text;
        return {
          id: l.id, text, source_keys: l.keys, metric: edited && b.kind === "metrics" ? metricOf(text) : l.metric ?? null,
          state: edited ? "edited" : proposed.has(l.id) ? "proposal" : "published",
          decisions: [...(db.decisions?.[l.id] ?? [])],
        };
      }),
    })),
    timeline: [
      { id: stableUuid("op-item-1"), title: "Setup checklist", horizon: "now", start: "2026-10-05", end: "2026-11-27", estimated: false },
      { id: stableUuid("op-item-2"), title: "Calendar invites", horizon: "next", start: "2026-11-30", end: "2027-01-29", estimated: true },
      { id: stableUuid("op-item-3"), title: "Sample project", horizon: "later", start: "2027-01-04", end: "2027-02-26", estimated: true },
    ],
    sections: db.sections.map((s) => ({ key: s.key, heading: s.heading, body: sectionNow(db, s.key, sees) })),
    notes,
    draft: sees && db.draft
      ? { id: db.draft.id, status: "working", changes: liveChanges(db).length, base_version: db.draft.base, decider_approved: !!db.approval, waiting_on: db.approval?.waiting_on ?? [], can_submit: decides(ctx), approved_in: db.approval?.approved_in ?? null }
      : null,
    changes_in_review: hiddenDraft + (proposals.length - shown.length),
    can_edit: decides(ctx),
    can_propose: !decides(ctx) && RANK[ctx.role] >= RANK.commenter,
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

export async function routeOnePager(db: OnePagerDb, ctx: OnePagerCtx, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  const m = req.method;
  if (p[2] === "one-pagers" && m === "GET") {
    if (p[3] !== db.doc.slug && p[3] !== db.doc.id) return json(404, { detail: "No such PRD" });
    if (p[4] === "pdf") {
      return new Response("%PDF-1.7\n% one page\n", {
        status: 200,
        headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${db.doc.slug}-v${db.version}-one-pager.pdf"` },
      });
    }
    return json(200, onePager(db, ctx));
  }
  if (p[2] !== "changes") return null;
  if (m === "POST" && p.length === 3) {
    const b = await body(req.clone());
    if (b.op !== "edit_line") return null;
    const target = (b.target ?? {}) as Record<string, string>;
    const lineId = String(target.line_id ?? "");
    // Who cannot see the draft proposes against the published line and sections.
    const sees = seesDraft(db, ctx);
    const cur = sees ? lineNow(db, lineId) : seedLine(db, lineId)?.text;
    if (cur === undefined) return json(404, { detail: "No such line on this one-pager" });
    if (RANK[ctx.role] < RANK.commenter) return json(403, { detail: "Viewers read the one-pager" });
    const old = String(((b.before ?? {}) as Record<string, unknown>).line ?? "");
    const next = String(((b.after ?? {}) as Record<string, unknown>).line ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!next || next.length > 300) return json(422, { detail: "after.line: 1 to 300 characters" });
    if (old !== cur) return json(409, { detail: { message: "This line changed since you read it", current: { line: cur }, changed_by: null, changed_at: null } });
    const keys = seedLine(db, lineId)!.keys;
    const heads = Object.fromEntries(db.sections.map((s) => [s.key, s.heading]));
    const patched = keys.map((k, i) => patch(sectionNow(db, k, sees), cur, next, i === 0));
    if (patched.some((x) => x === null)) return json(409, { detail: "Oracle could not find this line's words in its sections; open the detailed view to edit them" });
    const before = { line: cur, sections: Object.fromEntries(keys.map((k) => [k, { heading: heads[k], body: sectionNow(db, k, sees) }])) };
    const after = { line: next, sections: Object.fromEntries(keys.map((k, i) => [k, { heading: heads[k], body: patched[i]! }])) };
    const applies = decides(ctx);
    const c = {
      id: stableUuid(`op-change-${db.changes.length}-${mockNowMs()}`), session_id: applies ? stableUuid(`op-session-${ctx.id}`) : null,
      document_id: db.doc.id, draft_ids: [] as string[], op: "edit_line" as const,
      target: { document_id: db.doc.id, line_id: lineId, version: db.version }, before, after,
      status: (applies ? "applied" : "proposed") as Change["status"], by: ctx.id, by_name: ctx.names[ctx.id] ?? "someone",
      at: new Date(mockNowMs()).toISOString(), decided_by: null, decided_at: null, reason: null, decision_reason: null,
      routed_to: applies ? [] : ctx.owners, undoes_id: null, undone: false, can_decide: false, can_undo: false,
      session_open: applies, in_meeting: false,
    };
    if (applies) {
      write(db, ctx, lineId, after);
      c.draft_ids = [db.draft!.id];
    }
    db.changes.push(c);
    return json(201, { change: out(db, ctx, c), flags: [] });
  }
  const c = db.changes.find((x) => x.id === p[3]);
  if (!c || m !== "POST") return null;
  if (p[4] === "accept" || p[4] === "decline") {
    if (!(ctx.role === "owner" || c.routed_to.includes(ctx.id))) return json(403, { detail: "Only an owner or the PRD's decider decides this proposal" });
    if (c.status !== "proposed") return json(409, { detail: `This change is ${c.status} already` });
    const lineId = String(c.target.line_id);
    if (p[4] === "accept") {
      if (lineNow(db, lineId) !== c.before.line) return json(409, { detail: { message: "outdated: the line or its sections changed since the proposal", current: { line: lineNow(db, lineId) }, changed_by: null, changed_at: null } });
      write(db, ctx, lineId, c.after);
      c.draft_ids = [db.draft!.id];
    }
    c.status = p[4] === "accept" ? "accepted" : "declined";
    c.decided_by = ctx.id;
    c.decided_at = new Date(mockNowMs()).toISOString();
    return json(200, { change: out(db, ctx, c), flags: [] });
  }
  if (p[4] === "undo") {
    if (c.status !== "applied") return json(409, { detail: `Only an applied change undoes; this one is ${c.status}` });
    if (c.by !== ctx.id) return json(403, { detail: "Only the person who made a change undoes it" });
    if (db.changes.some((u) => u.undoes_id === c.id)) return json(409, { detail: "This change is undone already" });
    write(db, ctx, String(c.target.line_id), c.before);
    const u = { ...c, id: stableUuid(`op-undo-${c.id}`), status: "undone" as const, before: c.after, after: c.before, undoes_id: c.id, at: new Date(mockNowMs()).toISOString() };
    db.changes.push(u);
    return json(201, { change: out(db, ctx, u), flags: [] });
  }
  return null;
}

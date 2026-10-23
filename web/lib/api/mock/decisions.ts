/**
 * Mock of the decision log (H1, /v1/decisions) and its Inbox rows. Synthetic data only: a
 * few judgement calls of the mock company, and a checkpoint record for every run stop the
 * runs mock has decided (as the API records them on decide, one per checkpoint).
 */
import type { Schemas } from "@/lib/api/client";

import { mockSetting } from "./connections";

type DecisionOut = Schemas["DecisionOut"];
type Summary = Schemas["DecisionSummary"];
type Option = Schemas["DecisionOption"];
type Role = "viewer" | "commenter" | "approver" | "owner";
type Member = { id: string; email: string; role: Role; status?: string };
type RunLike = {
  id: string;
  flow: string;
  flow_title: string;
  document_slug: string | null;
  created_by: string | null;
  checkpoints: { id: string; kind: string; status: string; note: string | null; decided_by: string | null; decided_at: string | null; segment_seq: number | null }[];
  segments: { seq: number; name: string }[];
};

/** A stored decision: the API's record without what is derived on the way out. */
type Row = Omit<DecisionOut, "state" | "ref" | "approver_email" | "decided_by_email" | "withdrawn_by_email" | "reviews" | "revisit_id" | "superseded_by_id" | "can_edit" | "can_decide" | "can_withdraw" | "can_review" | "can_reassign">;
type ReviewRow = Schemas["DecisionReviewOut"] & { decision_id: string };

export interface DecisionsDb {
  decisions: Row[];
  reviews: ReviewRow[];
}

export interface DecisionsContext {
  me: Member;
  members: Member[];
  runs: RunLike[];
  documentTitle: (slug: string) => string | null;
  uuid: () => string;
  now: () => string;
}

const REVIEW_DAYS = 90;
const MAX_REVIEW_DAYS = 365;
const SHOWN_DAYS = 7;
const CHECKPOINT_LOCKED = "A checkpoint record is not edited; it records the run's decision";
const DECIDED_LOCKED = "Decided decisions are not edited. Revisit it instead.";
const CAPTURED = ["version_approval", "assumption", "blocker", "pushback_override", "priority_override", "checkpoint"];
const STOP_LABELS: Record<string, string> = {
  baseline_confirm: "Baseline confirm",
  feature_set: "Feature set",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering check",
  eng_dates: "Engineering dates",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
};
const RANK: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => RANK.indexOf(role) >= RANK.indexOf(min);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

/** Today as YYYY-MM-DD (UTC, as the API's), shifted by `days`. */
export function day(days = 0): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ref = (n: number) => `D-${n}`;
const classOf = (d: Pick<Row, "origin">) => (d.origin === "checkpoint" ? "checkpoint" : "judgement");

function stateOf(d: Row): DecisionOut["state"] {
  if (d.status === "decided" && classOf(d) === "judgement" && d.review_at && d.review_at <= day()) return "review_due";
  return d.status;
}

function option(key: string, label: string, extra: Partial<Option> = {}): Option {
  return { key, label, summary: null, pros: [], cons: [], evidence_ids: [], cost_if_wrong: null, recommended: false, ...extra };
}

function blank(ctx: DecisionsContext, db: DecisionsDb, fields: Partial<Row> & Pick<Row, "title" | "approver_id" | "origin">): Row {
  const at = fields.created_at ?? ctx.now();
  return {
    id: ctx.uuid(),
    number: Math.max(0, ...db.decisions.map((d) => d.number)) + 1,
    status: "proposed",
    class: classOf(fields),
    reversibility: "reversible",
    chosen_option: null,
    decided_at: null,
    review_at: null,
    run_id: null,
    created_at: at,
    source: null,
    question: null,
    context: null,
    options: [],
    rationale: null,
    driver: "oracle",
    contributor_ids: [],
    informed_ids: [],
    evidence_ids: [],
    entity_ids: [],
    subjects: [],
    expected_outcome: null,
    prediction: null,
    outcome_id: null,
    supersedes_id: null,
    entity_id: null,
    decided_via: null,
    decided_by: null,
    decided_actor: null,
    created_by: null,
    updated_at: at,
    lock_version: 1,
    ...fields,
  };
}

/** The mock company's judgement calls: two wait on the approver (one proposal, one review due). */
export function seedDecisions(ctx: DecisionsContext): DecisionsDb {
  const db: DecisionsDb = { decisions: [], reviews: [] };
  const by = (email: string) => ctx.members.find((m) => m.email === email)!.id;
  const owner = by("admin@example.com");
  const approver = by("approver@example.com");
  const commenter = by("commenter@example.com");
  const add = (fields: Partial<Row> & Pick<Row, "title" | "approver_id" | "origin">) => {
    const row = blank(ctx, db, fields);
    db.decisions.push(row);
    return row;
  };
  const longAgo = (days: number) => `${day(-days)}T09:00:00Z`;
  add({
    title: "Publish Checkout redesign PRD v2",
    origin: "version_approval",
    approver_id: owner,
    status: "decided",
    options: [option("publish", "Publish"), option("keep_in_review", "Keep in review")],
    chosen_option: "publish",
    rationale: "Approved version 2 of Checkout redesign PRD",
    context: "Readiness at approval: 9 passed, 1 warned",
    expected_outcome: "See the document's success metrics",
    decided_by: owner,
    decided_actor: "user",
    decided_at: longAgo(40),
    created_at: longAgo(40),
    review_at: day(50),
    source: { kind: "document_version", id: ctx.uuid() },
    subjects: [{ kind: "document", id: ctx.uuid(), ref: "checkout-redesign" }],
  });
  add({
    title: "Accept the partner API quota risk for launch",
    origin: "assumption",
    approver_id: owner,
    status: "decided",
    options: [option("accept_risk", "Accept the risk"), option("validate", "Validate it first")],
    chosen_option: "accept_risk",
    rationale: "Batching keeps peak calls under the published quota; we watch the 429 rate.",
    expected_outcome: "No launch-week sync failures from the quota",
    decided_by: owner,
    decided_actor: "user",
    decided_at: longAgo(30),
    created_at: longAgo(30),
    review_at: day(60),
    source: { kind: "assumption_decision", id: ctx.uuid() },
  });
  add({
    title: "Keep the reviewer's call over Oracle's pushback on Team onboarding PRD",
    origin: "pushback_override",
    approver_id: owner,
    status: "decided",
    options: [option("keep_reviewers_call", "Keep the reviewer's call"), option("take_oracles_advice", "Take Oracle's advice", { recommended: true })],
    chosen_option: "keep_reviewers_call",
    rationale: "Support load from the checklist is too high for the first release.",
    context: "Oracle pushed back: the checklist is the strongest activation lever the evidence shows.",
    decided_by: owner,
    decided_actor: "user",
    decided_at: longAgo(20),
    created_at: longAgo(20),
    review_at: day(70),
    source: { kind: "llm_suggestion", id: ctx.uuid() },
  });
  add({
    title: "Price the team plan per seat",
    origin: "manual",
    driver: `user:${commenter}`,
    created_by: commenter,
    approver_id: approver,
    status: "decided",
    question: "Per seat or per company?",
    options: [
      option("per-seat", "Per seat", { pros: ["Grows with the team"], cons: ["Harder to forecast"], cost_if_wrong: "A quarter of churned small teams" }),
      option("per-company", "Per company", { pros: ["One number"], cons: ["Large teams underpay"], cost_if_wrong: "Revenue left on the table" }),
    ],
    chosen_option: "per-seat",
    rationale: "Matches how buyers budget and how competitors price.",
    expected_outcome: "Team plan revenue per account up 15% in a quarter",
    decided_by: approver,
    decided_actor: "user",
    decided_at: longAgo(92),
    created_at: longAgo(95),
    // Its review date has come: the approver's Inbox shows "Review due".
    review_at: day(-2),
  });
  add({
    title: "Ship usage caps before anomaly detection",
    origin: "manual",
    driver: `user:${commenter}`,
    created_by: commenter,
    approver_id: approver,
    question: "Do caps wait for detection?",
    context: "Finance asks for caps; detection adds early warning only.",
    options: [
      option("caps-first", "Caps first", {
        summary: "Caps read plan thresholds only",
        pros: ["One sprint"],
        cons: ["No early warning"],
        cost_if_wrong: "A month of noisy alerts",
        recommended: true,
      }),
      option("together", "Ship together", { summary: "Wait for detection", cons: ["Six more weeks"], cost_if_wrong: "Late for the quarter's goal" }),
    ],
    contributor_ids: [commenter],
    informed_ids: [owner],
    created_at: longAgo(1),
  });
  return db;
}

/** The "large" company's long log: `count` newer judgement calls the owner decided long ago, none due. */
export function enlargeDecisions(ctx: DecisionsContext, db: DecisionsDb, count: number) {
  const owner = ctx.members.find((m) => m.email === "admin@example.com")!.id;
  for (let i = 1; i <= count; i++) {
    db.decisions.push(
      blank(ctx, db, {
        title: `Release train call ${i}`,
        origin: "manual",
        driver: `user:${owner}`,
        created_by: owner,
        approver_id: owner,
        status: "decided",
        options: [option("ship", "Ship"), option("hold", "Hold")],
        chosen_option: "ship",
        rationale: "Ready on the train's date.",
        decided_by: owner,
        decided_actor: "user",
        decided_at: `${day(-60)}T09:00:00Z`,
        created_at: `${day(-61)}T09:00:00Z`,
        review_at: day(120),
      }),
    );
  }
}

/**
 * A checkpoint record for every run stop decided (approved or sent back), once per
 * checkpoint, as the API records them; a skipped or pending stop has none.
 */
export function syncCheckpointRecords(ctx: DecisionsContext, db: DecisionsDb) {
  const known = new Set(db.decisions.filter((d) => d.source?.kind === "checkpoint").map((d) => d.source!.id));
  const stops = ctx.runs
    .flatMap((r) => r.checkpoints.filter((c) => (c.status === "approved" || c.status === "changes_requested") && !known.has(c.id)).map((c) => ({ r, c })))
    .sort((a, b) => (a.c.decided_at ?? "").localeCompare(b.c.decided_at ?? ""));
  for (const { r, c } of stops) {
    const approve = c.status === "approved";
    const name = (r.document_slug && ctx.documentTitle(r.document_slug)) ?? r.document_slug ?? r.flow_title;
    const segment = r.segments.find((s) => s.seq === c.segment_seq)?.name ?? null;
    const approver = c.decided_by ?? r.created_by ?? ctx.me.id;
    db.decisions.push(
      blank(ctx, db, {
        title: `${approve ? "Approve" : "Send back"} ${STOP_LABELS[c.kind] ?? c.kind} · ${name} run`,
        origin: "checkpoint",
        approver_id: approver,
        status: "decided",
        options: [option("approve", "Approve"), option("request_changes", "Send back")],
        chosen_option: approve ? "approve" : "request_changes",
        rationale: c.note || (approve ? "Approved with no note" : "Sent back with no note"),
        decided_by: c.decided_by,
        decided_actor: "user",
        decided_via: "oracle",
        decided_at: c.decided_at ?? ctx.now(),
        created_at: c.decided_at ?? ctx.now(),
        run_id: r.id,
        source: { kind: "checkpoint", id: c.id, checkpoint_kind: c.kind, segment },
        subjects: [{ kind: "run", id: r.id, ref: `run:${r.id}`, checkpoint_kind: c.kind, segment }],
      }),
    );
  }
}

function emailOf(ctx: DecisionsContext, id: string | null | undefined): string | null {
  return ctx.members.find((m) => m.id === id)?.email ?? null;
}

function summaryOf(ctx: DecisionsContext, d: Row): Summary {
  return {
    id: d.id,
    number: d.number,
    ref: ref(d.number),
    title: d.title,
    status: d.status,
    state: stateOf(d),
    class: classOf(d),
    origin: d.origin,
    reversibility: d.reversibility,
    approver_id: d.approver_id,
    approver_email: emailOf(ctx, d.approver_id),
    chosen_option: d.chosen_option,
    decided_at: d.decided_at,
    review_at: d.review_at,
    run_id: d.run_id,
    created_at: d.created_at,
    source: d.source,
  };
}

function outOf(ctx: DecisionsContext, db: DecisionsDb, d: Row): DecisionOut {
  const me = ctx.me;
  const approver = me.id === d.approver_id;
  const owner = me.role === "owner";
  const editor = approver || owner || me.id === d.created_by;
  const checkpoint = classOf(d) === "checkpoint";
  const proposed = d.status === "proposed";
  const revisit = db.decisions.filter((x) => x.supersedes_id === d.id && (x.status === "proposed" || x.status === "decided")).pop();
  return {
    ...d,
    ...summaryOf(ctx, d),
    decided_by_email: emailOf(ctx, d.decided_by),
    withdrawn_by_email: emailOf(ctx, d.withdrawn_by),
    revisit_id: revisit && d.status === "decided" ? revisit.id : null,
    superseded_by_id: revisit && d.status === "superseded" ? revisit.id : null,
    reviews: db.reviews
      .filter((r) => r.decision_id === d.id)
      .map((r) => ({
        id: r.id,
        verdict: r.verdict,
        note: r.note,
        outcome_status: r.outcome_status,
        next_review_at: r.next_review_at,
        revisit_id: r.revisit_id,
        reviewed_by: r.reviewed_by,
        reviewed_by_email: emailOf(ctx, r.reviewed_by),
        created_at: r.created_at,
      })),
    can_edit: !checkpoint && ((proposed && editor) || (d.status === "decided" && CAPTURED.includes(d.origin) && approver)),
    can_decide: !checkpoint && proposed && approver,
    can_withdraw: !checkpoint && proposed && editor,
    can_review: !checkpoint && d.status === "decided" && approver,
    can_reassign: !checkpoint && (proposed || d.status === "decided") && owner,
  };
}

function find(db: DecisionsDb, key: string): Row | undefined {
  const n = /^(?:D-)?(\d+)$/i.exec(key)?.[1];
  return db.decisions.find((d) => d.id === key || (n !== undefined && d.number === Number(n)));
}

function checkReviewAt(value: string): string | null {
  if (value < day()) return "The review date cannot be in the past";
  if (value > day(MAX_REVIEW_DAYS)) return `The review date is at most ${MAX_REVIEW_DAYS} days out`;
  return null;
}

function activeApprover(ctx: DecisionsContext, id: string): Member | undefined {
  const m = ctx.members.find((x) => x.id === id);
  return m && m.status !== "disabled" && atLeast(m.role, "approver") ? m : undefined;
}

/** /v1/decisions…; null for other routes. */
export async function routeDecisions(ctx: DecisionsContext, db: DecisionsDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "decisions") return null;
  syncCheckpointRecords(ctx, db);
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const me = ctx.me;

  if (!p[2] && m === "GET") {
    let rows = [...db.decisions];
    const cls = q.get("class");
    if (cls === "judgement" || cls === "checkpoint") rows = rows.filter((d) => classOf(d) === cls);
    const status = q.get("status");
    if (status === "review_due") rows = rows.filter((d) => stateOf(d) === "review_due");
    else if (status === "open") rows = rows.filter((d) => d.status === "proposed" || stateOf(d) === "review_due");
    else if (status) rows = rows.filter((d) => d.status === status);
    const approver = q.get("approver");
    if (approver) rows = rows.filter((d) => d.approver_id === (approver === "me" ? me.id : approver));
    if (q.get("due") === "true") rows = rows.filter((d) => stateOf(d) === "review_due");
    const origin = q.get("origin");
    if (origin) rows = rows.filter((d) => origin.split(",").includes(d.origin));
    const chosen = q.get("chosen");
    if (chosen) rows = rows.filter((d) => d.chosen_option === chosen);
    const run = q.get("run_id");
    if (run) rows = rows.filter((d) => d.run_id === run);
    const kind = q.get("subject_kind");
    const sid = q.get("subject_id");
    if (kind || sid) rows = rows.filter((d) => d.subjects.some((s) => (!kind || s.kind === kind) && (!sid || s.id === sid)));
    const text = q.get("q")?.trim().toLowerCase();
    if (text) {
      rows = rows.filter(
        (d) => [d.title, d.question, d.rationale].some((x) => x?.toLowerCase().includes(text)) || ref(d.number).toLowerCase() === text || String(d.number) === text,
      );
    }
    rows.sort((a, b) => b.number - a.number);
    const offset = Number(q.get("offset") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    return json(
      200,
      rows.slice(offset, offset + limit).map((d) => summaryOf(ctx, d)),
    );
  }

  if (!p[2] && m === "POST") {
    if (!atLeast(me.role, "commenter")) return fail(403, "Requires the commenter role");
    const b = await body<Schemas["DecisionCreate"]>();
    if (!b.title?.trim() || b.title.length > 200) return fail(422, "title: 1-200 characters");
    const options = b.options ?? [];
    if (options.length > 6) return fail(422, "options: List should have at most 6 items");
    if (new Set(options.map((o) => o.key)).size !== options.length) return fail(422, "option keys must be unique");
    if (!activeApprover(ctx, b.approver_id)) return fail(422, "The approver must be an active member with the approver role or above");
    const row = blank(ctx, db, {
      title: b.title.trim(),
      question: b.question?.trim() || null,
      context: b.context?.trim() || null,
      options: options.map((o) => option(o.key, o.label, { ...o, recommended: false })),
      approver_id: b.approver_id,
      reversibility: b.reversibility ?? "reversible",
      contributor_ids: b.contributor_ids ?? [],
      informed_ids: b.informed_ids ?? [],
      evidence_ids: b.evidence_ids ?? [],
      entity_ids: b.entity_ids ?? [],
      subjects: b.subjects ?? [],
      origin: "manual",
      driver: `user:${me.id}`,
      created_by: me.id,
    });
    db.decisions.push(row);
    return json(201, outOf(ctx, db, row));
  }

  if (p[2] === "people" && m === "GET") {
    return json(
      200,
      ctx.members.filter((x) => x.status !== "disabled").map((x) => ({ id: x.id, email: x.email, role: x.role })),
    );
  }

  const d = p[2] ? find(db, p[2]) : undefined;
  if (!d) return fail(404, `decision ${p[2]} not found`);
  const action = p[3];
  if (!action && m === "GET") return json(200, outOf(ctx, db, d));
  const checkpoint = classOf(d) === "checkpoint";
  const touch = () => Object.assign(d, { lock_version: d.lock_version + 1, updated_at: ctx.now() });
  const name = emailOf(ctx, d.approver_id) ?? "its approver";

  if (!action && m === "PATCH") {
    if (!atLeast(me.role, "commenter")) return fail(403, "Requires the commenter role");
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    const b = await body<Schemas["DecisionPatch"]>();
    if (d.status === "decided") return fail(409, DECIDED_LOCKED);
    if (d.status !== "proposed") return fail(409, `${ref(d.number)} is ${d.status}; it is not edited`);
    if (!(me.id === d.approver_id || me.id === d.created_by || me.role === "owner")) return fail(403, "Only its creator, its approver or an owner edits a proposal");
    if (b.lock_version !== d.lock_version) return fail(409, "Someone else changed this since you loaded it; reload and try again");
    if (b.review_at) {
      const bad = checkReviewAt(b.review_at);
      if (bad) return fail(422, bad);
    }
    for (const k of ["title", "question", "context", "options", "reversibility", "contributor_ids", "informed_ids", "subjects"] as const) {
      if (b[k] !== undefined && b[k] !== null) Object.assign(d, { [k]: b[k] });
    }
    // Clearable: null empties them. The prediction waits for the decision to make its outcome record.
    if (b.expected_outcome !== undefined) d.expected_outcome = b.expected_outcome?.trim() || null;
    if (b.review_at !== undefined) d.review_at = b.review_at ?? null;
    if (b.prediction !== undefined) d.prediction = b.prediction ?? null;
    touch();
    return json(200, outOf(ctx, db, d));
  }

  if (action === "decide" && m === "POST") {
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    if (d.status !== "proposed") return fail(409, `${ref(d.number)} is ${d.status}; only a proposal is decided`);
    if (me.id !== d.approver_id) return fail(403, `Only ${name} decides ${ref(d.number)}`);
    const b = await body<Schemas["DecideIn"]>();
    if (d.options.length < 2) return fail(422, "Add at least two options to decide");
    if (!d.options.some((o) => o.key === b.option_key)) return fail(422, `'${b.option_key}' is not one of the options`);
    if (!b.rationale?.trim()) return fail(422, "Say why (rationale)");
    if (!b.expected_outcome?.trim()) return fail(422, "Say what should happen if it is right (expected_outcome)");
    const reversibility = b.reversibility ?? d.reversibility;
    if (reversibility === "irreversible") {
      const role = (mockSetting("decision_irreversible_role") as Role | undefined) ?? "owner";
      if (!atLeast(me.role, role)) return fail(403, `Only an ${role} can decide a hard-to-reverse decision`);
    }
    const kept = d.review_at && d.review_at >= day() ? d.review_at : null;
    const review = b.review_at ?? kept ?? day(REVIEW_DAYS);
    const bad = checkReviewAt(review);
    if (bad) return fail(422, bad);
    Object.assign(d, {
      status: "decided",
      chosen_option: b.option_key,
      rationale: b.rationale.trim(),
      expected_outcome: b.expected_outcome.trim(),
      reversibility,
      review_at: review,
      prediction: b.prediction ?? d.prediction ?? null,
      outcome_id: (b.prediction ?? d.prediction) ? ctx.uuid() : null,
      decided_by: me.id,
      decided_actor: "user",
      decided_at: ctx.now(),
      entity_id: ctx.uuid(),
    });
    if (d.supersedes_id) {
      const original = db.decisions.find((x) => x.id === d.supersedes_id);
      if (original?.status === "decided") original.status = "superseded";
    }
    touch();
    return json(200, outOf(ctx, db, d));
  }

  if (action === "reassign" && m === "POST") {
    if (me.role !== "owner") return fail(403, "Requires the owner role");
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    const b = await body<Schemas["ReassignIn"]>();
    if (!activeApprover(ctx, b.approver_id)) return fail(422, "The approver must be an active member with the approver role or above");
    d.approver_id = b.approver_id;
    touch();
    return json(200, outOf(ctx, db, d));
  }

  if (action === "withdraw" && m === "POST") {
    if (!atLeast(me.role, "commenter")) return fail(403, "Requires the commenter role");
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    if (d.status !== "proposed") return fail(409, `${ref(d.number)} is ${d.status}; only a proposal is withdrawn`);
    if (!(me.id === d.approver_id || me.id === d.created_by || me.role === "owner")) return fail(403, "Only its creator, its approver or an owner withdraws it");
    d.status = "withdrawn";
    d.withdrawn_at = ctx.now();
    d.withdrawn_by = me.id;
    d.withdrawn_reason = (await body<Schemas["WithdrawIn"]>()).reason.trim();
    touch();
    return json(200, outOf(ctx, db, d));
  }

  if (action === "reviews" && m === "POST") {
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    if (d.status !== "decided") return fail(409, `${ref(d.number)} is ${d.status}; only a decided one is reviewed`);
    if (me.id !== d.approver_id) return fail(403, `Only ${name} reviews ${ref(d.number)}`);
    const b = await body<Schemas["ReviewIn"]>();
    if (!b.note?.trim()) return fail(422, "say what the review found (note)");
    const row: ReviewRow = {
      id: ctx.uuid(),
      decision_id: d.id,
      verdict: b.verdict,
      note: b.note.trim(),
      outcome_status: null,
      next_review_at: null,
      revisit_id: null,
      reviewed_by: me.id,
      reviewed_by_email: me.email,
      created_at: ctx.now(),
    };
    if (b.verdict === "reaffirmed") {
      const next = b.next_review_at ?? day(REVIEW_DAYS);
      const bad = checkReviewAt(next);
      if (bad) return fail(422, bad);
      d.review_at = next;
      row.next_review_at = next;
    } else if (b.verdict === "revisit") {
      const open = db.decisions.find((x) => x.supersedes_id === d.id && x.status === "proposed");
      if (open) return fail(409, `${ref(d.number)} is already being revisited`);
      const copy = blank(ctx, db, {
        ...d,
        id: undefined,
        number: undefined,
        status: "proposed",
        chosen_option: null,
        rationale: null,
        decided_at: null,
        decided_by: null,
        decided_actor: null,
        review_at: null,
        expected_outcome: null,
        prediction: null,
        outcome_id: null,
        entity_id: null,
        source: null,
        origin: "manual",
        driver: `user:${me.id}`,
        created_by: me.id,
        created_at: ctx.now(),
        updated_at: ctx.now(),
        lock_version: 1,
        supersedes_id: d.id,
        options: d.options.map((o) => ({ ...o, recommended: false })),
      } as Partial<Row> & Pick<Row, "title" | "approver_id" | "origin">);
      copy.id = ctx.uuid();
      copy.number = Math.max(...db.decisions.map((x) => x.number)) + 1;
      db.decisions.push(copy);
      row.revisit_id = copy.id;
    } else {
      d.status = "reversed";
    }
    db.reviews.push(row);
    touch();
    return json(200, outOf(ctx, db, d));
  }

  if (action === "options-job" && m === "POST") {
    if (!atLeast(me.role, "approver")) return fail(403, "Requires the approver role");
    if (checkpoint) return fail(409, CHECKPOINT_LOCKED);
    if (d.status !== "proposed") return fail(409, `${ref(d.number)} is ${d.status}; options are for a proposal`);
    // The click-and-wait job, answered at once by the mock: two options, one recommended.
    const at = ctx.now();
    const taken = new Set(d.options.map((o) => o.key));
    const mk = (key: string, o: Option) => (taken.has(key) ? null : o);
    const added = [
      mk("smallest-step", option("smallest-step", "Take the smallest reversible step", { summary: "Ship the narrow version first and measure", pros: ["Cheap to undo"], cons: ["Slower to the full outcome"], cost_if_wrong: "A few weeks", recommended: true })),
      mk("full-scope", option("full-scope", "Commit to the full scope", { summary: "Build everything in one release", pros: ["One launch"], cons: ["Hard to undo"], cost_if_wrong: "A quarter of work" })),
    ].filter((o): o is Option => !!o);
    d.options = [...d.options.map((o) => ({ ...o, recommended: false })), ...added].slice(0, 6);
    touch();
    const job: Schemas["LlmJobOut"] = {
      id: ctx.uuid(),
      kind: "decision_options",
      document_id: null,
      intake_id: null,
      decision_id: d.id,
      status: "succeeded",
      input: { decision: d.number },
      output: { options: added.map((o) => o.key), recommended: added.find((o) => o.recommended)?.key ?? null },
      attempts: 1,
      created_at: at,
      started_at: at,
      finished_at: at,
    };
    return json(201, job);
  }
  return fail(404, "Route not found");
}

/** The decision rows of my Inbox, as GET /v1/inbox serves them (checkpoint records add none). */
export function decisionInbox(ctx: DecisionsContext, db: DecisionsDb, seen: string | null): Schemas["InboxDecision"][] {
  syncCheckpointRecords(ctx, db);
  const me = ctx.me.id;
  const since = new Date(Date.now() - SHOWN_DAYS * 86_400_000).toISOString();
  const fresh = (at: string) => (seen === null || at > seen ? "new" : "open");
  const judgement = db.decisions.filter((d) => classOf(d) === "judgement");
  const revisited = new Set(judgement.filter((d) => d.status === "proposed" && d.supersedes_id).map((d) => d.supersedes_id));
  const rows: Schemas["InboxDecision"][] = [];
  const row = (d: Row, reason: Schemas["InboxDecision"]["reason"], state: Schemas["InboxDecision"]["state"], counts: boolean, at: string) =>
    rows.push({ id: d.id, number: d.number, ref: ref(d.number), title: d.title, reason, review_at: d.review_at, since: at, state, counts });
  for (const d of judgement.filter((x) => x.approver_id === me && x.status === "proposed")) row(d, "needs_decision", fresh(d.created_at), true, d.created_at);
  for (const d of judgement.filter((x) => x.approver_id === me && stateOf(x) === "review_due" && !revisited.has(x.id))) {
    const at = `${d.review_at}T00:00:00Z`;
    row(d, "review_due", fresh(at), true, at);
  }
  const shown = new Set(rows.map((r) => r.id));
  for (const r of [...db.reviews].reverse().filter((x) => x.reviewed_by === me && x.created_at >= since)) {
    const d = judgement.find((x) => x.id === r.decision_id);
    if (d && !shown.has(d.id)) {
      shown.add(d.id);
      row(d, "review_due", "done", false, r.created_at);
    }
  }
  for (const d of judgement.filter((x) => x.decided_by === me && (x.decided_at ?? "") >= since)) {
    if (!shown.has(d.id)) {
      shown.add(d.id);
      row(d, "needs_decision", "done", false, d.decided_at!);
    }
  }
  for (const d of judgement.filter((x) => x.status === "decided" && (x.decided_at ?? "") >= since && x.informed_ids.includes(me))) {
    if (!shown.has(d.id)) {
      shown.add(d.id);
      row(d, "informed", fresh(d.decided_at!), false, d.decided_at!);
    }
  }
  return rows;
}

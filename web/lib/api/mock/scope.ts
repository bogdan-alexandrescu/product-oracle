/**
 * C7 Scope review: the feature-set stop's rows, edited row by row (`/v1/prd-scopes`), as
 * api/oracle/runs/scope_review.py serves them. Any member reads a scope; the checkpoint's
 * approver role and above decide, edit, add and enhance rows; commenters suggest through the
 * D8 actions of the same checkpoint (./runs.ts routeDraft). Every write needs the scope
 * proposed and its checkpoint pending (409), takes the row's lock_version (409 on a stale
 * one), re-checks the scope (its blocking problems and flags follow the rows, and the
 * checkpoint's stored check with them, so D3's gate reads the edited scope) and bumps the
 * checkpoint's D8 draft revision.
 */
import type { Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";

import type { DraftRow, RunsContext, RunsDb } from "./runs";

type PrdScopeOut = Schemas["PrdScopeOut"];
type FeatureOut = PrdScopeOut["features"][number];
type RequirementOut = FeatureOut["requirements"][number];
type Job = Schemas["LlmJobOut"];
type Role = Schemas["Me"]["role"];
type Problem = Schemas["FeatureSetCheck"]["problems"][number];

/** What a row keeps beside the C6 fields: its place, lock, the agent's values and who changed it. */
type Meta = {
  text?: string | null;
  position?: number;
  lock_version?: number;
  /** The agent's values, kept on the first change (absent: untouched, or added by a person). */
  original?: Record<string, unknown> | null;
  decided_by?: string | null;
  decided_at?: string | null;
  evidence_ids?: string[];
};
export type ScopeRequirement = RequirementOut & Meta;
export type ScopeFeature = Omit<FeatureOut, "requirements"> & Meta & { requirements: ScopeRequirement[] };
export type StoredScope = Omit<PrdScopeOut, "features"> & {
  features: ScopeFeature[];
  /** The previous attempt's decisions (feature key -> decision) and kept requirement keys. */
  previous?: Record<string, string> | null;
  previous_requirements?: Record<string, string[]> | null;
};

export const DECIDED = "This feature set is already decided";
export const STALE = "This row changed since you loaded it: reload to see the latest";
export const NOT_WAIVED = "This cannot be waived; leave it out or send it back";
const LEAVE_OUT = ["no_goal", "not_now", "out_of_scope", "duplicate"];
const FLAG_LABELS: Record<string, string> = {
  serves_no_goal: "Serves no confirmed goal",
  low_confidence: "Low confidence",
  linked_blocker: "Linked open blocker",
  new_feature: "New, not in the baseline",
  duplicate_of_existing: "Duplicate of an existing feature",
};
const FIELDS = ["decision", "decision_reason", "text", "acceptance", "goals", "depends_on", "blocker_keys"] as const;
/** The problems the rows decide (re-checked on every write); the file's others are carried. */
const ROW_CODES = ["depends_on_excluded", "unknown_dependency"];
const FILE_PROBLEMS = ["unreadable_yaml", "missing_file", "wrong_version", "wrong_document", "no_features"];
/** Below this confidence a feature is flagged (the company's low threshold, as C6). */
const LOW = 0.5;
const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const fail = (status: number, detail: string) => json(status, { detail });

type Row = ScopeFeature | ScopeRequirement;
const isFeature = (r: Row): r is ScopeFeature => "depends_on" in r;

function valuesOf(r: Row): Record<string, unknown> {
  const f = isFeature(r) ? r : null;
  return {
    decision: r.decision,
    decision_reason: r.decision_reason ?? null,
    text: r.text ?? null,
    acceptance: f ? [] : [...(r as ScopeRequirement).acceptance],
    goals: f ? f.goals.map((g) => ({ ...g })) : [],
    depends_on: f ? [...f.depends_on] : [],
    blocker_keys: f ? [...f.blocker_keys] : [],
  };
}
const added = (r: Row) => r.origin === "person" && !r.original;
function edited(r: Row): boolean {
  if (added(r)) return true;
  if (!r.original) return false;
  const now = valuesOf(r);
  return FIELDS.some((k) => JSON.stringify(now[k]) !== JSON.stringify(r.original![k]));
}

// ------------------------------------------------------------------------------- lookups

export function allScopes(db: RunsDb): StoredScope[] {
  return Object.values(db.scopes ?? {}).flat() as StoredScope[];
}
function scopeById(db: RunsDb, id: string): StoredScope | undefined {
  return allScopes(db).find((s) => s.id === id);
}
/** The run's latest scope, any status. */
export function latestScope(db: RunsDb, runId: string): StoredScope | undefined {
  const list = (db.scopes?.[runId] ?? []) as StoredScope[];
  return [...list].sort((a, b) => a.segment_seq - b.segment_seq || a.attempt - b.attempt).pop();
}
function checkpointOf(db: RunsDb, scope: StoredScope) {
  const run = db.runs.find((r) => r.id === scope.run_id);
  const cps = (run?.checkpoints ?? []).filter((c) => c.kind === "feature_set" && c.segment_seq === scope.segment_seq);
  return { run, cp: cps.find((c) => c.status === "pending") ?? cps[cps.length - 1] };
}
function draftOf(db: RunsDb, cpId: string): DraftRow {
  db.drafts ??= {};
  return (db.drafts[cpId] ??= { revision: 0, note: null, actions: [], log: [] });
}

// ------------------------------------------------------------------------------- reasons

type Action = DraftRow["actions"][number];
const answers = (a: Action, code: string, kind: string) => a.state === "staged" && a.kind === kind && (!a.answers?.length || a.answers.includes(code));
const waivable = (code: string) => !["unknown_feature", "unknown_requirement", "unknown_goal", "unknown_dependency", ...FILE_PROBLEMS].includes(code);

function reasonsOf(scope: StoredScope, actions: Action[]): Record<string, Schemas["ScopeReason"][]> {
  const out: Record<string, Schemas["ScopeReason"][]> = {};
  const mine = (key: string) => actions.filter((a) => a.item_key === key);
  for (const p of scope.check.problems ?? []) {
    if (!p.feature || FILE_PROBLEMS.includes(p.code)) continue;
    const blocking = p.blocking !== false;
    const canWaive = blocking && waivable(p.code);
    const answered = mine(p.feature).some((a) => answers(a, p.code, blocking ? "waive" : "accept"));
    (out[p.feature] ??= []).push({
      code: p.code,
      severity: blocking ? "blocking" : "to_confirm",
      label: p.message || p.code,
      requirement: p.requirement ?? null,
      waivable: canWaive,
      answered: answered && (canWaive || !blocking),
    });
  }
  for (const f of scope.features) {
    if (f.decision !== "include") continue;
    for (const flag of f.flags ?? []) {
      (out[f.key] ??= []).push({
        code: flag,
        severity: "to_confirm",
        label: FLAG_LABELS[flag] ?? flag.replace(/_/g, " "),
        requirement: null,
        waivable: false,
        answered: mine(f.key).some((a) => answers(a, flag, "accept")),
      });
    }
  }
  return out;
}

function summaryOf(scope: StoredScope, actions: Action[]): { summary: Schemas["ScopeSummary"]; reasons: Record<string, Schemas["ScopeReason"][]> } {
  const reasons = reasonsOf(scope, actions);
  const summary: Schemas["ScopeSummary"] = { features: scope.features.length, needs_you: 0, blocking: 0, to_confirm: 0, handled: 0, edits: 0, suggestions_open: 0 };
  for (const f of scope.features) {
    const open = (reasons[f.key] ?? []).filter((r) => !r.answered);
    summary.needs_you += open.length ? 1 : 0;
    summary.blocking += open.filter((r) => r.severity === "blocking").length;
    summary.to_confirm += open.filter((r) => r.severity === "to_confirm").length;
  }
  summary.handled = summary.features - summary.needs_you;
  summary.edits = scope.features.reduce((n, f) => n + (edited(f) ? 1 : 0) + f.requirements.filter(edited).length, 0);
  summary.suggestions_open = actions.filter((a) => a.state === "suggested").length;
  return { summary, reasons };
}

/**
 * As feature_set.check_scope over the rows: dependencies on a feature left out (or on none)
 * block, a feature with no goal or a low confidence is flagged; what only the file said is
 * carried. The checkpoint's stored check follows, so D3's gate reads the edited scope.
 */
export function recheck(db: RunsDb, scope: StoredScope) {
  const carried = (scope.check.problems ?? []).filter((p) => !ROW_CODES.includes(p.code));
  const problems: Problem[] = [...carried];
  const byKey = new Map(scope.features.map((f) => [f.key, f]));
  const flags: Record<string, string[]> = {};
  for (const f of scope.features) {
    if (f.decision !== "include") continue;
    for (const d of f.depends_on) {
      const dep = byKey.get(d);
      if (!dep) problems.push({ code: "unknown_dependency", blocking: true, feature: f.key, requirement: null, message: `${f.key} depends on ${d}, which is not a feature` });
      else if (dep.decision !== "include") problems.push({ code: "depends_on_excluded", blocking: true, feature: f.key, requirement: null, message: `${f.key} depends on ${d}, which is excluded` });
    }
    const mine = (f.flags ?? []).filter((x) => x !== "serves_no_goal" && x !== "low_confidence");
    if (f.goals.length === 0) mine.unshift("serves_no_goal");
    if (f.confidence != null && f.confidence < LOW) mine.splice(f.goals.length === 0 ? 1 : 0, 0, "low_confidence");
    f.flags = mine;
    if (mine.length) flags[f.key] = mine;
  }
  const included = scope.features.filter((f) => f.decision === "include");
  scope.check = {
    ...scope.check,
    features: included.length,
    requirements: included.reduce((n, f) => n + f.requirements.filter((q) => q.decision === "keep").length, 0),
    excluded: scope.features.length - included.length,
    problems,
    flags,
  };
  const { run, cp } = checkpointOf(db, scope);
  const seg = run?.segments.find((s) => s.seq === scope.segment_seq);
  if (seg) seg.feature_set_check = scope.check;
  if (cp && cp.status === "pending") cp.payload = { ...cp.payload, feature_set_check: scope.check };
}

/** Rows numbered and locked, as a scope the agents wrote is stored (C7's columns). */
export function prepareScope(scope: StoredScope) {
  scope.features.forEach((f, i) => {
    f.position ??= i + 1;
    f.lock_version ??= 1;
    f.text ??= null;
    f.evidence_ids ??= [];
    f.requirements.forEach((q, j) => {
      q.position ??= j + 1;
      q.lock_version ??= 1;
    });
  });
}

// ------------------------------------------------------------------------------- read

type Ctx = RunsContext;

function nameOf(ctx: Ctx, id: string | null | undefined): string | null {
  if (!id) return null;
  const m = (ctx.members ?? []).find((x) => x.id === id);
  return m ? displayName(m.email) : id === ctx.userId && ctx.userName ? displayName(ctx.userName) : "Someone";
}
const history = (ctx: Ctx, r: Row): Schemas["ScopeHistory"] => ({
  original: r.original ?? {},
  decided_by: r.decided_by ?? null,
  decided_by_name: nameOf(ctx, r.decided_by),
  decided_at: r.decided_at ?? null,
});
function roleOf(ctx: Ctx): Role | null {
  return ctx.member?.role ?? ctx.userRole ?? null;
}
const atLeast = (role: Role | null, min: string) => role == null || RANK[role] >= (RANK[min as Role] ?? 0);

function reviewOf(ctx: Ctx, scope: StoredScope): Schemas["PrdScopeReview"] {
  prepareScope(scope);
  const { run, cp } = checkpointOf(ctx.db, scope);
  const actions = cp ? (ctx.db.drafts?.[cp.id]?.actions ?? []) : [];
  const { summary, reasons } = summaryOf(scope, actions);
  const open = scope.status === "proposed" && cp?.status === "pending";
  const { previous, previous_requirements, ...rest } = scope;
  return {
    ...rest,
    checkpoint_id: cp?.id ?? null,
    title: run?.document_slug ?? null,
    features: [...scope.features]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((f) => {
        const mine = reasons[f.key] ?? [];
        return {
          ...f,
          text: f.text ?? null,
          position: f.position ?? 0,
          lock_version: f.lock_version ?? 1,
          evidence_ids: f.evidence_ids ?? [],
          edited: edited(f),
          reasons: mine,
          needs_you: mine.some((r) => !r.answered),
          history: history(ctx, f),
          requirements: f.requirements.map((q) => ({
            ...q,
            parent_id: f.id,
            position: q.position ?? 0,
            lock_version: q.lock_version ?? 1,
            edited: edited(q),
            added: added(q),
            history: history(ctx, q),
          })),
        };
      }),
    summary,
    previous: previous ?? null,
    previous_requirements: previous_requirements ?? null,
    goals_available: (ctx.confirmedGoals?.() ?? []).map((g) => ({ goal_id: g.id, key: g.key, title: g.title })),
    can_edit: open && !!cp && atLeast(roleOf(ctx), cp.approver_role),
  };
}

// ------------------------------------------------------------------------------- writes

type Found = { feature: ScopeFeature; requirement: ScopeRequirement | null };
function findRow(scope: StoredScope, test: (r: Row) => boolean): Found | null {
  for (const f of scope.features) {
    if (test(f)) return { feature: f, requirement: null };
    const q = f.requirements.find(test);
    if (q) return { feature: f, requirement: q };
  }
  return null;
}

function keepOriginal(r: Row) {
  if (!r.original && !added(r)) r.original = valuesOf(r);
}

function leaveOutReason(decision: string | null | undefined, reason: string | null | undefined): string | null | Response {
  if (decision !== "exclude") return reason ?? null;
  if (!reason) return fail(422, "decision_reason: say why it is left out (no_goal, not_now, out_of_scope, duplicate or other:<text>)");
  if (LEAVE_OUT.includes(reason) || (reason.startsWith("other:") && reason.slice(6).trim())) return reason;
  return fail(422, `decision_reason: one of ${LEAVE_OUT.join(", ")} or other:<text>`);
}

type Patch = Omit<Schemas["ScopeItemPatch"], "lock_version" | "revert"> & { lock_version?: number; revert?: boolean };

/** Applies a person's change to a row; a Response when it is refused (nothing changed). */
export function applyChange(ctx: Ctx, scope: StoredScope, found: Found, body: Patch, by: string): Response | null {
  const row: Row = found.requirement ?? found.feature;
  const feature = !found.requirement;
  if (body.revert) {
    if (row.original) {
      const o = row.original;
      row.decision = o.decision as never;
      row.decision_reason = (o.decision_reason as string | null) ?? null;
      row.text = (o.text as string | null) ?? null;
      if (feature) Object.assign(row, { goals: o.goals ?? [], depends_on: o.depends_on ?? [], blocker_keys: o.blocker_keys ?? [] });
      else (row as ScopeRequirement).acceptance = (o.acceptance as string[]) ?? [];
      row.origin = "agent";
      row.original = null;
    }
    Object.assign(row, { decided_by: null, decided_at: null, lock_version: (row.lock_version ?? 1) + 1 });
    return null;
  }
  if (body.decision != null) {
    const ok = feature ? ["include", "exclude", "defer"] : ["keep", "cut"];
    if (!ok.includes(body.decision)) return fail(422, `decision: one of ${ok.join(", ")} for a ${feature ? "feature" : "requirement"}`);
  }
  const reason = leaveOutReason(body.decision, body.decision_reason);
  if (reason instanceof Response) return reason;
  let goals: Schemas["ScopeGoal"][] | null = null;
  if (body.goals) {
    if (!feature) return fail(422, "goals: a requirement's goals are its feature's");
    const confirmed = ctx.confirmedGoals?.() ?? [];
    goals = [];
    for (const g of body.goals) {
      const goal = confirmed.find((x) => x.id === g.goal_id);
      if (!goal) return fail(422, `goals: ${g.goal_id} is not a confirmed goal`);
      goals.push({ goal_id: goal.id, key: goal.key, contribution: g.contribution ?? 1 });
    }
  }
  if (body.text != null && (!body.text.trim() || body.text.length > 1000)) return fail(422, "text: 1 to 1000 characters");
  keepOriginal(row);
  if (body.decision != null) {
    row.decision = body.decision as never;
    row.decision_reason = body.decision === "exclude" ? (reason as string) : (body.decision_reason ?? null);
  }
  if (body.text != null) {
    row.text = body.text;
    if (!feature) row.title = body.text.slice(0, 200);
  }
  if (body.acceptance && !feature) (row as ScopeRequirement).acceptance = body.acceptance;
  if (feature) {
    const f = row as ScopeFeature;
    if (goals) f.goals = goals;
    if (body.depends_on) f.depends_on = body.depends_on;
    if (body.blocker_keys) f.blocker_keys = body.blocker_keys;
  }
  Object.assign(row, { decided_by: by, decided_at: ctx.now(), lock_version: (row.lock_version ?? 1) + 1 });
  return null;
}

function addRequirement(ctx: Ctx, scope: StoredScope, f: ScopeFeature, text: string, acceptance: string[], by: string): ScopeRequirement | Response {
  if (!text?.trim() || text.length > 1000) return fail(422, "text: 1 to 1000 characters");
  if (acceptance.some((a) => !a.trim() || a.length > 500)) return fail(422, "acceptance: each line 1 to 500 characters");
  const base = `${f.key}-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}` || `${f.key}-requirement`;
  const keys = new Set(scope.features.flatMap((x) => x.requirements.map((q) => q.key)));
  let key = base;
  for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
  const q: ScopeRequirement = {
    id: ctx.uuid(),
    key,
    title: text.slice(0, 200),
    text,
    acceptance,
    decision: "keep",
    decision_reason: null,
    origin: "person",
    entity_id: null,
    proposal_id: null,
    position: f.requirements.length + 1,
    lock_version: 1,
    original: null,
    decided_by: by,
    decided_at: ctx.now(),
  };
  f.requirements.push(q);
  return q;
}

/** After a write: re-check, bump the draft (D8), and the tally. */
function done(ctx: Ctx, scope: StoredScope, by: string) {
  recheck(ctx.db, scope);
  const { cp } = checkpointOf(ctx.db, scope);
  if (!cp) return { revision: 0, summary: summaryOf(scope, []).summary };
  const draft = draftOf(ctx.db, cp.id);
  draft.revision += 1;
  draft.log.push({ revision: draft.revision, by: nameOf(ctx, by) ?? "Someone" });
  scope.lock_version += 1;
  return { revision: draft.revision, summary: summaryOf(scope, draft.actions).summary };
}

function itemOut(found: Found, row: Row, out: { revision: number; summary: Schemas["ScopeSummary"] }, scope: StoredScope): Schemas["ScopeItemOut"] {
  const feature = !found.requirement;
  return {
    id: row.id,
    kind: feature ? "feature" : "requirement",
    key: row.key,
    parent_id: feature ? null : found.feature.id,
    title: row.title,
    text: row.text ?? null,
    acceptance: feature ? [] : (row as ScopeRequirement).acceptance,
    decision: row.decision,
    decision_reason: row.decision_reason ?? null,
    origin: row.origin,
    goals: feature ? (row as ScopeFeature).goals : found.feature.goals,
    depends_on: feature ? (row as ScopeFeature).depends_on : [],
    blocker_keys: feature ? (row as ScopeFeature).blocker_keys : [],
    lock_version: row.lock_version ?? 1,
    edited: edited(row),
    added: added(row),
    original: row.original ?? {},
    summary: out.summary,
    revision: out.revision,
    scope_lock_version: scope.lock_version,
  };
}

/**
 * D8 for feature_set: an approver's Accept of a commenter's suggested edit or add applies it
 * to the row (decided by the approver). Returns the refusal, or null once applied.
 */
export function applySuggestion(ctx: Ctx, runId: string, a: Action, by: string): Response | null {
  const scope = latestScope(ctx.db, runId);
  if (!scope || scope.status !== "proposed") return fail(409, DECIDED);
  if (a.kind === "add") {
    const v = (a.value ?? {}) as { parent?: string; text?: string; acceptance?: string[] };
    const f = scope.features.find((x) => x.key === (v.parent ?? a.item_key));
    if (!f) return fail(422, `no feature ${v.parent ?? a.item_key} in this feature set`);
    const q = addRequirement(ctx, scope, f, v.text ?? "", v.acceptance ?? [], by);
    if (q instanceof Response) return q;
  } else {
    const found = findRow(scope, (r) => r.key === a.item_key);
    if (!found) return fail(422, `no row ${a.item_key} in this feature set`);
    const v = a.value as unknown;
    const patch: Patch = {};
    if (a.field === "decision") {
      const d = (typeof v === "string" ? { decision: v } : (v ?? {})) as { decision?: string; reason?: string };
      Object.assign(patch, { decision: d.decision, decision_reason: d.reason ?? null });
    } else if (a.field === "text") patch.text = String(v ?? "");
    else if (a.field === "acceptance") patch.acceptance = (v as string[]) ?? [];
    else if (a.field === "goals") patch.goals = (v as Schemas["ScopeGoalIn"][]) ?? [];
    else if (a.field === "depends_on") patch.depends_on = (v as string[]) ?? [];
    else if (a.field === "blocker_keys") patch.blocker_keys = (v as string[]) ?? [];
    const refused = applyChange(ctx, scope, found, patch, by);
    if (refused) return refused;
  }
  recheck(ctx.db, scope);
  scope.lock_version += 1;
  return null;
}

/** The fields a feature_set edit action may name (D8 vocabulary for this kind). */
export const SCOPE_EDIT_FIELDS = ["decision", "text", "acceptance", "goals", "depends_on", "blocker_keys"];

/** A person's edits since the agents wrote it (for the send-back's "with at least one change"). */
export function scopeEdits(db: RunsDb, runId: string): number {
  const scope = latestScope(db, runId);
  if (!scope || scope.status !== "proposed") return 0;
  return scope.features.reduce((n, f) => n + (edited(f) ? 1 : 0) + f.requirements.filter(edited).length, 0);
}

/**
 * qa-work-1: a feature set's send-back entries, as the API's scope_review.scope_entries: one
 * per row a person changed (its new decision, or "edit"; "add" for a requirement they added),
 * the draft's questions, and the waivers; null without a proposed scope.
 */
export function scopeSendBack(db: RunsDb, runId: string, staged: Action[]): { entries: Record<string, unknown>[]; waived: Record<string, unknown>[]; keys: string[] } | null {
  const scope = latestScope(db, runId);
  if (!scope || scope.status !== "proposed") return null;
  const entries: Record<string, unknown>[] = [];
  const rows: Row[] = [...scope.features.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)), ...scope.features.flatMap((f) => f.requirements)];
  for (const r of rows) {
    if (!edited(r)) continue;
    if (added(r)) {
      const parent = scope.features.find((f) => f.requirements.includes(r as ScopeRequirement));
      entries.push({ id: r.key, action: "add", changes: { parent: parent?.key ?? null, text: r.text ?? null, acceptance: [...((r as ScopeRequirement).acceptance ?? [])] } });
    } else if (r.decision !== r.original!.decision) {
      entries.push({ id: r.key, action: r.decision !== "keep" ? r.decision : "edit", ...(r.decision_reason ? { note: r.decision_reason } : {}) });
    } else entries.push({ id: r.key, action: "edit" });
  }
  const waived: Record<string, unknown>[] = [];
  for (const a of staged) {
    if (a.kind === "waive") {
      const why = (a.value as { reason?: string } | null)?.reason ?? null;
      for (const code of a.answers?.length ? a.answers : [null]) waived.push({ id: a.item_key, code, reason: why });
    } else if (a.kind === "question") entries.push({ id: a.item_key, action: "question", question: (a.value as { text?: string } | null)?.text ?? null });
  }
  return { entries, waived, keys: scope.features.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((f) => f.key) };
}

/** The requirements a person added or edited, for Approve with edits (the baseline writes). */
export function personRequirements(scope: StoredScope): { feature: ScopeFeature; requirement: ScopeRequirement; added: boolean }[] {
  return scope.features
    .filter((f) => f.decision === "include")
    .flatMap((f) => f.requirements.filter((q) => q.decision === "keep" && edited(q)).map((q) => ({ feature: f, requirement: q, added: added(q) })));
}

// ------------------------------------------------------------------------------- enhance

const ENHANCED = {
  suffix: ", and says clearly what happened when it cannot be done",
  acceptance: ["A failure names what went wrong and how to fix it", "It works with a keyboard and a screen reader"],
  edge_cases: ["The buyer loses their connection half-way", "Two tabs change the same row at once"],
  data_needs: ["How often this fails today, per week"],
};

function enhanceJob(ctx: Ctx, scope: StoredScope, f: ScopeFeature, q: ScopeRequirement, instruction: string | null): Job {
  const text = (q.text ?? q.title).replace(/[.\s]+$/, "");
  return {
    id: ctx.uuid(),
    kind: "scope_enhance",
    document_id: scope.document_id ?? null,
    scope_id: scope.id,
    version_number: null,
    section_key: null,
    status: "queued",
    // Only what the model needs: the requirement, its feature and the feature's goals.
    input: { item_id: q.id, text: q.text ?? q.title, acceptance: q.acceptance, feature: { key: f.key, title: f.title }, goals: f.goals.map((g) => g.key), instruction },
    output: { item_id: q.id, text: `${text}${ENHANCED.suffix}`, acceptance: [...q.acceptance, ...ENHANCED.acceptance], edge_cases: ENHANCED.edge_cases, data_needs: ENHANCED.data_needs },
    account_label: null,
    via: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    attempts: 0,
    error: null,
    error_reason: null,
    next_reset_at: null,
    requested_by: ctx.member?.id ?? ctx.userId,
    created_at: ctx.now(),
    started_at: null,
    finished_at: null,
  };
}

/** GET /v1/llm-jobs/{id} for a scope_enhance job: it finishes on its first poll. */
export function scopeJobRoute(db: RunsDb | undefined, p: string[], now: () => string): Response | null {
  const jobs = (db as (RunsDb & { scope_jobs?: Job[] }) | undefined)?.scope_jobs;
  const job = p[1] === "llm-jobs" && p[2] && !p[3] ? jobs?.find((j) => j.id === p[2]) : undefined;
  if (!job) return null;
  if (job.status === "queued" || job.status === "running") Object.assign(job, { status: "succeeded", attempts: 1, started_at: now(), finished_at: now() });
  return json(200, { ...job, output: job.status === "succeeded" ? job.output : null });
}

// ------------------------------------------------------------------------------- routes

/** /v1/prd-scopes/... and GET /v1/runs/{id}/scope. */
export async function routeScopes(ctx: Ctx, req: Request, p: string[]): Promise<Response | null> {
  const m = req.method;
  if (p[1] === "runs" && p.length === 4 && p[3] === "scope" && m === "GET") {
    const scope = latestScope(ctx.db, p[2]);
    if (!scope) return fail(404, `run ${p[2]} has no PRD scope`);
    prepareScope(scope);
    return json(200, scope);
  }
  if (p[1] !== "prd-scopes" || !p[2]) return null;
  const scope = scopeById(ctx.db, p[2]);
  if (!scope) return fail(404, `PRD scope ${p[2]} not found`);
  prepareScope(scope);
  if (p.length === 3 && m === "GET") return json(200, reviewOf(ctx, scope));
  if (p[3] !== "items") return fail(404, "Route not found");

  // Every write: the approver role, a proposed scope at a pending checkpoint.
  const { cp } = checkpointOf(ctx.db, scope);
  if (!atLeast(roleOf(ctx), cp?.approver_role ?? "approver")) return fail(403, `Requires the ${cp?.approver_role ?? "approver"} role: commenters suggest a change instead`);
  if (scope.status !== "proposed" || !cp || cp.status !== "pending") return fail(409, DECIDED);
  const by = ctx.member?.id ?? ctx.userId;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;

  if (p.length === 4 && m === "POST") {
    const input = await body<Schemas["ScopeRequirementIn"]>();
    const f = scope.features.find((x) => x.id === input.parent_id);
    if (!f) return fail(422, "parent_id: not a feature of this scope");
    const q = addRequirement(ctx, scope, f, input.text, input.acceptance ?? [], by);
    if (q instanceof Response) return q;
    return json(201, itemOut({ feature: f, requirement: q }, q, done(ctx, scope, by), scope));
  }
  const found = findRow(scope, (r) => r.id === p[4]);
  if (!found) return fail(404, `row ${p[4]} not found`);
  const row: Row = found.requirement ?? found.feature;
  if (p.length === 5 && m === "PATCH") {
    const input = await body<Schemas["ScopeItemPatch"]>();
    if (input.lock_version !== (row.lock_version ?? 1)) return fail(409, STALE);
    const refused = applyChange(ctx, scope, found, input, by);
    if (refused) return refused;
    return json(200, itemOut(found, row, done(ctx, scope, by), scope));
  }
  if (p.length === 5 && m === "DELETE") {
    if (!found.requirement || !added(found.requirement)) return fail(409, "Only a requirement a person added is removed: cut it instead");
    found.feature.requirements = found.feature.requirements.filter((q) => q !== found.requirement);
    done(ctx, scope, by);
    return new Response(null, { status: 204 });
  }
  if (p[5] === "enhance" && p.length === 6 && m === "POST") {
    if (!found.requirement) return fail(422, "Only a requirement is enhanced");
    const input = (await body<Schemas["ScopeEnhanceIn"]>()) ?? {};
    const job = enhanceJob(ctx, scope, found.feature, found.requirement, input.instruction ?? null);
    const db = ctx.db as RunsDb & { scope_jobs?: Job[] };
    (db.scope_jobs ??= []).push(job);
    return json(202, { ...job, output: null });
  }
  if (p[5] === "enhance" && p[7] === "accept" && m === "POST") {
    const job = (ctx.db as RunsDb & { scope_jobs?: Job[] }).scope_jobs?.find((j) => j.id === p[6]);
    if (!job || job.input.item_id !== row.id) return fail(404, "Enhancement not found");
    if (job.status !== "succeeded") return fail(409, "The enhancement is not ready yet");
    const input = (await body<Schemas["ScopeEnhanceAccept"]>()) ?? {};
    const out = job.output as { text: string; acceptance: string[] };
    const refused = applyChange(ctx, scope, found, { text: input.text ?? out.text, acceptance: input.acceptance ?? out.acceptance }, by);
    if (refused) return refused;
    row.origin = "person";
    return json(200, itemOut(found, row, done(ctx, scope, by), scope));
  }
  return fail(404, "Route not found");
}

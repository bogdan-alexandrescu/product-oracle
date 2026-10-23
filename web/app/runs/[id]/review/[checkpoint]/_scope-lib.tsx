"use client";

import type { Schemas } from "@/lib/api/client";

export type Scope = Schemas["PrdScopeReview"];
export type Feature = Scope["features"][number];
export type Requirement = Feature["requirements"][number];
export type Reason = Schemas["ScopeReason"];
export type Review = Schemas["CheckpointReview"];
export type Action = Schemas["ReviewAction"];
export type ActionIn = Schemas["ActionIn"];
export type Patch = Partial<Omit<Schemas["ScopeItemPatch"], "lock_version">>;
export type LlmJob = Schemas["LlmJobOut"];

/** approver: decides and edits rows; commenter: suggests (D8 "suggested"); viewer: reads. */
export type Mode = "approver" | "commenter" | "viewer";

export const LEAVE_OUT_REASONS = [
  { value: "no_goal", label: "No goal" },
  { value: "not_now", label: "Not now" },
  { value: "out_of_scope", label: "Out of scope" },
  { value: "duplicate", label: "Duplicate" },
] as const;

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith("other:")) return reason.slice(6).trim() || "Other";
  return LEAVE_OUT_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

export function decisionText(decision: string, reason?: string | null): string {
  if (decision === "exclude") return ["Left out", reasonLabel(reason)].filter(Boolean).join(" · ");
  if (decision === "defer") return "Deferred to a later PRD";
  if (decision === "cut") return "Requirement cut";
  if (decision === "keep") return "Kept";
  return "Included";
}

/** What a row's person changed, in a few words ("Left out · No goal", "Goal set"). */
export function changeText(row: Feature): string {
  const o = row.history.original as Record<string, unknown>;
  if (o.decision !== undefined && o.decision !== row.decision) return decisionText(row.decision, row.decision_reason);
  if (o.decision_reason !== undefined && o.decision_reason !== (row.decision_reason ?? null)) return decisionText(row.decision, row.decision_reason);
  if (JSON.stringify(o.goals ?? []) !== JSON.stringify(row.goals)) return row.goals.length ? "Goal set" : "Serves no goal";
  if (JSON.stringify(o.depends_on ?? []) !== JSON.stringify(row.depends_on)) return "Dependency removed";
  if (JSON.stringify(o.blocker_keys ?? []) !== JSON.stringify(row.blocker_keys)) return "Blocker removed";
  return "Edited";
}

/** A suggestion or staged action in words: "Leave out · Not now", "Keep", "Add requirement: …". */
export function describeAction(a: Pick<Action, "kind" | "field" | "value" | "answers">, title: (key: string) => string = (k) => k): string {
  if (a.kind === "edit" && a.field === "decision") {
    const v = (typeof a.value === "string" ? { decision: a.value } : (a.value ?? {})) as { decision?: string; reason?: string };
    if (v.decision === "exclude") return ["Leave out", reasonLabel(v.reason)].filter(Boolean).join(" · ");
    if (v.decision === "defer") return "Defer to a later PRD";
    if (v.decision === "cut") return "Cut";
    if (v.decision === "keep") return "Keep";
    return "Include";
  }
  if (a.kind === "edit" && a.field === "depends_on") return "Remove dependency";
  if (a.kind === "edit" && a.field === "goals") return "Change goals";
  if (a.kind === "edit" && a.field === "blocker_keys") return "Remove blocker";
  if (a.kind === "edit") return `Edit ${a.field ?? "row"}`;
  if (a.kind === "add") return `Add requirement: ${((a.value ?? {}) as { text?: string }).text ?? ""}`;
  if (a.kind === "accept") return "Keep";
  if (a.kind === "waive") return `Waive (${((a.value ?? {}) as { reason?: string }).reason ?? "no reason"})`;
  if (a.kind === "question") return "Question";
  return `${a.kind} ${title(a.field ?? "")}`.trim();
}

/** The writes a row's fixes call: the parent screen does them and reloads. */
export type Ops = {
  patch: (row: { id: string; lock_version: number }, body: Patch) => Promise<void>;
  /** A D8 action on a row's key: staged for an approver, a suggestion for a commenter. */
  act: (body: ActionIn) => Promise<void>;
  removeAction: (id: string) => Promise<void>;
  stage: (id: string) => Promise<void>;
  add: (parentId: string, text: string, acceptance: string[]) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  enhance: (itemId: string) => Promise<LlmJob>;
  acceptEnhance: (itemId: string, jobId: string, body: { text?: string; acceptance?: string[] }) => Promise<void>;
};

/** What a fix opens in place: the leave-out reasons, the goals picker, the waiver note. */
export type Ui = {
  leaveOut: (f: Feature, preset?: string) => void;
  pickGoal: (f: Feature) => void;
  waive: (f: Feature, code: string) => void;
};

export type Fix = { label: string; run: () => Promise<void> | void };

/** Sets a row's decision: a person's write for an approver, a suggestion for a commenter. */
export function setDecision(mode: Mode, ops: Ops, row: { id: string; key: string; lock_version: number }, decision: string, reason?: string | null) {
  if (mode === "approver") return ops.patch(row, { decision: decision as Patch["decision"], decision_reason: reason ?? null });
  return ops.act({ item_key: row.key, kind: "edit", field: "decision", value: { decision, ...(reason ? { reason } : {}) }, answers: [] });
}

function setField(mode: Mode, ops: Ops, f: Feature, field: "depends_on" | "blocker_keys" | "goals", value: unknown) {
  if (mode === "approver") return ops.patch(f, { [field]: value } as Patch);
  return ops.act({ item_key: f.key, kind: "edit", field, value, answers: [] });
}

/** The one-click fixes of a reason (C7 "Reasons and their one-click fixes"); a commenter's are suggestions. */
export function fixesFor(reason: Reason, f: Feature, scope: Scope, mode: Mode, ops: Ops, ui: Ui): Fix[] {
  if (mode === "viewer") return [];
  const byKey = new Map(scope.features.map((x) => [x.key, x]));
  const approver = mode === "approver";
  const keep = (label: string): Fix => ({ label, run: () => ops.act({ item_key: f.key, kind: "accept", answers: [reason.code] }) });
  const leaveOut: Fix = { label: "Leave out", run: () => ui.leaveOut(f) };
  const defer: Fix = { label: "Defer", run: () => setDecision(mode, ops, f, "defer") };
  const waive: Fix | null = approver && reason.waivable ? { label: "Waive", run: () => ui.waive(f, reason.code) } : null;
  const removeDeps = (keys: string[]): Fix => ({ label: "Remove dependency", run: () => setField(mode, ops, f, "depends_on", f.depends_on.filter((d) => !keys.includes(d))) });
  let fixes: (Fix | null)[];
  switch (reason.code) {
    case "depends_on_excluded": {
      const dep = f.depends_on.map((d) => byKey.get(d)).find((d) => d && d.decision !== "include");
      fixes = dep
        ? [{ label: `Include ${dep.title}`, run: () => setDecision(mode, ops, dep, "include") }, removeDeps([dep.key]), { label: "Leave this out too", run: () => ui.leaveOut(f) }, waive]
        : [waive];
      break;
    }
    case "dependency_cycle":
      fixes = [f.depends_on.length ? removeDeps([f.depends_on[f.depends_on.length - 1]]) : null, waive];
      break;
    case "unknown_goal":
      fixes = [{ label: "Pick a goal", run: () => ui.pickGoal(f) }, { label: "Serves no goal", run: () => setField(mode, ops, f, "goals", []) }];
      break;
    case "unknown_dependency":
      fixes = [removeDeps(f.depends_on.filter((d) => !byKey.has(d)))];
      break;
    case "unknown_blocker":
      fixes = [{ label: "Remove blocker", run: () => setField(mode, ops, f, "blocker_keys", []) }, waive];
      break;
    case "unknown_feature":
    case "unknown_requirement":
      fixes = [leaveOut];
      break;
    case "serves_no_goal":
      fixes = [leaveOut, { label: "Pick a goal", run: () => ui.pickGoal(f) }, keep("Keep anyway")];
      break;
    case "low_confidence":
    case "linked_blocker":
      fixes = [keep("Keep"), defer];
      break;
    case "new_feature":
      fixes = [keep("Keep"), leaveOut];
      break;
    case "duplicate_of_existing":
      fixes = [{ label: "Leave out", run: () => setDecision(mode, ops, f, "exclude", "duplicate") }, keep("Keep")];
      break;
    default:
      fixes = reason.severity === "blocking" ? [waive] : [keep("Keep")];
  }
  const out = fixes.filter((x): x is Fix => !!x);
  // A commenter's Waive is never offered; every other fix becomes a suggestion.
  return approver ? out : out.map((x) => ({ ...x, label: `Suggest ${x.label}` }));
}

/** The D8 actions on a row's key, by state. */
export function actionsOn(review: Review | null, key: string): Action[] {
  return review?.items.find((i) => i.key === key)?.actions ?? [];
}

export const pct = (c: number | null | undefined) => (c == null ? null : Math.round(c * 100));

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
  if (a.kind === "accept") return "Include";
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

/**
 * `decision`: the fix is one of the feature's own decisions (Include, Leave out, Defer to a later
 * PRD), which the inspector's Decision control offers once, in the same words. `short`: a
 * commenter's label without its "Suggest" (qa4-work-39: the row's column is headed Suggest).
 */
export type Fix = { label: string; run: () => Promise<void> | void; title?: string; decision?: boolean; short?: string };

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
  // qa-work-9: one word for keeping a feature in the set, as the Decision control says it (Include).
  const keep = (label: string): Fix => ({ label, decision: true, run: () => ops.act({ item_key: f.key, kind: "accept", answers: [reason.code] }) });
  const leaveOut: Fix = { label: "Leave out", decision: true, run: () => ui.leaveOut(f) };
  // qa4-work-41: the row's decisions read as the inspector's Decision control (Include, Leave out, Defer to a later PRD).
  const defer: Fix = { label: "Defer to a later PRD", decision: true, run: () => setDecision(mode, ops, f, "defer") };
  const waive: Fix | null = approver && reason.waivable ? { label: "Waive", run: () => ui.waive(f, reason.code) } : null;
  const removeDeps = (keys: string[]): Fix => ({ label: "Remove dependency", run: () => setField(mode, ops, f, "depends_on", f.depends_on.filter((d) => !keys.includes(d))) });
  let fixes: (Fix | null)[];
  switch (reason.code) {
    case "depends_on_excluded": {
      const dep = f.depends_on.map((d) => byKey.get(d)).find((d) => d && d.decision !== "include");
      fixes = dep
        ? // qa-work-12: a short label on one line; the dependency is named in the reason chip and the tooltip.
          [{ label: "Include dependency", title: `Include ${dep.title}`, run: () => setDecision(mode, ops, dep, "include") }, removeDeps([dep.key]), leaveOut, waive]
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
      fixes = [leaveOut, { label: "Pick a goal", run: () => ui.pickGoal(f) }, keep("Include")];
      break;
    case "low_confidence":
    case "linked_blocker":
      fixes = [keep("Include"), defer];
      break;
    case "new_feature":
      fixes = [keep("Include"), leaveOut];
      break;
    case "duplicate_of_existing":
      fixes = [{ label: "Leave out", decision: true, run: () => setDecision(mode, ops, f, "exclude", "duplicate") }, keep("Include")];
      break;
    default:
      fixes = reason.severity === "blocking" ? [waive] : [keep("Include")];
  }
  const out = fixes.filter((x): x is Fix => !!x);
  // A commenter's Waive is never offered; every other fix becomes a suggestion.
  return approver ? out : out.map((x) => ({ ...x, label: `Suggest ${x.label}`, short: x.label }));
}

/** The D8 actions on a row's key, by state. */
export function actionsOn(review: Review | null, key: string): Action[] {
  return review?.items.find((i) => i.key === key)?.actions ?? [];
}

/** A key in words ("shared-address-book-export" is "Shared address book export"), for a row the agents left untitled. */
export function keyWords(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The scope with every feature named (rirs-2): a row whose title is only its key reads as words. */
export function named(scope: Scope): Scope {
  return { ...scope, features: scope.features.map((f) => (f.title && f.title !== f.key ? f : { ...f, title: keyWords(f.key) })) };
}

/** A goal's name: its title in the baseline, else plain words, never its key (rirs-2). */
export function goalName(scope: Scope, key: string): string {
  return scope.goals_available.find((g) => g.key === key)?.title ?? "A goal not in the baseline";
}

/**
 * A reason in words (rirs-2): the check names features by key ("bulk-address-edit depends on
 * shared-address-book-export, which is excluded"); the page names them by title.
 */
export function reasonText(reason: Pick<Reason, "label">, scope: Scope): string {
  const byKey = new Map(scope.features.map((x) => [x.key, x.title]));
  const text = reason.label
    .replace(/[a-z0-9]+(?:[-_][a-z0-9]+)+/g, (k) => byKey.get(k) ?? k.replace(/[-_]+/g, " "))
    .replace(/, which is excluded\b/g, ", which is left out")
    .replace(/, which is not a feature\b/g, ", which is not in this feature set");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const pct = (c: number | null | undefined) => (c == null ? null : Math.round(c * 100));

/**
 * qa-work-9: the Decision control's Include on a feature the set already includes answers its
 * open to-confirm reasons (what a row's Include fix does); on a left-out or deferred feature
 * it includes it again.
 */
export function includeFeature(mode: Mode, ops: Ops, f: Feature): Promise<void> | void {
  if (f.decision !== "include") return setDecision(mode, ops, f, "include");
  // Each reason keeps its own call (one Keep each), so the ones kept before stay kept.
  const codes = f.reasons.filter((r) => !r.answered && r.severity !== "blocking").map((r) => r.code);
  return codes.reduce<Promise<void>>((done, code) => done.then(() => ops.act({ item_key: f.key, kind: "accept", answers: [code] })), Promise.resolve());
}

/** qa-work-16: what the agents proposed, in the Decision control's words ("Oracle proposes: Include"). */
export function proposedText(decision: string): string {
  return `Oracle proposes: ${{ exclude: "Leave out", defer: "Defer to a later PRD" }[decision] ?? "Include"}`;
}

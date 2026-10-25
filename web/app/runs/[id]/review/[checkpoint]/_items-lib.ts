import type { Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";

export type Review = Schemas["CheckpointReview"];
export type Item = Schemas["ReviewItem"];
export type Reason = Schemas["ItemReason"];
export type Fix = Schemas["ReasonFix"];
export type Action = Schemas["ReviewAction"];
export type Mode = "approver" | "commenter" | "viewer";

export const HORIZONS = ["now", "next", "later"] as const;
export const HORIZON_LABEL: Record<string, string> = { now: "Now", next: "Next", later: "Later" };
export const horizonLabel = (h: string | null | undefined) => (h ? (HORIZON_LABEL[h] ?? h) : "Not in the file");

/** Actions a person stages that change the file (D7 Approve with edits applies them). */
export const EDIT_KINDS = ["edit", "drop", "restore"];
/** Actions only the agents can carry out (D7 needs_agents). */
export const AGENT_KINDS = ["split", "merge"];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const day = (d: string) => calendarDay(d, { month: "short", day: "numeric", year: "numeric" });

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether `a` is the fix `f` (the same kind, field and value on the same item). */
export function isFix(a: Pick<Action, "item_key" | "kind" | "field" | "value">, f: Fix): boolean {
  return a.item_key === f.action.item && a.kind === f.action.kind && (a.field ?? null) === (f.action.field ?? null) && same(a.value, f.action.value);
}

/** What an action does, in words: "Date removed", "Moved to Later", "Dropped". */
export function doneText(a: Pick<Action, "kind" | "field" | "value">, title: (key: string) => string = (k) => k): string {
  if (a.kind === "accept") return "Accepted";
  if (a.kind === "waive") return "Waived";
  if (a.kind === "drop") return "Dropped";
  if (a.kind === "restore") return "Kept";
  if (a.kind === "split") return "Split";
  if (a.kind === "merge") return "Merged";
  if (a.kind === "question") return "Asked";
  if (a.kind === "edit") {
    if (a.field === "milestone_date") return a.value == null ? "Date removed" : "Date changed";
    if (a.field === "milestone_name") return "Milestone renamed";
    if (a.field === "horizon") return `Moved to ${horizonLabel(String(a.value))}`;
    if (a.field === "outcome") return "Outcome edited";
    if (a.field === "title") return "Title edited";
    if (a.field === "prd_section") return "Section linked";
    if (a.field === "depends_on") {
      const v = (a.value ?? {}) as { add?: string[]; remove?: string[] };
      return v.add?.length ? `Depends on ${v.add.map(title).join(", ")}` : "Dependency removed";
    }
  }
  return "Changed";
}

/** A suggestion in words: the fix's own label when it is one ("Remove date"), else what it does. */
export function describe(a: Action, item: Item | undefined, title: (key: string) => string): string {
  for (const r of item?.reasons ?? []) for (const f of r.fixes) if (isFix(a, f)) return f.label;
  return doneText(a, title);
}

export const openReasons = (it: Item, actions: Action[] = it.actions): Reason[] =>
  it.reasons.filter(
    (r) => !actions.some((a) => a.state === "staged" && a.kind !== "question" && (a.kind === "waive" || !a.answers.length || a.answers.includes(r.code))),
  );

/** The reasons that may be waived (D3): blocking, never a date. */
export const DATE_CODES = ["unverified_date", "date_without_basis", "date_refused"];
/** H4 §5 drift reasons (advisory, to confirm): acted on or waived with a reason, never a plain Accept. */
export const DRIFT_CODES = ["outside_strategy", "stopped_but_planned"];
export const waivable = (r: Reason) =>
  DRIFT_CODES.includes(r.code) || (r.severity === "blocking" && !DATE_CODES.includes(r.code) && !r.code.startsWith("date_"));
/** A planned item the strategy stops is an owner's to waive (as the API); pass can("waive_strategy_finding"). */
export const mayWaive = (r: Reason, owner: boolean) => waivable(r) && (r.code !== "stopped_but_planned" || owner);

/** The fixes a row offers first: a blocking reason's first two, else Accept and the first other fix. */
export function rowFixes(open: Reason[]): { reason: Reason; fix: Fix }[] {
  const blocking = open.find((r) => r.severity === "blocking");
  if (blocking) return blocking.fixes.filter((f) => f.action.kind !== "waive").slice(0, 2).map((fix) => ({ reason: blocking, fix }));
  const r = open[0];
  if (!r) return [];
  if (DRIFT_CODES.includes(r.code)) return r.fixes.filter((f) => f.action.kind !== "waive").slice(0, 2).map((fix) => ({ reason: r, fix }));
  const accept = r.fixes.find((f) => f.action.kind === "accept") ?? { label: "Accept", action: { kind: "accept" as const, item: r.item, field: null, value: null } };
  const other = r.fixes.find((f) => f.action.kind !== "accept" && f.action.kind !== "waive");
  return [{ reason: r, fix: { ...accept, label: "Accept" } }, ...(other ? [{ reason: r, fix: other }] : [])];
}

const RESOLUTION: Record<string, string> = { done: "Done", declined: "Declined", not_applied: "Not applied" };
export const resolutionText = (r: Schemas["ResolutionEntry"]) => (r.outcome === "declined" && r.note ? `Declined: ${r.note}` : RESOLUTION[r.outcome]);

export const show = (v: unknown): string => (v == null ? "none" : Array.isArray(v) ? v.join(", ") || "none" : typeof v === "object" ? JSON.stringify(v) : String(v));

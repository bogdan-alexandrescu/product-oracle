import type { Schemas } from "@/lib/api/client";
import { formatCount, formatDate, plural } from "@/lib/format";

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

export { plural };
/** "Nov 30, 2026". */
export const day = (d: string) => formatDate(d);

/** A calendar day as the API writes it ("2026-11-30", or "2026-11-30T…" with a time). */
const ISO_DAY_SOURCE = String.raw`\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?`;
/** Such a day standing alone in a sentence: never one inside a key, a slug or a path ("launch-2026-11-30"). */
const ISO_DAY = new RegExp(String.raw`(?<![\w./-])${ISO_DAY_SOURCE}(?![\w/-])`, "g");
/** A value that is a day and nothing else. */
const ONLY_DAY = new RegExp(`^${ISO_DAY_SOURCE}$`);
/**
 * A sentence of the API's (a reason's text) with its dates in words: "… supports 2026-11-30."
 * reads "… supports Nov 30, 2026." (qa-work-19). A date inside a key stays as it is:
 * "launch-2026-11-30" is a name, not a date.
 */
export const datesInWords = (text: string) => text.replace(ISO_DAY, (d) => formatDate(d));

/**
 * Who decides a stop, in words: "Approvers and owners decide" (the role ladder: viewer < commenter < approver < owner).
 * `approverRole` is the stop's least role to decide (the checkpoint's approver_role), not the signed-in role.
 */
export function decidersText(approverRole: string | null | undefined): string {
  if (approverRole === "owner") return "Owners decide";
  if (approverRole === "commenter") return "Commenters, approvers and owners decide";
  if (approverRole === "viewer") return "Any member decides";
  return "Approvers and owners decide";
}

/**
 * The counts of a Roadmap items review, one definition for the review screen and the run page
 * (qa-work-3, qa-work-4). Every number counts items (rows), never reasons:
 * - `inFile`: the items in the checked file; `dropped`: the items only a reason or an action
 *   names (in the base, not in this file: a dropped item is a decision too); `total` = both.
 * - `needYou`: the items with at least one reason (handled or not), the "Needs you" filter;
 *   `needYou` = `blocking` + `toConfirm` + `handled`.
 * - `blocking`: the items with a blocking reason still open; `toConfirm`: the items with an open
 *   reason, none of them blocking; `handled`: the items whose every reason is answered by a
 *   staged action (the draft's, so a staged fix counts at once on both pages).
 * - `waiting`: of the open ones, the items waiting on a teammate's answer.
 */
export type ReviewCounts = { inFile: number; dropped: number; total: number; needYou: number; blocking: number; toConfirm: number; handled: number; waiting: number };

export function reviewCounts(review: Pick<Review, "items">): ReviewCounts {
  const out: ReviewCounts = { inFile: 0, dropped: 0, total: 0, needYou: 0, blocking: 0, toConfirm: 0, handled: 0, waiting: 0 };
  for (const it of review.items) {
    out.total += 1;
    if (it.position != null) out.inFile += 1;
    else out.dropped += 1;
    if (!it.reasons.length) continue;
    out.needYou += 1;
    const open = openReasons(it);
    if (!open.length) out.handled += 1;
    else if (open.some((r) => r.severity === "blocking")) out.blocking += 1;
    else out.toConfirm += 1;
    if (open.length && it.state === "waiting") out.waiting += 1;
  }
  return out;
}

/** "3 blocking · 7 to confirm" (both counts of items, as reviewCounts); "Nothing open" when both are 0. */
export const openText = (c: Pick<ReviewCounts, "blocking" | "toConfirm">) =>
  c.blocking || c.toConfirm ? `${formatCount(c.blocking)} blocking · ${formatCount(c.toConfirm)} to confirm` : "Nothing open";

/** "9 items" or "9 items + 1 dropped": the rows of the review, the dropped ones apart. */
export const itemsText = (c: Pick<ReviewCounts, "inFile" | "dropped">) =>
  c.dropped ? `${plural(c.inFile, "item")} + ${formatCount(c.dropped)} dropped` : plural(c.inFile, "item");

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

/**
 * As the API: a staged action answers a reason it names and every reason of its item when it
 * names none, but a waiver naming none never one only an owner waives (H4 §5). Questions answer nothing.
 */
export const answersReason = (a: Action, r: Reason) =>
  a.state === "staged" && a.kind !== "question" && (a.answers.length ? a.answers.includes(r.code) : a.kind !== "waive" || r.code !== "stopped_but_planned");

export const openReasons = (it: Item, actions: Action[] = it.actions): Reason[] => it.reasons.filter((r) => !actions.some((a) => answersReason(a, r)));

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

const FIELD_WORDS: Record<string, string> = {
  title: "Title",
  outcome: "Outcome",
  horizon: "Horizon",
  milestone: "Milestone",
  milestone_date: "Milestone date",
  milestone_name: "Milestone name",
  depends_on: "Depends on",
  prd_section: "PRD section",
  confidence: "Confidence",
  priority: "Priority",
  position: "Place in the file",
};
/** A changed field in words: "milestone_date" is "Milestone date". */
export const fieldWords = (field: string) => {
  const words = FIELD_WORDS[field] ?? field.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
/** Fields whose values are keys or names (an item's key, a PRD section): shown as written. */
const KEY_FIELDS = ["depends_on", "prd_section", "key", "id"];
/**
 * A changed field's value in words: a horizon by its name, a value that is a date as
 * "Nov 30, 2026", the dates in a sentence (a title, an outcome) in words; a key is shown as
 * written ("launch-2026-11-30" stays).
 */
export function showValue(field: string, v: unknown): string {
  if (field === "horizon" && typeof v === "string") return horizonLabel(v);
  const text = show(v);
  if (ONLY_DAY.test(text)) return formatDate(text);
  return KEY_FIELDS.includes(field) ? text : datesInWords(text);
}

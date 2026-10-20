import type { CommentOut, FeedbackItem } from "@/lib/api/client";

/*
 * The review panel's one feedback list (I3 PRD navigation, 2026-10-20): comments, Oracle
 * suggestions and section reviews, each in one of four states (C1e: Open, Staged, Declined,
 * Done). "Open feedback" has ONE definition, used by the panel head, the Feedback tab's
 * count, the outline's per-section pills and the switcher: open comments + open
 * suggestions + open change requests.
 */

export type FeedbackState = "open" | "staged" | "declined" | "done";
export type FeedbackKind = "comment" | "suggestion" | "review";

export const FEEDBACK_STATES: FeedbackState[] = ["open", "staged", "declined", "done"];
export const FEEDBACK_STATE_LABEL: Record<FeedbackState, string> = {
  open: "Open",
  staged: "Staged",
  declined: "Declined",
  done: "Done",
};
export const FEEDBACK_KINDS: FeedbackKind[] = ["comment", "suggestion", "review"];
export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  comment: "Comments",
  suggestion: "Suggestions",
  review: "Reviews",
};

/** A suggestion Oracle made with something to accept (not "no change" and not a duplicate). */
function liveSuggestion(f: FeedbackItem) {
  const s = f.suggestion;
  return s && s.status !== "superseded" && (s.kind === "section_text" || s.kind === "answer") ? s : null;
}

export function feedbackKind(f: FeedbackItem): FeedbackKind {
  if (liveSuggestion(f)) return "suggestion";
  return f.kind === "section_review" ? "review" : "comment";
}

/**
 * The item's state. Accepting a suggestion stages it for the next draft (C1e); a dismissed
 * suggestion leaves its feedback open unless the approver also declined it; a resolved
 * comment thread is done.
 */
export function feedbackState(f: FeedbackItem, comment?: Pick<CommentOut, "resolved_at"> | null): FeedbackState {
  if (f.status === "declined") return "declined";
  if (f.status === "addressed" || f.status === "superseded") return "done";
  const s = liveSuggestion(f);
  if (s?.status === "applied") return "done";
  if (s?.status === "accepted") return "staged";
  if (comment?.resolved_at) return "done";
  return "open";
}

/** Open feedback: an open comment, an open suggestion or an open change request (a changes-requested or rejected review). */
export function isOpenFeedback(f: FeedbackItem, comment?: Pick<CommentOut, "resolved_at"> | null): boolean {
  if (feedbackState(f, comment) !== "open") return false;
  return f.kind !== "section_review" || f.verdict === "changes_requested" || f.verdict === "rejected";
}

/** One row of the list: the item, the thread it came from (on this version), its kind and state. */
export type FeedbackEntry = {
  item: FeedbackItem;
  comment: CommentOut | null;
  kind: FeedbackKind;
  state: FeedbackState;
  open: boolean;
};

/**
 * The feedback that bears on version `n`: items raised on it or on an earlier version,
 * with this version's comment threads attached (their replies and Resolve).
 */
export function feedbackEntries(items: FeedbackItem[], comments: CommentOut[], n: number): FeedbackEntry[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  return items
    .filter((f) => f.raised_on_version <= n)
    .map((item) => {
      const comment = (item.comment_id && byId.get(item.comment_id)) || null;
      return { item, comment, kind: feedbackKind(item), state: feedbackState(item, comment), open: isOpenFeedback(item, comment) };
    });
}

/** Open feedback per section key. */
export function openBySection(entries: FeedbackEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) if (e.open && e.item.section_key) m.set(e.item.section_key, (m.get(e.item.section_key) ?? 0) + 1);
  return m;
}

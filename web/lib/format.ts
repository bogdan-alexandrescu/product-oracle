import { displayZone, shownDay, zoneDateTime } from "@/lib/dates";
import type { CitationOut, FeedbackStatus, JobSettings, LlmJob, LlmJobKind, Suggestion, Verdict } from "@/lib/api/client";

// #447: display dates in the Company time zone (lib/dates.ts), not the browser's.

/** "Oct 16, 2026". */
export const formatDate = (iso: string) => shownDay(iso, { month: "short", day: "numeric", year: "numeric" });
/** "Oct 16". */
export const formatDay = (iso: string) => shownDay(iso, { month: "short", day: "numeric" });
/** "Oct 19, 8:00 AM PDT". */
export const formatDateTime = (iso: string) => zoneDateTime(iso, displayZone());

export { inWords } from "@/lib/dates";

export const SOURCE_LABEL: Record<CitationOut["source"], string> = {
  slack: "Slack",
  notion: "Notion",
  gdocs: "Google Docs",
  github: "GitHub",
  fireflies: "Meeting notes",
  upload: "Upload",
  web: "Web",
  oracle: "Oracle baseline",
};

/**
 * Where a citation opens, or null when its ref is not a link: an "oracle" citation names a
 * baseline item in free text ("baseline decision <key> ..."), shown as text.
 */
export const citationHref = (c: Pick<CitationOut, "source" | "ref">): string | null => (c.source === "oracle" ? null : c.ref);

/**
 * What a citation's writer said of it: its confidence as "0.75", else (no score) its note,
 * e.g. "owner decision, locked"; null when it says neither.
 */
export const citationConfidence = (c: Pick<CitationOut, "confidence" | "confidence_note">): string | null =>
  c.confidence != null ? c.confidence.toFixed(2) : c.confidence_note?.trim() || null;

/** The source with the citation's confidence beside it: "GitHub · 0.75". */
export const citationSourceLabel = (c: Pick<CitationOut, "source" | "confidence" | "confidence_note">): string => {
  const confidence = citationConfidence(c);
  return confidence ? `${SOURCE_LABEL[c.source]} · ${confidence}` : SOURCE_LABEL[c.source];
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

export const STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: "Open",
  addressed: "Addressed",
  declined: "Declined",
  superseded: "Superseded",
};

export const DOC_STATUS_LABEL = { draft: "Draft", in_review: "In review", approved: "Approved" } as const;

/** A job's name in Oracle's work (History), in plain words. */
export const JOB_KIND_LABEL: Record<LlmJobKind, string> = {
  review_comments: "Suggestions",
  reporting: "Reports",
  refinement: "Section rewrite",
  intake_analysis: "Intake analysis",
  quality_review: "Quality review",
  refinement_batch: "Next draft",
  decision_options: "Decision options",
  scope_enhance: "Requirement deepened",
  why_not_reply: "Why-not replies",
};

/** Each per-document switch in plain words (History > Oracle's work); the keys stay the API's JobSettings. */
export const JOB_SETTING_LABEL: Record<keyof JobSettings, string> = {
  review_comments: "Suggest changes from feedback",
  reporting: "Write reports",
  refinement: "Rewrite sections and build drafts",
  quality_review: "Quality review",
};

/** Why a job is refused while its switch is off; the API's words (oracle.jobs.service.turned_off). */
export function turnedOff(setting: keyof JobSettings): string {
  return `"${JOB_SETTING_LABEL[setting]}" is turned off for this document`;
}

export const JOB_STATUS_LABEL: Record<LlmJob["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const CLASSIFICATION_LABEL: Record<Suggestion["classification"], string> = {
  question: "Question",
  change_request: "Change request",
  factual_correction: "Factual correction",
  approval: "Approval",
  other: "Other",
};

/** Why no Claude account could take a job (the pool's reasons). */
export const NO_ACCOUNT_REASON: Record<string, string> = {
  no_accounts_registered: "No Claude account is set up. An owner adds one on Settings > Claude accounts.",
  pool_paused: "Every Claude account is paused. An owner resumes one on Settings > Claude accounts.",
  // Past tense: a failed job's refusal is about when it ran, not now (#556).
  no_account_available: "Every Claude account was out of quota when this ran.",
  no_recent_reading: "No Claude account has a recent usage reading; the next usage check will tell.",
  unusable: "No Claude account's credential could be read. An owner signs in again.",
};

/** A failed job's stored error and its pool reason as sentences apart (#556). */
export function jobFailure(job: Pick<LlmJob, "error" | "error_reason">, fallback = "The job failed."): string {
  const error = (job.error ?? fallback).trim();
  const reason = job.error_reason ? NO_ACCOUNT_REASON[job.error_reason] : undefined;
  if (!reason) return error;
  return `${/[.!?]$/.test(error) ? error : `${error}.`} ${reason}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

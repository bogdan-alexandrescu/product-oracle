import type { CitationOut, FeedbackStatus, LlmJob, LlmJobKind, Suggestion, Verdict } from "@/lib/api/client";

const dateFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

export const SOURCE_LABEL: Record<CitationOut["source"], string> = {
  slack: "Slack",
  notion: "Notion",
  gdocs: "Google Docs",
  github: "GitHub",
  fireflies: "Meeting notes",
  upload: "Upload",
  web: "Web",
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

export const JOB_KIND_LABEL: Record<LlmJobKind, string> = {
  review_comments: "Review comments",
  reporting: "Reporting",
  refinement: "Refinement",
  intake_analysis: "Intake analysis",
};

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
  no_account_available: "Every Claude account is out of quota until its window resets.",
  no_recent_reading: "No Claude account has a recent usage reading; the next usage check will tell.",
  unusable: "No Claude account's credential could be read. An owner signs in again.",
};

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

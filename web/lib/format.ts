import type { CitationOut, FeedbackStatus, Verdict } from "@/lib/api/client";

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

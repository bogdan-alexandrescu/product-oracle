import { calendarDay, dayIn, displayZone, formatInZone, shownDay, zoneDateTime } from "@/lib/dates";
import type { CitationOut, FeedbackStatus, JobSettings, LlmJob, LlmJobKind, Suggestion, Verdict } from "@/lib/api/client";

// #447: display dates in the Company time zone (lib/dates.ts), not the browser's.

/** "Oct 16, 2026". */
export const formatDate = (iso: string) => shownDay(iso, { month: "short", day: "numeric", year: "numeric" });
/** "Oct 16". */
export const formatDay = (iso: string) => shownDay(iso, { month: "short", day: "numeric" });
/** "Oct 19, 8:00 AM PDT". */
export const formatDateTime = (iso: string) => zoneDateTime(iso, displayZone());

export { inWords } from "@/lib/dates";

/*
 * One way to write each value (#QA): dates, times, ranges and ages in the Company time zone,
 * money, counts, plurals and percentages. `zone` and `now` default to the Company zone and
 * the clock; tests pass them.
 */

/** A calendar day with no zone, kept as written. */
const NAIVE_DAY = /^\d{4}-\d{2}-\d{2}(T[\d:.]+)?$/;

/** The calendar day (YYYY-MM-DD) `value` falls on in `zone`; a calendar day as written. */
function dayOf(value: string | number | Date, zone: string): string | null {
  if (typeof value === "string" && NAIVE_DAY.test(value)) return value.slice(0, 10);
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : dayIn(at, zone);
}

/** "Oct 28", or "Oct 28, 2026" when the year is not the current one. */
export function formatShortDate(value: string, now: number | Date = Date.now(), zone = displayZone()): string {
  const day = dayOf(value, zone);
  if (!day) return value;
  const sameYear = day.slice(0, 4) === dayOf(now, zone)?.slice(0, 4);
  return calendarDay(day, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Mon, Nov 2". */
export function formatWeekday(value: string, zone = displayZone()): string {
  const day = dayOf(value, zone);
  return day ? calendarDay(day, { weekday: "short", month: "short", day: "numeric" }) : value;
}

/** "9:00 AM PDT". */
export const formatTime = (iso: string, zone = displayZone()) => formatInZone(iso, zone, { hour: "numeric", minute: "2-digit" });

/** "Sep 8 – Oct 20, 2026"; "Dec 8, 2026 – Jan 20, 2027" across years; one day alone when they are the same. */
export function formatDateRange(start: string, end: string, zone = displayZone()): string {
  const from = dayOf(start, zone);
  const to = dayOf(end, zone);
  if (!from || !to) return `${start} – ${end}`;
  const full = { month: "short", day: "numeric", year: "numeric" } as const;
  if (from === to) return calendarDay(to, full);
  const head = from.slice(0, 4) === to.slice(0, 4) ? calendarDay(from, { month: "short", day: "numeric" }) : calendarDay(from, full);
  return `${head} – ${calendarDay(to, full)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `value` was: "now" (under a minute), "5m", "3h", "2d", "3w", "4mo", "2y". */
export function formatAge(value: string | number | Date, now: number | Date = Date.now()): string {
  const ms = new Date(now).getTime() - new Date(value).getTime();
  if (Number.isNaN(ms)) return "";
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 60 * DAY) return `${Math.floor(ms / (7 * DAY))}w`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$6.82", "$1,250.00". */
export const formatMoney = (value: number) => MONEY.format(value);

/** "$6.82 of $4.00": spent against a budget. */
export const formatMoneyOf = (spent: number, budget: number) => `${formatMoney(spent)} of ${formatMoney(budget)}`;

/** "12,345". */
export const formatCount = (n: number) => n.toLocaleString("en-US");

/** "1 item", "2 items", "1,234 runs"; an irregular plural as the third argument: plural(2, "person", "people"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** A fraction (0 to 1) as a whole percent: formatPercent(0.375) is "38%". */
export const formatPercent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** A time zone in words: "Pacific Time (Los Angeles)"; the zone's city alone when it has no name. */
export function zoneName(zone: string): string {
  const city = (zone.split("/").pop() ?? zone).replace(/_/g, " ");
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return city;
  }
  if (!name || /^GMT[+-]/.test(name)) return city;
  return name.includes(city) ? name : `${name} (${city})`;
}

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

/** An absolute http(s) URL with a host: the only ref a citation opens as a link. */
const HTTP_URL = /^https?:\/\/[^\s/\\?#]+/i;

/** Whether a ref (a citation's, a piece of evidence's) may go in an href. */
export const isHttpUrl = (ref: string): boolean => HTTP_URL.test(ref);

/**
 * Where a citation opens, or null when its ref is not a link: an "oracle" citation names a
 * baseline item in free text ("baseline decision <key> ..."), shown as text, and any ref
 * that is not an http(s) URL (javascript:, data:, ...) is never put in an href.
 */
export const citationHref = (c: Pick<CitationOut, "source" | "ref">): string | null =>
  c.source !== "oracle" && HTTP_URL.test(c.ref) ? c.ref : null;

/** Whether `url` is an http(s) address (as a browser reads it: spaces and controls dropped). */
export const isWebLink = (url: string | null | undefined): url is string => !!url && /^https?:/i.test(url.replace(/[\u0000-\u0020]/g, ""));

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
  public_text: "Public texts",
  one_pager: "One-pager",
  item_draft: "Draft item",
  goal_suggestions: "Goal suggestions",
  simple_visual: "Proposal visual",
  meeting_minutes: "Meeting minutes",
  chat_reader: "Chat request read",
};

/** Each per-document switch in plain words (History > Oracle's work); the keys stay the API's JobSettings. */
export const JOB_SETTING_LABEL: Record<keyof JobSettings, string> = {
  review_comments: "Suggest changes from feedback",
  reporting: "Write reports",
  refinement: "Rewrite sections and build drafts",
  quality_review: "Quality review",
  public_text: "Draft public texts",
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

/** When something failed, so its stored error reads as then, not now (#561 review). */
export const failedAt = (at: string) => `Failed ${formatDateTime(at)}`;

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

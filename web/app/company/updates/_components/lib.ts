import type { Schemas } from "@/lib/api/client";
import { addDays, DEFAULT_ZONE, todayIn } from "@/lib/dates";

export type Update = Schemas["DocumentSummary"];
export type Period = Schemas["UpdatePeriod"];
export type UpdateTemplate = "investor-update" | "board-product";

/** The two built-in update templates (H8), as the New update sheet offers them. */
export const TEMPLATES: { key: UpdateTemplate; name: string; short: string; titlePrefix: string; depth: "quick" | "standard"; hint: string }[] = [
  {
    key: "investor-update",
    name: "Investor update",
    short: "Investor",
    titlePrefix: "Investor update",
    depth: "quick",
    hint: "Monthly: metrics first, asks near the top, then a short recap.",
  },
  {
    key: "board-product",
    name: "Board product section",
    short: "Board",
    titlePrefix: "Board update",
    depth: "standard",
    hint: "One to two slides: goals, a dated timeline, highlights and lowlights.",
  },
];

export const templateOf = (key: string | null | undefined) => TEMPLATES.find((t) => t.key === key);

export const VISIBILITY_LABEL: Record<Update["visibility"], string> = {
  approvers: "Owners and approvers",
  company: "Company",
};

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-01" as "Oct 1". */
function shortDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${SHORT_MONTHS[m - 1]} ${d}`;
}

/** "Oct 1 - Oct 31"; the years show when the period crosses one. */
export function formatPeriod(p: Period | null | undefined): string {
  if (!p) return "—";
  const cross = p.from.slice(0, 4) !== p.to.slice(0, 4);
  return cross ? `${shortDay(p.from)}, ${p.from.slice(0, 4)} - ${shortDay(p.to)}, ${p.to.slice(0, 4)}` : `${shortDay(p.from)} - ${shortDay(p.to)}`;
}

/** Today in the Company time zone (#401), as YYYY-MM-DD. */
export function todayIso(zone: string = DEFAULT_ZONE, now: number = Date.now()): string {
  return todayIn(zone, now);
}

/** The day after `iso` (YYYY-MM-DD). */
export const dayAfter = (iso: string): string => addDays(iso, 1);

/**
 * The period a new update of `template` covers by default: from the day after the last
 * approved update of that template (else the first of this month) through today.
 */
export function defaultPeriod(updates: Update[], template: UpdateTemplate, today: string = todayIso()): Period {
  const last = updates
    .filter((u) => u.template === template && u.approved_version != null && u.period)
    .map((u) => u.period!.to)
    .sort()
    .pop();
  const from = last ? dayAfter(last) : `${today.slice(0, 8)}01`;
  return { from: from <= today ? from : today, to: today };
}

/** "Investor update · October 2026", for the month the period ends in. */
export function defaultTitle(template: UpdateTemplate, period: Period): string {
  const t = templateOf(template)!;
  const [y, m] = (period.to || todayIso()).split("-").map(Number);
  return `${t.titlePrefix} · ${MONTHS[m - 1]} ${y}`;
}

/** Newest period first; an update without a period by its last change. */
export function byNewestPeriod(a: Update, b: Update): number {
  const pa = a.period?.to ?? a.updated_at.slice(0, 10);
  const pb = b.period?.to ?? b.updated_at.slice(0, 10);
  return pb.localeCompare(pa) || (b.period?.from ?? "").localeCompare(a.period?.from ?? "") || b.updated_at.localeCompare(a.updated_at);
}

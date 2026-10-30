import type { Schemas } from "@/lib/api/client";
import { addDays, DEFAULT_ZONE, todayIn } from "@/lib/dates";
import { formatDateRange } from "@/lib/format";

export type Update = Schemas["DocumentSummary"];
export type Period = Schemas["UpdatePeriod"];
export type UpdateTemplate = "investor-update" | "board-product";

/**
 * The two built-in update templates (H8), as the New update sheet offers them; qa-company-38:
 * one name everywhere (the list, the dialog, a new update's title and the API's template).
 */
export const TEMPLATES: { key: UpdateTemplate; name: string; titlePrefix: string; depth: "quick" | "standard"; hint: string }[] = [
  {
    key: "investor-update",
    name: "Investor update",
    titlePrefix: "Investor update",
    depth: "quick",
    hint: "Monthly: metrics first, asks near the top, then a short recap.",
  },
  {
    key: "board-product",
    name: "Board update",
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Sep 8 – Oct 20, 2026" (qa-company-50: the shared range, en dash, with the year). */
export function formatPeriod(p: Period | null | undefined): string {
  if (!p) return "—";
  return formatDateRange(p.from, p.to);
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

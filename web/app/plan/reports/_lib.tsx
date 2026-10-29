import { Chip, type ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { zoneDateTime, zoneDay, zoneTime } from "@/lib/dates";
import { formatDateTime } from "@/lib/format";

export type Report = Schemas["AlignmentReportOut"];
export type ReportItem = Schemas["AlignmentReportListItem"];
export type ReportTrack = Schemas["ReportTrack"];

export const HEALTH_LABEL: Record<string, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  no_roadmap: "No roadmap",
  paused: "Paused",
  closed: "Closed",
};

const HEALTH_KIND: Record<string, ChipKind> = { on_track: "pass", at_risk: "warn", off_track: "crit", paused: "na", no_roadmap: "na" };

/** "At risk, was On track", or just "On track" when the week did not change it. */
export function healthText(t: Pick<ReportTrack, "health" | "health_before">): string {
  const now = HEALTH_LABEL[t.health] ?? t.health;
  return t.health_before && t.health_before !== t.health ? `${now}, was ${HEALTH_LABEL[t.health_before] ?? t.health_before}` : now;
}

export function HealthChip({ track }: { track: Pick<ReportTrack, "health" | "health_before"> }) {
  return (
    <Chip kind={HEALTH_KIND[track.health] ?? "na"} dot data-testid="track-health">
      {healthText(track)}
    </Chip>
  );
}

/** A roadmap horizon as people write it: "Now", not "now" (qa-plan-57). */
export const HORIZON_LABEL: Record<string, string> = { now: "Now", next: "Next", later: "Later" };

/** "Oct 29, 4:09 AM": an instant in `zone`, without the zone's name (said once beside it, qa-plan-44). */
export const zoneMoment = (iso: string, zone: string) => zoneDateTime(iso, zone).replace(/\s+\S+$/, "");

const midnight = (iso: string, zone: string) => zoneTime(iso, zone).startsWith("00:00");

/**
 * The bounds of the week a report covers (qa-plan-44), in the zone the report was made in:
 * a bound at midnight there is a day ("Oct 26"); the end of a week so far is its moment
 * ("Oct 29, 4:09 AM"). A weekly report ends at the next Monday's midnight, so it reads as
 * the Sunday before ("Oct 12 – Oct 18").
 */
export const periodStart = (r: Pick<Report, "period" | "timezone">) =>
  midnight(r.period.from, r.timezone) ? zoneDay(r.period.from, r.timezone) : zoneMoment(r.period.from, r.timezone);

export function periodEnd(r: Pick<Report, "period" | "timezone">): string {
  const to = r.period.to;
  if (!midnight(to, r.timezone)) return zoneMoment(to, r.timezone);
  return zoneDay(new Date(new Date(to).getTime() - 1).toISOString(), r.timezone);
}

/** The report's Slack line: posted, waiting, refused, or not posted. */
export function slackText(r: Pick<Report, "slack" | "timezone">): string {
  const s = r.slack;
  const channel = s.channel ? `#${s.channel.name}` : "Slack";
  if (s.status === "posted" && s.posted_at) return `Posted to ${channel} on ${formatDateTime(s.posted_at)}`;
  if (s.status === "pending") return `Not posted to ${channel} yet: ${s.error ?? "waiting"}. Oracle tries again${s.next_attempt_at ? ` at ${formatDateTime(s.next_attempt_at)}` : ""}.`;
  if (s.status === "failed") return `Not posted to ${channel}: ${s.error ?? "Slack refused it"}.`;
  if (s.status === "not_configured") return "Not posted: Slack is not connected for notifications, or no channel is picked.";
  return "Not posted to Slack.";
}

/** "1 at risk · 1 slip": the Inbox row's figures. */
export function figures(s: Schemas["ReportSummaryFigures"]): string {
  const risky = s.at_risk + s.off_track;
  return `${risky} at risk · ${s.slips} ${s.slips === 1 ? "slip" : "slips"}`;
}

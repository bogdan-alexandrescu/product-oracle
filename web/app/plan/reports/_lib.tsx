import { Chip, type ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { zoneDateTime } from "@/lib/dates";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 30" from "2026-11-30" (a calendar date, no time zone). */
export const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/**
 * A bound of the week a report covers, in the zone the report was made in: its bounds are
 * midnights there, so another zone would show them as odd hours.
 */
export const periodBound = (iso: string, r: Pick<Report, "timezone">) => zoneDateTime(iso, r.timezone);

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

/** "1 at risk · 2 slips": the Inbox row's figures. */
export function figures(s: Schemas["ReportSummaryFigures"]): string {
  const risky = s.at_risk + s.off_track;
  return `${risky} at risk · ${s.slips} ${s.slips === 1 ? "slip" : "slips"}`;
}

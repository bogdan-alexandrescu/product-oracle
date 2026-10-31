import type { Schemas } from "@/lib/api/client";

type Source = Schemas["SourceOut"];

/**
 * qa4-settings-6: an active source that lost access to something it picked (a doc, a folder,
 * a channel) or whose connection must be reconnected to read its files needs a person: it
 * reads Needs attention, not Active. Settings › Sources and the Inbox both count it.
 */
export function needsPerson(s: Source): boolean {
  if (s.status !== "active") return false;
  return !!s.reconnect_reason || lostItems(s) > 0;
}

/** How many picked items the source lost access to (a missing status is unavailable). */
export function lostItems(s: Source): number {
  return (s.unavailable_items ?? []).filter((u) => (u.status ?? "unavailable") === "unavailable").length;
}

/** The status a source shows: the API's, or Needs attention for an active one that needs a person. */
export const shownStatus = (s: Source): Source["status"] => (needsPerson(s) ? "needs_attention" : s.status);

/** Sources that need attention, as Settings › Sources' header and the Inbox count them. */
export const needingAttention = (sources: Source[]): Source[] => sources.filter((s) => shownStatus(s) === "needs_attention");

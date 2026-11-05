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

/** The two ways the API's needs_attention message ends: the fix itself, or the edit to make. */
const THEN_SYNCS = ", then it syncs again";
const EDIT_TO_SYNC = ": edit this source to sync it again";
const WHO_FIXES = "an owner or the source's owner";

/**
 * Why a source needs attention, for who reads it (as the Inbox's sourceNeedReason): someone
 * who may edit it reads the API's message as it is, what to do; someone who may not reads who
 * can do it ("An owner or the source's owner can pick 100 channels or fewer, then it syncs again").
 * ``mayEdit`` comes from can() only.
 */
export function attentionMessage(message: string, mayEdit: boolean): string {
  if (mayEdit) return message;
  if (message.endsWith(EDIT_TO_SYNC)) {
    return `${message.slice(0, -EDIT_TO_SYNC.length)}: ${WHO_FIXES} can edit this source to sync it again`;
  }
  if (message.endsWith(THEN_SYNCS)) {
    const fix = message.slice(0, -THEN_SYNCS.length);
    return `${WHO_FIXES[0].toUpperCase()}${WHO_FIXES.slice(1)} can ${fix[0].toLowerCase()}${fix.slice(1)}${THEN_SYNCS}`;
  }
  return message;
}

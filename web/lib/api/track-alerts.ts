/**
 * F2 Track health: the track alert routes (api/oracle/roadmap/router.py), the Inbox's
 * track group, and the words the Inbox rows and Plan cards share.
 */
import { formatDayUtc } from "@/lib/format";

import { api, unwrap } from "./client";
import type { components } from "./schema";

type S = components["schemas"];
export type TrackAlertOut = S["TrackAlertOut"];
export type TrackAlertKind = TrackAlertOut["kind"];
export type TrackAlertAction = TrackAlertOut["actions"][number];
export type TrackAlertState = TrackAlertOut["state"];
export type AcceptDateOut = S["AcceptDateOut"];
export type InboxTrack = S["InboxTrack"];
export type TrackerRecordEventOut = S["TrackerRecordEventOut"];

const enc = encodeURIComponent;

export const listTrackAlerts = (query: { state?: "open" | "kept" | "resolved" | "all"; track_id?: string }) =>
  unwrap(api.GET("/v1/track-alerts", { params: { query } }));

export const keepTrackAlert = (id: string, note: string | null) =>
  unwrap(api.POST("/v1/track-alerts/{alert_id}/keep", { params: { path: { alert_id: id } }, body: { note } }));

export const reopenTrackAlert = (id: string) => unwrap(api.POST("/v1/track-alerts/{alert_id}/reopen", { params: { path: { alert_id: id } } }));

export const acceptTrackAlertDate = (id: string, reason: string | null = null) =>
  unwrap(api.POST("/v1/track-alerts/{alert_id}/accept-date", { params: { path: { alert_id: id } }, body: { reason } }));

export const trackerRecordEvents = (recordId: string) =>
  unwrap(api.GET("/v1/tracker/records/{record_id}/events", { params: { path: { record_id: recordId } } }));

/** The Inbox's track group (F2). */
export const inboxTracks = (inbox: { tracks?: InboxTrack[] }): InboxTrack[] => inbox.tracks ?? [];

export const HEALTH_WORD: Record<string, string> = { at_risk: "At risk", off_track: "Off track", on_track: "On track" };

/** "Dec 9": a tracker or milestone date (a day, no time), as the Plan writes them. */
export const alertDay = (day: unknown): string | null => {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(day)) return null;
  return formatDayUtc(`${day.slice(0, 10)}T12:00:00Z`);
};

/** The alert in one sentence: a slip in the Plan's date words, the rest as the API words them. */
export function alertSentence(a: TrackAlertOut): string {
  if (a.kind === "date_slip") {
    const to = alertDay(a.data.tracker_date);
    const from = alertDay(a.data.milestone_date);
    const ref = typeof a.data.tracker_ref === "string" ? a.data.tracker_ref : null;
    const name = typeof a.data.milestone_name === "string" && a.data.milestone_name ? a.data.milestone_name : "The milestone";
    if (ref && to && from) return `${ref} moved to ${to}; ${name} rests on ${from}`;
  }
  return a.detail;
}

/** The first safe action an Inbox child row offers. */
export function firstSafeAction(a: TrackAlertOut): "accept_date" | "review" | "keep" | null {
  if (a.actions.includes("accept_date")) return "accept_date";
  if (a.actions.includes("review")) return "review";
  if (a.actions.includes("keep")) return "keep";
  return null;
}

/** The Plan, with the alert's item selected. */
export const planHref = (a: Pick<TrackAlertOut, "item_key">) => (a.item_key ? `/plan?item=${enc(a.item_key)}` : "/plan");

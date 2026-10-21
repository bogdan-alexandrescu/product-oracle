/**
 * Mock of the Fireflies browse endpoints (GET /v1/connections/{id}/fireflies/meetings
 * and /series): a fixed set of meetings, two calendar series among them, paged newest
 * first like the API. Meetings on no calendar are in no series (series_key null), like
 * the ad hoc planning session that shares the planning series' title and organizer.
 * Searching "rate limit" answers 429, as the API does past its browsing budget.
 */
import type { Schemas } from "@/lib/api/client";

type Meeting = Schemas["FirefliesMeetingOut"];

export const FIREFLIES_CONNECTION_ID = "c0000000-0000-4000-8000-000000000003";
const PAGE = 12;

const STANDUP = "cal:7kq2abc0def1ghi2jkl3mno4pq";
const PLANNING = "cal:plan5q9r8s7t6u";

function at(day: string, time: string): string {
  return `${day}T${time}:00Z`;
}

function build(): Meeting[] {
  const rows: Meeting[] = [];
  // Daily standups on weekdays, 1 Sep to 16 Oct 2026.
  for (let d = new Date("2026-09-01T00:00:00Z"); d <= new Date("2026-10-16T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const day = d.toISOString().slice(0, 10);
    rows.push({
      id: `ST-${day}`,
      title: "AI Agents daily standup",
      date: at(day, "09:00"),
      duration: 15,
      organizer: "ada@example.com",
      attendee_count: 6,
      series_key: STANDUP,
      series_title: "AI Agents daily standup",
    });
  }
  // Sprint planning every other Tuesday, numbered in the title.
  ["2026-09-01", "2026-09-15", "2026-09-29", "2026-10-13"].forEach((day, i) => {
    rows.push({
      id: `SP-${day}`,
      title: `AI agents sprint planning #${11 + i}`,
      date: at(day, "14:00"),
      duration: 55,
      organizer: "lin@example.com",
      attendee_count: 7,
      series_key: PLANNING,
      series_title: "AI agents sprint planning",
    });
  });
  const oneOff = (id: string, title: string, day: string, time: string, duration: number, organizer: string, attendees: number) =>
    rows.push({
      id,
      title,
      date: at(day, time),
      duration,
      organizer,
      attendee_count: attendees,
      series_key: null,
      series_title: title,
    });
  oneOff("K-acme", "Customer interview: Acme", "2026-10-14", "16:00", 42, "ada@example.com", 3);
  oneOff("K-globex", "Customer interview: Globex", "2026-10-08", "15:30", 38, "ada@example.com", 4);
  oneOff("PR-onb", "Product review: onboarding v2", "2026-10-09", "13:00", 60, "lin@example.com", 9);
  oneOff("PR-price", "Pricing workshop", "2026-09-22", "10:00", 90, "sam@example.com", 5);
  oneOff("OLD-kick", "Q3 kickoff", "2026-07-06", "10:00", 75, "ada@example.com", 14);
  oneOff("SP-adhoc", "AI agents sprint planning", "2026-10-06", "17:00", 25, "lin@example.com", 3);
  return rows.sort((a, b) => (a.date! < b.date! ? 1 : -1));
}

const MEETINGS = build();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function inRange(m: Meeting, q: URLSearchParams): boolean {
  const day = m.date!.slice(0, 10);
  const from = q.get("from");
  const to = q.get("to");
  return (!from || day >= from) && (!to || day <= to);
}

/** Every browse call the mock answered ("series?from=..."), for tests counting requests. */
declare global {
  interface Window {
    __firefliesBrowseCalls?: string[];
  }
}

/** Handles /v1/connections/{id}/fireflies/{meetings|series}; null for other paths. */
export function routeFirefliesBrowse(p: string[], q: URLSearchParams): Response | null {
  if (p[1] !== "connections" || p[3] !== "fireflies") return null;
  if (typeof window !== "undefined") (window.__firefliesBrowseCalls ??= []).push(`${p[4]}?${q.toString()}`);
  if (p[2] !== FIREFLIES_CONNECTION_ID) return json(404, { detail: "Fireflies connection not found" });
  const search = (q.get("search") ?? "").trim().toLowerCase();
  if (search === "rate limit") {
    return json(
      429,
      { detail: "Fireflies limit reached, try later. Browsing may make 25 Fireflies calls a day for this connection, so syncs keep the rest of your Fireflies quota. Try again in 5 hours." },
      { "Retry-After": "18000" },
    );
  }
  const rows = MEETINGS.filter((m) => inRange(m, q));
  if (p[4] === "meetings") {
    const found = search ? rows.filter((m) => m.title.toLowerCase().includes(search)) : rows;
    const skip = Number(q.get("cursor") ?? 0);
    const page = found.slice(skip, skip + PAGE);
    return json(200, { meetings: page, next_cursor: skip + PAGE < found.length ? String(skip + PAGE) : null });
  }
  if (p[4] === "series") {
    const groups = new Map<string, Schemas["FirefliesSeriesOut"]>();
    for (const m of rows) {
      if (m.series_key == null) continue;
      const g = groups.get(m.series_key);
      if (g) g.meeting_count += 1;
      else groups.set(m.series_key, { key: m.series_key, title: m.series_title, meeting_count: 1, last_date: m.date, organizer: m.organizer });
    }
    return json(200, { series: [...groups.values()], truncated: false });
  }
  return json(404, { detail: "Route not found" });
}

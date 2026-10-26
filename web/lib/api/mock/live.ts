/**
 * Mock of the live tools (#710, GET /v1/live/*, api/oracle/live/router.py) and of the
 * Ask reply that reads them. The mock's connections are one store for everyone signed in,
 * so every member reads the active Fireflies connections as their own. A connection
 * answers a total of LIVE_TOTAL meetings and the invented ones below; every answer
 * carries its `cite`, numbered l:1 per request (as a REST call outside Ask).
 *
 * The scripted reply (liveReply): in a private chat that only its asker is in, "how many
 * ... meetings" answers the total and "meeting <id>" pulls that meeting, each citing the
 * read as [l:1]; the reply's live reads are stored on it, so adding a person to the chat
 * answers the API's 409 live_reads_in_chat. With others in it, or no connection, it says
 * what the API's prompt tells Oracle to say.
 */
import type { Schemas } from "@/lib/api/client";

import { liveConnections } from "./connections";

type Meeting = Schemas["LiveMeeting"];
type Cite = Schemas["Cite"];

/** The count every mock Fireflies connection answers (AC 1: "4,321"). */
export const LIVE_TOTAL = 4321;
export const LIVE_TOOLS = ["live_fireflies_list_meetings", "live_fireflies_search", "live_fireflies_get_meeting", "live_fireflies_get_lines"];
/** As oracle.live.tokens.IN_CHAT_CODE and IN_CHAT. */
export const IN_CHAT_CODE = "live_reads_in_chat";
export const IN_CHAT = "This chat holds what Oracle read from your sources. Use Share as discussion to share an edited summary instead.";
/** As the panel's line and oracle.discussions.replies.OFF_HERE. */
export const OFF_HERE = "Live reads are off: others can read this discussion.";

// Invented meetings, newest first.
const MEETINGS: (Meeting & { summary: string; lines: Schemas["LiveLine"][] })[] = [
  {
    id: "FF-2041",
    title: "Pricing review with the design team",
    date: "2026-10-21T16:00:00Z",
    duration_s: 2700,
    participants: ["Ada Example", "Lin Example"],
    summary: "Agreed to show plan limits on the checkout page before the trial ends.",
    lines: [
      { speaker: "Ada Example", start_ms: 0, text: "Let's start with the plan limits." },
      { speaker: "Lin Example", start_ms: 4200, text: "The checkout page should show them before the trial ends." },
    ],
  },
  {
    id: "FF-2040",
    title: "Weekly product sync",
    date: "2026-10-20T17:00:00Z",
    duration_s: 1800,
    participants: ["Ada Example", "Sam Example"],
    summary: "Reviewed the onboarding funnel and the next experiment.",
    lines: [{ speaker: "Sam Example", start_ms: 0, text: "Onboarding completion moved up two points." }],
  },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const label = (c: { account_label?: string | null }) => c.account_label || "Fireflies";

function cite(c: { id: string; account_label?: string | null }, call: string, n: number, item?: string): Cite {
  return { ref: `l:${n}`, source: label(c), call, read_at: new Date().toISOString(), connection_id: c.id, item_id: item ?? null };
}

const meetingOf = (m: (typeof MEETINGS)[number]): Meeting => ({ id: m.id, title: m.title, date: m.date, duration_s: m.duration_s, participants: m.participants });

const NO_CONNECTION = "You have no Fireflies connection. Connect one in Settings > Connections.";

/** GET /v1/live/*, as api/oracle/live/router.py answers it; null when the path is not one. */
export function routeLive(req: Request, p: string[], q: URLSearchParams): Response | null {
  if (p[1] !== "live" || req.method !== "GET") return null;
  const sources = liveConnections();
  if (p[2] === "sources" && p.length === 3)
    return json(
      200,
      sources.map((c) => ({ connection_id: c.id, provider: "fireflies", label: label(c), tools: LIVE_TOOLS }) satisfies Schemas["LiveSourceOut"]),
    );
  if (p[2] !== "fireflies") return null;
  const c = sources.find((x) => x.id === p[3]);
  if (!c) return json(404, { detail: NO_CONNECTION });
  const num = (k: string, d: number) => (q.get(k) === null ? d : Number(q.get(k)));
  if (p[4] === "meetings" && p.length === 5) {
    const limit = num("limit", 20);
    const offset = num("offset", 0);
    return json(200, { total: LIVE_TOTAL, meetings: MEETINGS.slice(offset, offset + limit).map(meetingOf), skipped: 0, limit_capped: false, note: null, cite: cite(c, "list_meetings", 1) });
  }
  if (p[4] === "search" && p.length === 5) {
    const words = (q.get("q") ?? "").toLowerCase();
    if (!words) return json(422, { detail: "q is required" });
    const found = MEETINGS.filter((m) => `${m.title} ${m.summary}`.toLowerCase().includes(words));
    return json(200, {
      total: found.length,
      matches: found.map((m) => ({ id: m.id, title: m.title, date: m.date, snippet: m.summary })),
      skipped: 0,
      limit_capped: false,
      cite: cite(c, "search", 1),
    });
  }
  if (p[4] === "meetings" && p[5]) {
    const m = MEETINGS.find((x) => x.id === decodeURIComponent(p[5]));
    if (!m) return json(404, { detail: `No meeting ${decodeURIComponent(p[5])} in ${label(c)}.` });
    if (p.length === 6) {
      const all = q.get("part") === "all";
      return json(200, { ...meetingOf(m), summary: m.summary, lines: all ? m.lines : null, truncated: false, skipped: 0, cite: cite(c, "get_meeting", 1, m.id) });
    }
    if (p[6] === "lines" && p.length === 7) {
      const offset = num("offset", 0);
      const limit = num("limit", 200);
      const lines = m.lines.slice(offset, offset + limit);
      const next = offset + lines.length < m.lines.length ? offset + lines.length : null;
      return json(200, { lines, next_offset: next, skipped: 0, cite: cite(c, "get_lines", 1, m.id) });
    }
  }
  return null;
}

export type LiveReply = { pieces: string[]; citations: Record<string, unknown>[]; reads: number };

/** A reply's live citation, as oracle.discussions.replies.live_citations gives it. */
function liveCitation(c: Cite): Record<string, unknown> {
  return { kind: "live", ref: c.ref, source: c.source, call: c.call, read_at: c.read_at, item_id: c.item_id ?? null };
}

/**
 * Oracle's scripted answer to `question` when it asks about Fireflies meetings; null for
 * any other question (the canned reply). `alone`: only the asker is in the private chat.
 */
export function liveReply(question: string, alone: boolean): LiveReply | null {
  const text = question.toLowerCase();
  const pull = /\bmeeting\s+([A-Za-z0-9-]{2,64})\b/.exec(question);
  const counting = /how many/.test(text) && /meeting/.test(text);
  if (!counting && !(pull && /\b(pull|get|show|open)\b/.test(text))) return null;
  const sources = liveConnections();
  if (!sources.length) return { pieces: [NO_CONNECTION], citations: [], reads: 0 };
  if (!alone) return { pieces: [`${OFF_HERE} Ask me in a private chat to read your Fireflies meetings.`], citations: [], reads: 0 };
  const c = sources[0];
  if (counting) {
    const read = liveCitation(cite(c, "list_meetings", 1));
    return { pieces: ["You can read ", `${LIVE_TOTAL.toLocaleString("en-US")} meetings `, `in ${label(c)} [l:1].`], citations: [read], reads: 1 };
  }
  const m = MEETINGS.find((x) => x.id.toLowerCase() === pull![1].toLowerCase());
  if (!m) return { pieces: [`No meeting ${pull![1]} in ${label(c)}.`], citations: [], reads: 0 };
  const read = liveCitation(cite(c, "get_meeting", 1, m.id));
  return {
    pieces: [`Meeting ${m.id} is “${m.title}”, `, `${Math.round((m.duration_s ?? 0) / 60)} minutes with ${m.participants.join(" and ")}. `, `${m.summary} [l:1]`],
    citations: [read],
    reads: 1,
  };
}

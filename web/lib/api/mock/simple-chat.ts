/**
 * Simple S9: change by chat (/v1/simple/chat, /v1/simple/meetings/{id}/chat) and "Walk me
 * through it" (/v1/simple/walk), as api/oracle/simple serves them, over the mock's change
 * engine (./simple-changes.ts) and company-wide roadmap (./simple-roadmap.ts).
 *
 * Oracle's parser is deterministic (the contract's list): answers to "who owns / who decides /
 * when is / status of X", and change cards for move, milestone, feature ask, task, action
 * item, launch task, rename and cut. A card's Apply goes through the change engine with the
 * caller's own rights (owners and deciders apply, others propose, viewers are refused); in a
 * meeting the meeting's rules come first (oracle.simple.meetings.meeting_rules: everyone,
 * the presenter only, or the presenter and up to two named people; viewers ask; an ended
 * meeting applies nothing), and an applied card becomes a meeting decision (decision_id).
 *
 * Invented data: one meeting, "Weekly plan review", presented by the company's first owner,
 * with every member of the default company attending (the viewer included) and one decision
 * on its agenda.
 */
import type { Schemas } from "@/lib/api/client";
import { plainFlow } from "./simple-visuals";
import { mockNowMs } from "./clock";
import { companyDayIso } from "./connections";
import { stableUuid } from "./ids";
import { routeSimpleChanges, type SimpleChangesCtx } from "./simple-changes";
import { itemDeciderId, itemOwnerId, roadmapOut, storedDates, type SimpleDb } from "./simple-roadmap";

type Values = Record<string, unknown>;
type Item = Schemas["SimpleRoadmapItem"];
type Role = Schemas["Me"]["role"];
type Preview =
  | { kind: "dates"; item_id: string; start_date: string; end_date: string }
  | { kind: "horizon"; item_id: string; horizon: string }
  | { kind: "title"; item_id: string; title: string }
  | { kind: "milestone"; item_id: string; name: string; date: string }
  | { kind: "cut"; item_id: string }
  | { kind: "owner" | "decider"; item_id: string; person_id: string; person_name: string; before_name: string | null }
  | { kind: "decision"; text: string; decider_name: string; where: "meeting" | "page" }
  | { kind: "note" | "question"; text: string }
  | { kind: "agenda"; item_id: string; move: "next" | "skip"; item_title: string }
  | null;
type Fix = { label: string; op: string; target: Values; before: Values; after: Values };
type Mode = "everyone" | "presenter" | "named";

interface StoredCard {
  id: string;
  message_id: string | null;
  thread: string;
  meeting_id: string | null;
  op: string;
  target: Values;
  before: Values;
  after: Values;
  summary: string;
  item_id: string | null;
  item_title: string | null;
  status: "open" | "applied" | "proposed" | "discarded" | "undone";
  preview: Preview;
  flow: Schemas["SimpleFlow"] | null;
  fixes: Fix[];
  /** Walk cards: the broken link's flag (their constraint check). */
  flag?: Schemas["SimpleItemFlags"] | null;
  change_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_id: string | null;
  /** Chat actions: what Undo restores (the agenda before, the decision made). */
  undo?: Values;
}

interface StoredMessage {
  id: string;
  author_kind: "person" | "oracle";
  author_id: string | null;
  author_name: string;
  body: string;
  at: string;
  kind: "request" | "cards" | "question" | "answer" | "note";
  card_ids: string[];
}

interface Thread {
  id: string;
  meeting_id: string | null;
  owner_id: string | null;
  messages: StoredMessage[];
}

interface Meeting {
  id: string;
  title: string;
  presenter_id: string;
  attendee_ids: string[];
  change_mode: Mode;
  change_people: string[];
  ended: boolean;
  agenda: { id: string; title: string; url: string }[];
  decisions: { id: string; title: string; card_id: string; at: string }[];
  /** Chat actions in the chat's own meeting: its notes and open questions, and the agenda's next and skipped items. */
  notes?: MeetingNote[];
  agenda_state?: MeetingAgenda;
  /** A review meeting of S8's (./simple-meetings.ts), mirrored here from `ChatMeetings.find` on each call. */
  s8?: boolean;
}

/** The meeting's live notes and open questions (SimpleMeetingOut.notes). */
export type MeetingNote = { kind: "note" | "question"; text: string; by_name: string; card_id: string };
/** The meeting's agenda changes (SimpleMeetingOut.agenda). */
export type MeetingAgenda = { next: { id: string; title: string } | null; skipped: { id: string; title: string }[] };

/**
 * S8's review meetings as the chat reads and writes them (server.ts builds it over
 * ./simple-meetings.ts): a meeting's rules, its notes, agenda and decisions, and the
 * decisions an Ask line records on a page's document (the Decisions page).
 */
export interface ChatMeetings {
  find(id: string): Pick<Meeting, "title" | "presenter_id" | "attendee_ids" | "change_mode" | "change_people" | "ended"> | null;
  setMode(id: string, mode: Mode, people: string[]): void;
  note(id: string, n: MeetingNote): void;
  unnote(id: string, cardId: string): void;
  agenda(id: string): MeetingAgenda;
  setAgenda(id: string, a: MeetingAgenda): void;
  /** A decision: the meeting's (meeting_decisions) or, with no meeting, on the page's document. Its id. */
  decide(meetingId: string | null, title: string, deciderId: string, documentId: string | null): string;
  undecide(decisionId: string): void;
  /** The document a page shows (Ask on /simple/prds/{slug}), or null. */
  documentOf(page: string): string | null;
}

export interface ChatDb {
  threads: Record<string, Thread>;
  cards: Record<string, StoredCard>;
  meetings: Record<string, Meeting>;
}

export type ChatCtx = SimpleChangesCtx & { roles: Record<string, Role> };

/** The invented meeting's id (stable: specs open /simple/meetings/{id}). */
export const CHAT_MEETING_ID = stableUuid("simple-meeting/weekly-plan-review");

/** The invented meeting: the first owner presents; every active member attends. */
export function seedSimpleChat(members: { id: string; role: Role; status?: string }[]): ChatDb {
  const active = members.filter((m) => m.status !== "disabled");
  const presenter = active.find((m) => m.role === "owner")?.id ?? active[0]?.id ?? "";
  return {
    threads: {},
    cards: {},
    meetings: {
      [CHAT_MEETING_ID]: {
        id: CHAT_MEETING_ID, title: "Weekly plan review", presenter_id: presenter, attendee_ids: active.map((m) => m.id),
        change_mode: "presenter", change_people: [], ended: false,
        agenda: [{ id: stableUuid("simple-decision/7"), title: "Send the digest weekly or daily?", url: "/simple/decisions" }],
        decisions: [],
      },
    },
  };
}

const DAY = 86_400_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (day: string) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => isoDay(msOf(day) + n * DAY);
const now = () => new Date(mockNowMs()).toISOString();
// The company's day (its time zone), as oracle.company_time.company_today.
const today = () => companyDayIso(new Date(mockNowMs()));
const dayWords = (day: string, year = false) =>
  new Date(msOf(day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** "March 3" / "Mar 3": the next such day on or after today. */
function parseDay(text: string): string | null {
  const m = /^([a-z]+)\s+(\d{1,2})$/i.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)) && m[1].length >= 3);
  if (month < 0) return null;
  const t = today();
  let y = Number(t.slice(0, 4));
  let d = isoDay(Date.UTC(y, month, Number(m[2])));
  if (d < t) d = isoDay(Date.UTC(++y, month, Number(m[2])));
  return d;
}

/** The n months from the first of `month` (0-based; it may run past December). */
const months = (year: number, month: number, n: number): [string, string] => [isoDay(Date.UTC(year, month, 1)), isoDay(Date.UTC(year, month + n, 0))];

/**
 * A period in words, from the company's today (as chat.parse_period): "this quarter", "next
 * quarter", "the quarter after [next]", "this month", "next month", "<month> [year]" (the next
 * on or after this month), "Qn [year]" and "Hn [year]" (the next on or after today's).
 */
function parsePeriod(text: string): [string, string] | null {
  const t = text.toLowerCase().trim().replace(/\s+/g, " ").replace(/^the /, "");
  const d = today();
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7)) - 1;
  const q = Math.floor(mo / 3);
  const steps: Record<string, number> = { "this quarter": 0, "current quarter": 0, "next quarter": 1, "quarter after": 2, "quarter after next": 2 };
  if (t in steps) return months(y, 3 * (q + steps[t]), 3);
  if (t === "this month") return months(y, mo, 1);
  if (t === "next month") return months(y, mo + 1, 1);
  let m: RegExpExecArray | null;
  if ((m = /^q([1-4])(?: (\d{4}))?$/.exec(t))) {
    const n = Number(m[1]);
    return months(m[2] ? Number(m[2]) : n - 1 >= q ? y : y + 1, 3 * (n - 1), 3);
  }
  if ((m = /^h([12])(?: (\d{4}))?$/.exec(t))) {
    const n = Number(m[1]);
    return months(m[2] ? Number(m[2]) : n - 1 >= Math.floor(mo / 6) ? y : y + 1, 6 * (n - 1), 6);
  }
  if ((m = /^([a-z]+)(?: (\d{4}))?$/.exec(t))) {
    const exact = MONTHS.indexOf(m[1]);
    const month = exact >= 0 ? exact : m[1].length >= 3 ? MONTHS.findIndex((x) => x.startsWith(m![1])) : -1;
    if (month < 0) return null;
    return months(m[2] ? Number(m[2]) : month >= mo ? y : y + 1, month, 1);
  }
  return null;
}

const unquote = (s: string) => s.trim().replace(/^["'“‘]|["'”’]$/g, "").replace(/[?.!]+$/, "").trim();

const or = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

const EXAMPLES = "Try “move Weekly alert digest to Q2”, “rename Setup checklist to First-run checklist”, “add a task 'Draft the email' to Weekly alert digest” or “who owns Mobile alert push?”.";

type Draft = Omit<StoredCard, "id" | "message_id" | "thread" | "meeting_id" | "status" | "change_id" | "decided_by_name" | "decided_at" | "decision_id">;
/** `understood: false`: a line the plan reader does not know (the Ask panel's one box sends it to Oracle's Ask); `missing`: no item has that name. */
type Reply = { kind: StoredMessage["kind"]; body: string; cards: Draft[]; understood?: boolean; missing?: boolean };

/** The item X names: one, or Oracle's question. */
function findItem(items: Item[], text: string): Item | Reply {
  const x = unquote(text).toLowerCase();
  const exact = items.filter((i) => i.title.toLowerCase() === x);
  if (exact.length === 1) return exact[0];
  const hits = items.filter((i) => i.title.toLowerCase().includes(x));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { kind: "question", body: `Which one: ${or(hits.slice(0, 5).map((i) => i.title))}?`, cards: [] };
  return { kind: "question", body: `I could not find “${unquote(text)}” on the roadmap. Which item do you mean?`, cards: [], missing: true };
}

const isItem = (x: Item | Reply): x is Item => "id" in x;

function dated(i: Item): boolean {
  return !i.estimated && i.start.source !== "estimated" && i.end.source !== "estimated";
}

/** Oracle's reply to one line (deterministic; the contract's list). */
function parse(db: SimpleDb, ctx: ChatCtx, text: string, meeting: Meeting | null, items: Item[], names: string[], documentId: string | null = null): Reply {
  const t = text.trim().replace(/\s+/g, " ");
  const viewerInMeeting = !!meeting && ctx.role === "viewer";
  let m: RegExpExecArray | null;

  // Questions: answers from Oracle's data, no cards; one about something not on the roadmap is Ask's.
  const asked = (x: string): Item | Reply => {
    const i = findItem(items, x);
    return !isItem(i) && i.missing ? { ...i, understood: false } : i;
  };
  if ((m = /^who (owns|decides) (.+)$/i.exec(t))) {
    const i = asked(m[2]);
    if (!isItem(i)) return i;
    if (m[1].toLowerCase() === "owns") return { kind: "answer", body: i.owner ? `${i.owner.name} owns ${i.title}.` : `${i.title} has no owner yet.`, cards: [] };
    return { kind: "answer", body: `${i.deciders.length ? or(i.deciders) : "The company's owners"} ${i.deciders.length > 1 ? "decide" : "decides"} ${i.title}.`, cards: [] };
  }
  if ((m = /^when is (.+)$/i.exec(t))) {
    const i = asked(m[1]);
    if (!isItem(i)) return i;
    return { kind: "answer", body: `${i.title}: ${dayWords(i.start.date)} – ${dayWords(i.end.date, true)}${i.estimated ? " (estimated)" : ""}.`, cards: [] };
  }
  if ((m = /^(?:what is the )?status of (.+)$/i.exec(t))) {
    const i = asked(m[1]);
    if (!isItem(i)) return i;
    return { kind: "answer", body: `${i.title} is ${i.status.replace("_", " ")} (${i.horizon}).`, cards: [] };
  }

  const change = (build: () => Reply): Reply =>
    viewerInMeeting
      ? { kind: "note", body: "Viewers ask questions here; ask the presenter to make a change.", cards: [] }
      : build();
  const card = (summary: string, op: string, item: Item | null, target: Values, before: Values, after: Values, preview: Preview = null, flow: Schemas["SimpleFlow"] | null = null): Reply => ({
    kind: "cards",
    body: "Here is the change. Preview it, then apply or discard it.",
    cards: [{ op, target, before, after, summary, item_id: item?.id ?? null, item_title: item?.title ?? null, preview, flow, fixes: [] }],
  });
  const stored = (i: Item) => {
    const s = storedDates(db, i.key);
    return { start_date: s.start, end_date: s.end };
  };
  const move = (i: Item, start: string, end: string) =>
    card(`Move ${i.title} to ${dayWords(start)} – ${dayWords(end, true)}`, "move_dates", i, { item_id: i.id }, stored(i), { start_date: start, end_date: end }, { kind: "dates", item_id: i.id, start_date: start, end_date: end });
  const length = (i: Item) => Math.round((msOf(i.end.date) - msOf(i.start.date)) / DAY);

  if ((m = /^move (.+) to (now|next|later)$/i.exec(t))) {
    const [, x, h] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      const horizon = h.toLowerCase();
      return card(`Move ${i.title} to ${horizon[0].toUpperCase()}${horizon.slice(1)}`, "change_horizon", i, { item_id: i.id }, { horizon: i.horizon }, { horizon }, { kind: "horizon", item_id: i.id, horizon });
    });
  }
  if (/^move .+ to .+$/i.test(t)) {
    // The item's name may hold " to ": try each split, the shortest time first.
    const cuts = [...t.matchAll(/ to /gi)].map((x) => x.index!).reverse();
    for (const at of cuts) {
      const x = t.slice(5, at);
      const when = t.slice(at + 4).replace(/\.$/, "");
      const period = parsePeriod(when);
      const day = !period && /^[a-z]+ \d{1,2}$/i.test(when) ? parseDay(when) : null;
      if (!period && !day) continue;
      return change(() => {
        const i = findItem(items, x);
        if (!isItem(i)) return i;
        if (period) {
          const r = move(i, period[0], dated(i) ? addDays(period[0], length(i)) : period[1]);
          // As chat.parse: "this quarter" / "this month" / the current Qn start on their first day.
          if (period[0] < today()) {
            const began = new Date(`${period[0]}T00:00:00Z`);
            r.body = `Here is the change. That period began ${began.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${began.getUTCDate()}, so the move starts on a past day. Preview it, then apply or discard it.`;
          }
          return r;
        }
        return move(i, day!, addDays(day!, dated(i) ? length(i) : 29));
      });
    }
  }
  if ((m = /^add a milestone ["'“‘](.+?)["'”’] to (.+) on ([a-z]+ \d{1,2})$/i.exec(t)) && parseDay(m[3])) {
    const [, name, x, d] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      const date = parseDay(d)!;
      return card(`Add the milestone “${name}” to ${i.title} on ${dayWords(date, true)}`, "set_milestone", i, { item_id: i.id }, {}, { milestone: { name, date, date_source: "typed" } }, { kind: "milestone", item_id: i.id, name, date });
    });
  }
  if ((m = /^(?:new )?feature ask(?: from (.+?))?:\s*(.+)$/i.exec(t))) {
    const [, from, title] = m;
    return change(() => {
      const requester = from ? unquote(from) : null;
      const kind = requester ? (names.some((n) => n.toLowerCase() === requester.toLowerCase()) ? "person" : "customer") : "person";
      const clean = unquote(title);
      const flow: Schemas["SimpleFlow"] = plainFlow({
        title: clean,
        steps: ["Open the alert", `Choose “${clean}”`, "Confirm", "See it saved"],
        screen: { title: "Alert detail", regions: ["Header with the alert's name", `${clean} panel`, "Save and cancel"] },
      });
      return card(`New feature ask${requester ? ` from ${requester}` : ""}: ${clean}`, "add_feature_ask", null, {}, {}, { title: clean, requester_name: requester ?? ctx.names[ctx.id] ?? null, requester_kind: kind }, null, flow);
    });
  }
  if ((m = /^add a launch task ["'“‘](.+?)["'”’] to (.+)$/i.exec(t))) {
    const [, title, x] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      // The mock's live launches: the items in progress.
      if (i.status !== "in_progress") return { kind: "note", body: `${i.title} has no live launch yet, so there is no launch to add a task to.`, cards: [] };
      return card(`Add the launch task “${title}” to ${i.title}'s launch`, "add_launch_task", i, { item_id: i.id, launch_id: stableUuid(`simple-launch/${i.key}`) }, {}, { title });
    });
  }
  if ((m = /^add a task ["'“‘](.+?)["'”’] to (.+?)(?: for (.+?))?(?: by ([a-z]+ \d{1,2}))?$/i.exec(t))) {
    const [, title, x, who, by] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      const due = by ? parseDay(by) : null;
      return card(
        `Add the task “${title}” to ${i.title}${who ? ` for ${who}` : ""}${due ? ` by ${dayWords(due, true)}` : ""}`,
        "add_item_task", i, { item_id: i.id }, {}, { title, owner_name: who ?? null, due_date: due },
      );
    });
  }
  if ((m = /^action item:\s*(.+?) to (.+?)(?: by ([a-z]+ \d{1,2}))?(?: on (.+))?$/i.exec(t))) {
    const [, who, what, by, x] = m;
    return change(() => {
      let i: Item | null = null;
      if (x) {
        const found = findItem(items, x);
        if (!isItem(found)) return found;
        i = found;
      }
      const due = by ? parseDay(by) : null;
      const target: Values = { ...(meeting ? { meeting_id: meeting.id } : {}), ...(i ? { item_id: i.id } : {}) };
      return card(`Action item: ${who} to ${what}${due ? ` by ${dayWords(due, true)}` : ""}${i ? ` (${i.title})` : ""}`, "add_action_item", i, target, {}, { title: what, owner_name: who, due_date: due });
    });
  }
  if ((m = /^rename (.+) to (.+)$/i.exec(t))) {
    const [, x, y] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      const title = unquote(y);
      return card(`Rename ${i.title} to “${title}”`, "edit_title", i, { item_id: i.id }, { title: i.title }, { title }, { kind: "title", item_id: i.id, title });
    });
  }
  if ((m = /^cut (.+)$/i.exec(t))) {
    const [, x] = m;
    return change(() => {
      const i = findItem(items, x);
      if (!isItem(i)) return i;
      if (i.status === "cut") return { kind: "note", body: `${i.title} is cut already.`, cards: [] };
      return card(`Cut ${i.title}`, "cut", i, { item_id: i.id }, { cut: false }, { cut: true }, { kind: "cut", item_id: i.id });
    });
  }
  const acted = chatAction(db, ctx, t, meeting, items, documentId, change);
  if (acted) return acted;
  return { kind: "question", body: `I did not understand that. ${EXAMPLES}`, cards: [], understood: false };
}

/** Chat actions' cards: "I understood one change:" (the contract's reply line). */
const ONE_CHANGE = "I understood one change:";
/** The meeting-only phrases' answer outside a meeting (no card). */
export const MEETING_ONLY = "Minutes notes, open questions and agenda changes belong to a meeting.";
/** Ops applied here, not through the change engine: a decision, the minutes' notes and the agenda. */
const LOCAL_OPS = new Set(["record_decision", "minutes_note", "open_question", "agenda_next", "agenda_skip"]);

/**
 * The chat actions' phrases (the contract's): "<person> owns <item>", "<person> decides
 * <item>", "decision[ by <person>]: <text>", and in a meeting only "note: <text>", "open
 * question: <text>", "next: <item>" and "skip <item>". Null: none of them.
 */
function chatAction(db: SimpleDb, ctx: ChatCtx, t: string, meeting: Meeting | null, items: Item[], documentId: string | null, change: (build: () => Reply) => Reply): Reply | null {
  const draft = (summary: string, op: string, item: Item | null, target: Values, before: Values, after: Values, preview: Preview): Reply => ({
    kind: "cards",
    body: ONE_CHANGE,
    cards: [{ op, target, before, after, summary, item_id: item?.id ?? null, item_title: item?.title ?? null, preview, flow: null, fixes: [] }],
  });
  const person = (x: string): { id: string; name: string } | Reply => {
    const n = unquote(x).toLowerCase();
    const all = Object.entries(ctx.names);
    const hit = all.find(([, v]) => v.toLowerCase() === n) ?? all.find(([, v]) => v.toLowerCase().split(" ")[0] === n);
    return hit ? { id: hit[0], name: hit[1] } : { kind: "question", body: `Who is “${unquote(x)}”? Name a person of the company.`, cards: [] };
  };
  const isPerson = (x: { id: string; name: string } | Reply): x is { id: string; name: string } => "id" in x;
  const text = (x: string) => x.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
  let m: RegExpExecArray | null;

  if ((m = /^(note|open question):\s*(.+)$/i.exec(t)) || (m = /^(next):\s*(.+)$/i.exec(t)) || (m = /^(skip)\s+(.+)$/i.exec(t))) {
    const [, verb, rest] = m;
    if (!meeting) return { kind: "note", body: MEETING_ONLY, cards: [] };
    return change(() => {
      const v = verb.toLowerCase();
      if (v === "note") return draft(`Add to the minutes: ${text(rest)}`, "minutes_note", null, { meeting_id: meeting.id }, {}, { text: text(rest) }, { kind: "note", text: text(rest) });
      if (v === "open question") return draft(`Add the open question: ${text(rest)}`, "open_question", null, { meeting_id: meeting.id }, {}, { text: text(rest) }, { kind: "question", text: text(rest) });
      const i = findItem(items, rest);
      if (!isItem(i)) return i;
      const move = v === "next" ? "next" : "skip";
      return draft(move === "next" ? `Take ${i.title} next` : `Skip ${i.title}`, move === "next" ? "agenda_next" : "agenda_skip", i, { meeting_id: meeting.id, item_id: i.id }, {}, { move }, { kind: "agenda", item_id: i.id, move, item_title: i.title });
    });
  }
  if ((m = /^decision(?: by (.+?))?:\s*(.+)$/i.exec(t))) {
    const [, by, what] = m;
    return change(() => {
      const who = by ? person(by) : { id: ctx.id, name: ctx.names[ctx.id] ?? "someone" };
      if (!isPerson(who)) return who;
      const words = text(what);
      const target: Values = meeting ? { meeting_id: meeting.id } : documentId ? { document_id: documentId } : {};
      return draft(`Record the decision: ${words}`, "record_decision", null, target, {}, { text: words, decider_id: who.id }, { kind: "decision", text: words, decider_name: who.name, where: meeting ? "meeting" : "page" });
    });
  }
  if ((m = /^(.+?) (owns|decides) (.+)$/i.exec(t)) && !/^who$/i.test(m[1])) {
    const [, x, verb, y] = m;
    return change(() => {
      const who = person(x);
      if (!isPerson(who)) return who;
      const i = findItem(items, y);
      if (!isItem(i)) return i;
      if (verb.toLowerCase() === "owns") {
        const before = itemOwnerId(db, i.key);
        return draft(`Make ${who.name} the owner of ${i.title}`, "set_owner", i, { item_id: i.id }, { owner_id: before }, { owner_id: who.id }, {
          kind: "owner", item_id: i.id, person_id: who.id, person_name: who.name, before_name: before ? (ctx.names[before] ?? i.owner?.name ?? null) : null,
        });
      }
      const before = itemDeciderId(db, i.key, ctx.roles);
      return draft(`Make ${who.name} the decider of ${i.title}`, "set_decider", i, { item_id: i.id }, { decider_id: before }, { decider_id: who.id }, {
        kind: "decider", item_id: i.id, person_id: who.id, person_name: who.name, before_name: before ? (ctx.names[before] ?? null) : null,
      });
    });
  }
  return null;
}

/** The roadmap as the reader reads it (and as an owner, for the constraint check). */
function itemsFor(db: SimpleDb, ctx: ChatCtx): Item[] {
  return roadmapOut(db, ctx.role, new URLSearchParams(), { id: ctx.id, role: ctx.role, roles: ctx.roles, owners: ctx.owners, names: ctx.names })?.items ?? [];
}

const VERSIONED = new Set(["move_dates", "change_horizon", "edit_title", "cut"]);

/** The constraint check as if the card applied, and its one-click fixes. */
function asIf(db: SimpleDb, c: Pick<StoredCard, "op" | "item_id" | "after">): { flags: Schemas["SimpleItemFlags"][]; fixes: Fix[] } {
  if (!VERSIONED.has(c.op) || !c.item_id) return { flags: [], fixes: [] };
  const key = Object.keys(db.ids).find((k) => db.ids[k] === c.item_id);
  const s = db.items.find((x) => x.key === key);
  if (!key || !s) return { flags: [], fixes: [] };
  const copy = structuredClone({ items: db.items, own: db.own });
  const a = c.after;
  if (c.op === "move_dates") db.own[key] = { start: String(a.start_date), end: String(a.end_date), source: "typed" };
  if (c.op === "change_horizon") s.horizon = a.horizon as typeof s.horizon;
  if (c.op === "edit_title") s.title = String(a.title);
  if (c.op === "cut") s.status = "cut";
  const items = roadmapOut(db, "owner", new URLSearchParams())?.items ?? [];
  Object.assign(db, copy);
  const byId = new Map(items.map((i) => [i.id, i]));
  const me = byId.get(c.item_id);
  if (!me) return { flags: [], fixes: [] };
  const ids = [me.id, ...me.needed_by];
  const flags = ids.map((id) => byId.get(id)).filter((i): i is Item => !!i && i.flags.some((f) => f.state === "red")).map((i) => ({ item_id: i.id, flags: i.flags.filter((f) => f.state === "red") }));
  // One-click fixes of each red dependency link, the item's and its dependents' (chat._fixes).
  const fixes: Fix[] = [];
  const sd = (it: Item) => {
    const k = storedDates(db, it.key);
    return { start_date: k.start, end_date: k.end };
  };
  for (const e of ids.map((id) => byId.get(id)).filter((i): i is Item => !!i)) {
    for (const f of e.flags) {
      const dep = f.state === "red" && f.kind === "dependency_order" && f.subject ? byId.get(f.subject) : undefined;
      if (!dep) continue;
      const before = { [e.id]: sd(e), [dep.id]: sd(dep) };
      const target = { item_id: e.id, subject: dep.id };
      fixes.push(
        { label: `Start ${e.title} after ${dep.title} ends`, op: "shift_dependents", target, before, after: {} },
        { label: `End ${dep.title} before ${e.title} starts`, op: "move_dependency", target, before, after: {} },
        { label: "Accept as a risk", op: "accept_risk", target: { item_id: e.id, flag: f.kind, subject: dep.id }, before: { risk: null }, after: { risk: { note: "Accepted in the chat" } } },
      );
    }
  }
  return { flags, fixes };
}

function meetingOf(chat: ChatDb, c: StoredCard): Meeting | null {
  return c.meeting_id ? (chat.meetings[c.meeting_id] ?? null) : null;
}

/** Whether the reader may apply in the meeting at all (meeting_rules), and why not. */
function meetingBar(m: Meeting, ctx: ChatCtx): string | null {
  if (m.ended) return "The meeting has ended";
  if (ctx.role === "viewer") return "Viewers ask questions in the meeting chat";
  if (m.change_mode === "presenter" && ctx.id !== m.presenter_id) return "Only the presenter applies changes in this meeting";
  if (m.change_mode === "named" && ctx.id !== m.presenter_id && !m.change_people.includes(ctx.id)) return "Only the presenter and the people they named apply changes in this meeting";
  return null;
}

/** What the reader's Apply does now: apply (they decide), propose (others do), or nothing. */
function mayOf(db: SimpleDb, chat: ChatDb, c: StoredCard, ctx: ChatCtx): { may: "apply" | "propose" | null; why_not: string | null } {
  if (c.status !== "open") return { may: null, why_not: null };
  const m = meetingOf(chat, c);
  const bar = m ? meetingBar(m, ctx) : ctx.role === "viewer" ? "Viewers read the plan; they don't change it" : null;
  if (bar) return { may: null, why_not: bar };
  const item = c.item_id ? itemsFor(db, ctx).find((i) => i.id === c.item_id) : undefined;
  // Filing a feature ask is every commenter's right (Requests), as are a meeting's notes, agenda
  // and decisions (the meeting's rules came first) and a decision on Ask; else the item's rule.
  const decides = c.op === "add_feature_ask" || LOCAL_OPS.has(c.op) ? true : c.item_id ? !!item?.can_decide : ctx.role === "owner";
  return { may: decides ? "apply" : "propose", why_not: null };
}

function cardOut(db: SimpleDb, chat: ChatDb, c: StoredCard, ctx: ChatCtx) {
  const check = c.flag !== undefined ? { flags: c.flag ? [c.flag] : [] } : asIf(db, c);
  const { flag: _flag, thread: _thread, meeting_id: _meeting, undo: _undo, ...rest } = c;
  void _undo;
  void _flag;
  void _thread;
  void _meeting;
  return { ...rest, ...mayOf(db, chat, c, ctx), flags: check.flags };
}

function rulesOut(m: Meeting, ctx: ChatCtx) {
  const ref = (id: string) => ({ id, name: ctx.names[id] ?? "someone" });
  return {
    change_mode: m.change_mode, change_people: m.change_people.map(ref), presenter: ref(m.presenter_id),
    is_presenter: ctx.id === m.presenter_id, may_apply: meetingBar(m, ctx) === null, ask_only: ctx.role === "viewer", ended: m.ended,
  };
}

function threadOut(db: SimpleDb, chat: ChatDb, t: Thread | null, ctx: ChatCtx, meeting: Meeting | null) {
  return {
    understood: true,
    id: t?.id ?? null,
    meeting_id: meeting?.id ?? null,
    messages: (t?.messages ?? []).map(({ card_ids, ...msg }) => ({ ...msg, cards: card_ids.map((id) => cardOut(db, chat, chat.cards[id], ctx)) })),
    rules: meeting ? rulesOut(meeting, ctx) : null,
  };
}

/** The line and Oracle's reply; with `onlyUnderstood` a line the reader does not know writes nothing. Whether it understood. */
function say(db: SimpleDb, chat: ChatDb, key: string, meeting: Meeting | null, ctx: ChatCtx, text: string, onlyUnderstood = false, documentId: string | null = null): boolean {
  const reply = parse(db, ctx, text, meeting, itemsFor(db, ctx), Object.values(ctx.names), documentId);
  const understood = reply.understood !== false;
  if (onlyUnderstood && !understood) return false;
  const t = (chat.threads[key] ??= { id: crypto.randomUUID(), meeting_id: meeting?.id ?? null, owner_id: meeting ? null : ctx.id, messages: [] });
  const at = now();
  t.messages.push({ id: crypto.randomUUID(), author_kind: "person", author_id: ctx.id, author_name: ctx.names[ctx.id] ?? "someone", body: text, at, kind: "request", card_ids: [] });
  const id = crypto.randomUUID();
  const ids = reply.cards.map((d) => {
    const c: StoredCard = { ...d, id: crypto.randomUUID(), message_id: id, thread: key, meeting_id: meeting?.id ?? null, status: "open", change_id: null, decided_by_name: null, decided_at: null, decision_id: null };
    c.fixes = asIf(db, c).fixes;
    chat.cards[c.id] = c;
    return c.id;
  });
  t.messages.push({ id, author_kind: "oracle", author_id: null, author_name: "Oracle", body: reply.body, at, kind: reply.kind, card_ids: ids });
  return understood;
}

/** Whether the reader sees the card: their own Ask thread's, or a meeting they attend. */
function sees(chat: ChatDb, c: StoredCard, ctx: ChatCtx): boolean {
  const m = meetingOf(chat, c);
  if (m) return m.attendee_ids.includes(ctx.id);
  return c.thread === `ask:${ctx.id}` || c.thread === `walk:${ctx.id}`;
}

async function engine(db: SimpleDb, ctx: ChatCtx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(new URL(path, "http://mock.local"), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await routeSimpleChanges(db, ctx, req, path.split("?")[0].split("/").filter(Boolean), new URL(req.url).searchParams);
  return res ?? json(404, { detail: "Not found" });
}

const OP_TITLE: Record<string, string> = {
  move_dates: "Move dates", change_horizon: "Move to another horizon", edit_title: "Retitle", cut: "Cut", add_item_task: "Add a task",
  add_action_item: "Add an action item", add_launch_task: "Add a launch task", set_milestone: "Set a milestone", add_feature_ask: "New feature ask", accept_risk: "Accept as a risk",
};

/** GET /v1/simple/walk: broken links, then the next meeting's agenda decisions, then proposals waiting on the reader. */
async function walkOut(db: SimpleDb, chat: ChatDb, ctx: ChatCtx) {
  const items = itemsFor(db, ctx);
  const byId = new Map(items.map((i) => [i.id, i]));
  const steps: unknown[] = [];
  for (const i of items) {
    for (const f of i.flags.filter((x) => x.state === "red" && x.fixes.length > 0)) {
      const dep = f.subject ? byId.get(f.subject) : undefined;
      const sd = (it: Item) => {
        const s = storedDates(db, it.key);
        return { start_date: s.start, end_date: s.end };
      };
      const fixes: Fix[] = f.fixes.map((op) =>
        op === "accept_risk"
          ? { label: "Accept as risk", op, target: { item_id: i.id, flag: f.kind, subject: f.subject ?? null }, before: { risk: null }, after: { risk: { note: "Accepted as a risk in a walk-through" } } }
          : {
              label: op === "shift_dependents" ? "Move dependents" : "Move dependency", op, target: { item_id: i.id, subject: f.subject ?? null },
              before: { [i.id]: sd(i), ...(dep ? { [dep.id]: sd(dep) } : {}) }, after: {},
            },
      );
      const id = stableUuid(`simple-walk/${ctx.id}/${i.id}/${f.kind}/${f.subject ?? ""}`);
      const old = chat.cards[id];
      if (!old || old.status !== "open") {
        chat.cards[id] = {
          id, message_id: null, thread: `walk:${ctx.id}`, meeting_id: null, op: fixes[0].op, target: fixes[0].target, before: fixes[0].before, after: fixes[0].after,
          summary: `${i.title}: ${f.reason}`, item_id: i.id, item_title: i.title, status: "open", preview: null, flow: null, fixes, flag: { item_id: i.id, flags: [f] },
          change_id: null, decided_by_name: null, decided_at: null, decision_id: null,
        };
      }
      steps.push({ id: `broken_link:${i.id}:${f.subject ?? f.kind}`, kind: "broken_link", title: `${i.title} has a broken link`, why: f.reason, card: cardOut(db, chat, chat.cards[id], ctx), change: null, decision: null });
    }
  }
  const next = Object.values(chat.meetings).find((m) => !m.ended && m.attendee_ids.includes(ctx.id));
  for (const d of next?.agenda ?? []) steps.push({ id: `agenda_decision:${d.id}`, kind: "agenda_decision", title: d.title, why: `On the agenda of ${next!.title}: read it before the meeting.`, card: null, change: null, decision: d });
  const res = await engine(db, ctx, "GET", "/v1/simple/changes?status=proposed");
  const changes = res.ok ? ((await res.json()) as Schemas["SimpleChangeOut"][]) : [];
  for (const c of changes.filter((x) => x.can_decide).sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const item = byId.get(String(c.target.item_id ?? ""));
    steps.push({ id: `proposal:${c.id}`, kind: "proposal", title: `${OP_TITLE[c.op] ?? c.op}: ${item?.title ?? "an item"}`, why: `${c.by_name} proposes it${c.reason ? `: ${c.reason}` : ""}. You decide.`, card: null, change: c, decision: null });
  }
  return { steps };
}

const EMPTY_AGENDA: MeetingAgenda = { next: null, skipped: [] };

/** A local op's Apply: the note, the agenda move or the decision; the result as the change engine's (applied). */
function applyLocal(c: StoredCard, meeting: Meeting | null, ctx: ChatCtx, s8?: ChatMeetings): Schemas["SimpleChangeResult"] {
  const by = ctx.names[ctx.id] ?? "someone";
  const at = now();
  const remote = meeting?.s8 && s8 ? s8 : null;
  const undo: Values = {};
  let decision: string | null = null;
  if (c.op === "minutes_note" || c.op === "open_question") {
    const n: MeetingNote = { kind: c.op === "minutes_note" ? "note" : "question", text: String(c.after.text ?? ""), by_name: by, card_id: c.id };
    if (remote) remote.note(meeting!.id, n);
    else if (meeting) (meeting.notes ??= []).push(n);
  } else if (c.op === "agenda_next" || c.op === "agenda_skip") {
    const was = remote ? remote.agenda(meeting!.id) : (meeting?.agenda_state ?? EMPTY_AGENDA);
    undo.agenda = structuredClone(was);
    const it = { id: String(c.item_id), title: c.item_title ?? "" };
    const next: MeetingAgenda =
      c.op === "agenda_next"
        ? { next: it, skipped: was.skipped.filter((x) => x.id !== it.id) }
        : { next: was.next?.id === it.id ? null : was.next, skipped: [...was.skipped.filter((x) => x.id !== it.id), it] };
    if (remote) remote.setAgenda(meeting!.id, next);
    else if (meeting) meeting.agenda_state = next;
  } else if (c.op === "record_decision") {
    const text = String(c.after.text ?? "");
    const decider = String(c.after.decider_id ?? ctx.id);
    if (remote) decision = remote.decide(meeting!.id, text, decider, null);
    else if (meeting) {
      decision = crypto.randomUUID();
      meeting.decisions.push({ id: decision, title: text, card_id: c.id, at });
    } else if (s8) undo.decision_id = s8.decide(null, text, decider, (c.target.document_id as string | undefined) ?? null);
  }
  Object.assign(c, { status: "applied", change_id: crypto.randomUUID(), decided_by_name: by, decided_at: at, decision_id: decision, undo });
  const change = {
    id: c.change_id, session_id: null, document_id: null, draft_ids: [], op: c.op, target: c.target, before: c.before, after: c.after, status: "applied", by: ctx.id, by_name: by, at,
    decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: true,
  };
  return { change, flags: [] } as unknown as Schemas["SimpleChangeResult"];
}

/** A local op's Undo: the note out, the agenda as it was, the decision gone. */
function unapplyLocal(c: StoredCard, meeting: Meeting | null, s8?: ChatMeetings): void {
  const remote = meeting?.s8 && s8 ? s8 : null;
  if (c.op === "minutes_note" || c.op === "open_question") {
    if (remote) remote.unnote(meeting!.id, c.id);
    else if (meeting) meeting.notes = (meeting.notes ?? []).filter((x) => x.card_id !== c.id);
  } else if (c.op === "agenda_next" || c.op === "agenda_skip") {
    const was = (c.undo?.agenda as MeetingAgenda | undefined) ?? EMPTY_AGENDA;
    if (remote) remote.setAgenda(meeting!.id, was);
    else if (meeting) meeting.agenda_state = was;
  } else if (c.op === "record_decision") {
    const id = c.decision_id ?? (c.undo?.decision_id as string | undefined);
    if (remote && id) remote.undecide(id);
    else if (!meeting && id) s8?.undecide(id);
  }
}

/** The S9 routes; null for any other path. */
export async function routeSimpleChat(db: SimpleDb, chat: ChatDb, ctx: ChatCtx, req: Request, p: string[], s8?: ChatMeetings): Promise<Response | null> {
  if (p[1] !== "simple") return null;
  const m = req.method;
  const body = async () => (await req.json().catch(() => ({}))) as Values;
  // S8's review meetings host the chat too: mirror the asked one, and those cards were made in, from S8's rules.
  if (s8) {
    const ids = new Set([...Object.values(chat.meetings).filter((x) => x.s8).map((x) => x.id), ...(p[2] === "meetings" && p[3] && !chat.meetings[p[3]] ? [p[3]] : [])]);
    for (const id of ids) {
      const found = s8.find(id);
      if (found) chat.meetings[id] = { ...(chat.meetings[id] ?? { agenda: [], decisions: [] }), ...found, id, s8: true };
    }
  }

  if (p[2] === "walk" && !p[3] && m === "GET") return json(200, await walkOut(db, chat, ctx));

  if (p[2] === "chat" && !p[3] && m === "GET") return json(200, threadOut(db, chat, chat.threads[`ask:${ctx.id}`] ?? null, ctx, null));
  if (p[2] === "chat" && p[3] === "messages" && !p[4] && m === "POST") {
    const b = await body();
    const text = String(b.text ?? "").trim();
    if (!text || text.length > 2000) return json(422, { detail: "text: 1 to 2000 characters" });
    const understood = say(db, chat, `ask:${ctx.id}`, null, ctx, text, b.only_understood === true, typeof b.page === "string" ? (s8?.documentOf(b.page) ?? null) : null);
    return json(200, { ...threadOut(db, chat, chat.threads[`ask:${ctx.id}`] ?? null, ctx, null), understood });
  }

  if (p[2] === "meetings" && p[3] && p[4] === "chat") {
    const meeting = chat.meetings[p[3]];
    if (!meeting) return json(404, { detail: "No such meeting" });
    if (!meeting.attendee_ids.includes(ctx.id)) return json(403, { detail: "Only the meeting's attendees read and write its chat" });
    const key = `meeting:${meeting.id}`;
    if (!p[5] && m === "GET") return json(200, threadOut(db, chat, chat.threads[key] ?? null, ctx, meeting));
    if (p[5] === "messages" && m === "POST") {
      const text = String((await body()).text ?? "").trim();
      if (!text || text.length > 2000) return json(422, { detail: "text: 1 to 2000 characters" });
      const understood = say(db, chat, key, meeting, ctx, text);
      return json(200, { ...threadOut(db, chat, chat.threads[key], ctx, meeting), understood });
    }
    if (p[5] === "mode" && m === "PUT") {
      if (ctx.id !== meeting.presenter_id) return json(403, { detail: "Only the presenter changes who may apply" });
      const b = await body();
      const mode = String(b.change_mode ?? "") as Mode;
      if (!["everyone", "presenter", "named"].includes(mode)) return json(422, { detail: "change_mode: everyone, presenter or named" });
      const people = Array.isArray(b.change_people) ? b.change_people.map(String) : [];
      if (people.length > 2) return json(422, { detail: "change_people: at most 2" });
      if (people.some((id) => !meeting.attendee_ids.includes(id))) return json(422, { detail: "change_people: attendees of the meeting" });
      meeting.change_mode = mode;
      meeting.change_people = mode === "named" ? people : [];
      if (meeting.s8) s8?.setMode(meeting.id, mode, meeting.change_people);
      return json(200, rulesOut(meeting, ctx));
    }
    return null;
  }

  if (p[2] === "chat" && p[3] === "cards" && p[4] && p[5] && m === "POST") {
    const c = chat.cards[p[4]];
    if (!c || !sees(chat, c, ctx)) return json(404, { detail: "No such card" });
    if (p[5] === "discard") {
      if (c.status !== "open") return json(409, { detail: `This card is ${c.status} already` });
      // Those the change mode bars from applying may not discard either (the API's rule).
      const { may, why_not } = mayOf(db, chat, c, ctx);
      if (!may) return json(403, { detail: why_not ?? "You may not discard this card" });
      c.status = "discarded";
      return json(200, cardOut(db, chat, c, ctx));
    }
    if (p[5] === "undo") {
      if (c.status !== "applied" || !c.change_id) return json(409, { detail: `Only an applied card undoes; this one is ${c.status}` });
      const meeting = meetingOf(chat, c);
      if (LOCAL_OPS.has(c.op)) {
        if (meeting?.ended) return json(409, { detail: "The meeting has ended" });
        unapplyLocal(c, meeting, s8);
      } else {
        const res = await engine(db, ctx, "POST", `/v1/simple/changes/${c.change_id}/undo`);
        if (!res.ok) return res;
        if (meeting?.s8 && c.decision_id) s8?.undecide(c.decision_id);
      }
      c.status = "undone";
      if (meeting) meeting.decisions = meeting.decisions.filter((d) => d.card_id !== c.id);
      return json(200, cardOut(db, chat, c, ctx));
    }
    if (p[5] === "apply") {
      const { may, why_not } = mayOf(db, chat, c, ctx);
      if (c.status !== "open") return json(409, { detail: `This card is ${c.status} already` });
      if (!may) return json(403, { detail: why_not ?? "You may not apply this change" });
      const b = await body();
      const n = b.fix == null ? null : Number(b.fix);
      if (n != null && !c.fixes[n]) return json(422, { detail: "fix: one of the card's fixes" });
      const use = n == null ? c : c.fixes[n];
      if (LOCAL_OPS.has(c.op)) {
        const result = applyLocal(c, meetingOf(chat, c), ctx, s8);
        return json(200, { card: cardOut(db, chat, c, ctx), result });
      }
      // The new owner or decider's name, for the roadmap's owner line.
      if (c.op === "set_owner" || c.op === "set_decider") {
        const id = String(c.after.owner_id ?? c.after.decider_id ?? "");
        if (id && ctx.names[id]) (db.people ??= {})[id] = ctx.names[id];
      }
      const res = await engine(db, ctx, "POST", "/v1/simple/changes", { op: use.op, target: use.target, before: use.before, after: use.after });
      if (!res.ok) return res;
      const result = (await res.json()) as Schemas["SimpleChangeResult"];
      Object.assign(c, {
        status: result.change.status === "applied" ? "applied" : "proposed", change_id: result.change.id,
        decided_by_name: ctx.names[ctx.id] ?? "someone", decided_at: now(),
      });
      if (n != null) Object.assign(c, { op: use.op, target: use.target, before: use.before, after: use.after });
      const meeting = meetingOf(chat, c);
      if (meeting && (c.status as StoredCard["status"]) === "applied") {
        // In an S8 review meeting the applied card is one of its meeting decisions (meeting_decisions).
        c.decision_id = meeting.s8 && s8 ? s8.decide(meeting.id, n == null ? c.summary : c.fixes[n].label, ctx.id, null) : crypto.randomUUID();
        meeting.decisions.push({ id: c.decision_id, title: n == null ? c.summary : c.fixes[n].label, card_id: c.id, at: c.decided_at! });
      }
      return json(200, { card: cardOut(db, chat, c, ctx), result });
    }
  }
  return null;
}

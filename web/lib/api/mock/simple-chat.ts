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
import { newCompany, stableUuid } from "./ids";
import { changePhrase } from "./simple-change-words";
import { CUT_ALL, cutDependents, cutRoute, markMeetingProposal, meetingRoute, proposalRoute, proposeOffAgenda, routeSimpleChanges, type SimpleChangesCtx } from "./simple-changes";
import { GOALS, goalId, itemDeciderId, itemOwnerId, knowTalkGoals, lookalikes, prdCode, roadmapOut, simpleWindows, storedDates, type SimpleDb } from "./simple-roadmap";
import { fileSuggestion, unfileSuggestion } from "./simple-suggestions";

type Values = Record<string, unknown>;
type Item = Schemas["SimpleRoadmapItem"];

/** fix4 qa-simple-roadmap-9: the dates an item stores as the reader reads it (their roadmap's
 * item: the working draft's for those who see it, else the published version's), the
 * `before` a card sends, so a commenter proposes against the dates their roadmap shows. */
function seenDates(i: Item): { start: string | null; end: string | null } {
  const own = (d: Item["start"]) => (d.source === "typed" || d.source === "accepted" ? d.date : null);
  return { start: own(i.start), end: own(i.end) };
}
/** walkc-meeting r2 (5b): the dates the item shows now and their source (chat._current): a move card's Before. */
function currentDates(i: Item): { start_date: string; end_date: string; source: Item["source"] } {
  return { start_date: i.start.date, end_date: i.end.date, source: i.source };
}
type Role = Schemas["Me"]["role"];
type Preview =
  | { kind: "dates"; item_id: string; start_date: string; end_date: string; shift?: [number, number]; current?: ReturnType<typeof currentDates> }
  | { kind: "horizon"; item_id: string; horizon: string }
  | { kind: "title"; item_id: string; title: string }
  | { kind: "milestone"; item_id: string; name: string; date: string }
  | { kind: "cut"; item_id: string }
  | { kind: "owner" | "decider"; item_id: string; person_id: string; person_name: string; before_name: string | null }
  | { kind: "decision"; text: string; decider_name: string; where: "meeting" | "page"; proposed_to?: string; not_to?: string }
  | { kind: "note" | "question"; text: string }
  | { kind: "agenda"; item_id: string; move: "next" | "skip"; item_title: string }
  | { kind: "suggestion"; goal_id: string; goal_title: string; title: string; outcome: string; looks_like: { code: string; title: string; why: string }[] }
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
  /** Who applied it (the API's decided_by; not sent): they may undo it. */
  decided_by?: string | null;
  decided_at: string | null;
  decision_id: string | null;
  /** Chat actions: what Undo restores (the agenda before, the decision made). */
  undo?: Values;
  /** chat-latest-card (simple_chat_cards.redo_of, not sent): the earlier open draft this card offers again because the person asked to change it. */
  redo_of?: string | null;
  /** roadmap-talk: the change in plain words, and the fields Correct opens (null: none). */
  change_words?: { before: string; after: string } | null;
  correct?: { fields: string[]; values: Record<string, string | null> } | null;
}

interface StoredMessage {
  id: string;
  author_kind: "person" | "oracle";
  author_id: string | null;
  author_name: string;
  body: string;
  at: string;
  /** As the API's stored prompt: a line another job wrote may carry its own ("discussion_reply.v2"; threadOut reads it as an answer). */
  kind: ChatKind | (string & {});
  card_ids: string[];
  /** Oracle's line: the person's line it answers. */
  reply_to: string | null;
  /** A clarify question's choices (the last is "Neither"), and the one picked. */
  choices: { index: number; label: string }[];
  picked: number | null;
  retry: boolean;
  /** Private: each choice's card (Neither: null). */
  choice_drafts?: (Draft | null)[];
  /** roadmap-talk: where Oracle's answer comes from ("From the PRD · F-16 Adaptive pacing"). */
  source?: string | null;
  /** ask-length-limit: where the parts Oracle cannot change yet are changed. */
  links?: { label: string; href: string }[];
  /** Private: the reader's job for a pending (or failed) line. */
  reading?: { text: string; role: Role; meeting_id: string | null; attempts: number; ask: boolean; document_id?: string | null };
}

type ChatKind = "request" | "cards" | "question" | "answer" | "note" | "pending" | "failed" | "ask";
const KINDS: readonly string[] = ["request", "cards", "question", "answer", "note", "pending", "failed", "ask"] satisfies ChatKind[];

interface Thread {
  id: string;
  meeting_id: string | null;
  owner_id: string | null;
  messages: StoredMessage[];
  /** ask-fresh: an Ask chat's page and the Oracle's Ask chat it handed its questions to. */
  page?: string;
  ask_id?: string | null;
  started_at?: string;
  /** Started under "General": Recent names it so (oracle.simple.chat._summary). */
  general?: boolean;
}

/** Simple's page names as the panel says them (oracle.discussions.context.page_name): never a route. */
const PAGE_NAMES: Record<string, string> = { "": "Home", "one-pagers": "One-pager", roadmap: "Roadmap", priorities: "Priorities", meetings: "Meetings", decisions: "Decisions", prds: "One-pager" };
export function pageName(page: string | null | undefined): string {
  const parts = pageOf(page).split("/").filter(Boolean).slice(1);
  const name = PAGE_NAMES[parts[0] ?? ""] ?? "Home";
  return name === "One-pager" && parts.length < 2 ? "One-pagers" : name;
}

/** The caller's own Ask chat `id` (ask-fresh): its key, or null for anyone else's or a meeting's. */
function ownChat(chat: ChatDb, ctx: ChatCtx, id: string | null | undefined): string | null {
  if (!id) return null;
  const hit = Object.entries(chat.threads).find(([key, t]) => t.id === id && key.startsWith(`ask:${ctx.id}:`));
  return hit ? hit[0] : null;
}

function chatSummary(key: string, t: Thread, ctx?: ChatCtx) {
  const page = t.page ?? pageOf(key.split(":").slice(2).join(":").split("#")[0]);
  const general = t.general === true;
  // Its first question: the person's first line, else the first in the Oracle's Ask chat it handed it to.
  const first = t.messages.find((m) => m.author_kind === "person")?.body ?? (t.ask_id ? (ctx?.askQuestion?.(t.ask_id) ?? null) : null);
  const question = first ? first.split(/\s+/).filter(Boolean).join(" ").slice(0, 200) : null;
  return { id: t.id, page, page_name: general ? "General" : pageName(page), last_at: t.messages.at(-1)?.at ?? t.started_at ?? now(), ask_id: t.ask_id ?? null, general, question };
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
  /** meet-chat-right-prd: the PRD the meeting reviews (its slug): its chat reads only its items. */
  prd?: string | null;
  /** How it ended: who ended it, or by itself once its time ran out, and when. */
  ended_at?: string | null;
  ended_by?: string | null;
  ended_by_itself?: boolean;
  /** meeting-changes-only-its-agenda (agenda.Agenda): the roadmaps (ids) it reviews; a card on an item elsewhere is only sent to its owner. */
  roadmaps?: string[];
}

/** The meeting's live notes and open questions (SimpleMeetingOut.notes). */
export type MeetingNote = Schemas["SimpleMeetingNote"];
/** The meeting's agenda changes (SimpleMeetingOut.agenda). */
export type MeetingAgenda = Schemas["SimpleAgenda"];

/**
 * S8's review meetings as the chat reads and writes them (server.ts builds it over
 * ./simple-meetings.ts): a meeting's rules, its notes, agenda and decisions, and the
 * decisions an Ask line records on a page's document (the Decisions page).
 */
export interface ChatMeetings {
  find(id: string): Pick<Meeting, "title" | "presenter_id" | "attendee_ids" | "change_mode" | "change_people" | "ended" | "prd" | "ended_at" | "ended_by" | "ended_by_itself" | "roadmaps"> | null;
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
  /** Who confirms a commenter's decision on Ask: the document's decider, else an owner (an approver or above). */
  proposeTo(documentId: string | null): { id: string; name: string } | null;
  /** A commenter's decision on Ask, open on the Decisions page for `deciderId`. */
  propose(title: string, deciderId: string, documentId: string | null, id?: string): string;
}

export interface ChatDb {
  threads: Record<string, Thread>;
  cards: Record<string, StoredCard>;
  meetings: Record<string, Meeting>;
}

export type ChatCtx = SimpleChangesCtx & {
  roles: Record<string, Role>;
  /** A commenter's decision on Ask as an open decision of the decision log (POST /v1/decisions as them); its id. */
  proposeDecision?: (b: Schemas["DecisionCreate"]) => Promise<string | null>;
  /** Who confirms it (ChatMeetings.proposeTo). */
  proposeTo?: (documentId: string | null) => { id: string; name: string } | null;
  /** ask-fresh: whether `id` is the caller's own private panel chat (PUT /v1/simple/chats/{id}/ask). */
  ownsDiscussion?: (id: string) => boolean;
  /** Recent chats: the first line the caller asked in their Oracle's Ask chat `id` (oracle.simple.chat._questions). */
  askQuestion?: (id: string) => string | null;
  /** ask_actions.slack_reach: whether Slack sends person `id` a ping ("on"), they turned it off ("off") or Slack is not connected ("none"). */
  slackReach?: (id: string) => "on" | "off" | "none";
};

/** On Ask a commenter's decision is a proposal (the owner's pick, 2026-10-27): who it goes to, else null. */
function askProposal(ctx: ChatCtx, meeting: Meeting | null, documentId: string | null): string | null {
  if (meeting || ctx.role !== "commenter") return null;
  return ctx.proposeTo?.(documentId)?.name ?? "an owner";
}

/** The invented meeting's id (stable: specs open /simple/meetings/{id}). */
export const CHAT_MEETING_ID = stableUuid("simple-meeting/weekly-plan-review");

/** The invented meeting: the first owner presents; every active member attends. */
export function seedSimpleChat(members: { id: string; role: Role; status?: string }[]): ChatDb {
  const active = members.filter((m) => m.status !== "disabled");
  const presenter = active.find((m) => m.role === "owner")?.id ?? active[0]?.id ?? "";
  // A new company has no review meeting yet: the walk lists no agenda.
  if (newCompany()) return { threads: {}, cards: {}, meetings: {} };
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

/** The meeting chat's stray line (the "simple-chat-stray" scenario). */
export const STRAY_REPLY = "Here is what I found about Delivery pipeline v2.";

/**
 * meet-chat-kind: the "simple-chat-stray" scenario's meeting chat already holds a line an earlier
 * build's discussion reply job wrote there, stored with that job's prompt, answering the owner's
 * change request.
 */
export function seedStrayReply(chat: ChatDb, owner: { id: string; name: string }): void {
  const at = new Date(mockNowMs() - 60_000).toISOString();
  const asked = crypto.randomUUID();
  const base = { card_ids: [], choices: [], picked: null, retry: false };
  chat.threads[`meeting:${CHAT_MEETING_ID}`] = {
    id: crypto.randomUUID(), meeting_id: CHAT_MEETING_ID, owner_id: null,
    messages: [
      { ...base, id: asked, author_kind: "person", author_id: owner.id, author_name: owner.name, body: "Move Delivery pipeline v2 to start on Dec 1, 2026.", at, kind: "request", reply_to: null },
      { ...base, id: crypto.randomUUID(), author_kind: "oracle", author_id: null, author_name: "Oracle", body: STRAY_REPLY, at, kind: "discussion_reply.v2", reply_to: asked },
    ],
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
// "Nov 20", "Dec 20, 2026": month first, as the API's chat._day_words.
const dayWords = (day: string, year = false) =>
  new Date(msOf(day)).toLocaleDateString("en-US", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

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

/** "Dec 1, 2026" (that day) or "Dec 1" (the next such day, as parseDay). */
function fullDay(text: string): string | null {
  const m = /^([a-z]+ \d{1,2}),? (\d{4})$/i.exec(text.trim());
  if (!m) return parseDay(text);
  const d = parseDay(m[1]);
  return d ? `${m[2]}${d.slice(4)}` : null;
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
type Reply = { kind: StoredMessage["kind"]; body: string; cards: Draft[]; source?: string | null; links?: { label: string; href: string }[]; understood?: boolean; missing?: boolean; hits?: Item[]; choices?: { label: string; draft: Draft | null }[] };

/** An ambiguous item's question gains one choice per item (its card) and "Neither". */
function withChoices(r: Reply, build: (i: Item) => Reply): Reply {
  if (!r.hits?.length) return r;
  return { ...r, choices: [...r.hits.map((h) => ({ label: h.title, draft: build(h).cards[0] ?? null })), { label: "Neither", draft: null }] };
}

/** The item X names: one, or Oracle's question. */
function findItem(items: Item[], text: string): Item | Reply {
  const x = unquote(text).toLowerCase();
  const exact = items.filter((i) => i.title.toLowerCase() === x);
  if (exact.length === 1) return exact[0];
  const hits = items.filter((i) => i.title.toLowerCase().includes(x));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { kind: "question", body: `Which one: ${or(hits.slice(0, 5).map((i) => i.title))}?`, cards: [], hits: hits.slice(0, 5) };
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
    // walkc-meeting r2 (5g, chat.HERE_PLAIN): a card with no Preview is not asked to be previewed.
    body: preview ? "Here is the change. Preview it, then apply or discard it." : "Here is the change. Apply or discard it.",
    cards: [{ op, target, before, after, summary, item_id: item?.id ?? null, item_title: item?.title ?? null, preview, flow, fixes: [] }],
  });
  const stored = (i: Item) => {
    const s = seenDates(i);
    return { start_date: s.start, end_date: s.end };
  };
  const move = (i: Item, start: string, end: string) =>
    card(`Move ${i.title} to ${dayWords(start)} – ${dayWords(end, true)}`, "move_dates", i, { item_id: i.id }, stored(i), { start_date: start, end_date: end }, { kind: "dates", item_id: i.id, start_date: start, end_date: end, current: currentDates(i) });
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
        if (!isItem(i)) return withChoices(i, (h) => (period ? move(h, period[0], dated(h) ? addDays(period[0], length(h)) : period[1]) : move(h, day!, addDays(day!, dated(h) ? length(h) : 29))));
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
    const [, title, said, saidWho, by] = m;
    // walkc-meeting (chat._task_item): an item's own name may hold " for ": the longest known name wins.
    let x: string = said;
    let who: string | undefined = saidWho;
    if (saidWho) {
      const parts = `${said} for ${saidWho}`.split(" for ");
      const titles = new Set(items.map((i) => i.title.toLowerCase()));
      for (let k = parts.length; k > 0; k--) {
        if (titles.has(parts.slice(0, k).join(" for ").toLowerCase())) {
          x = parts.slice(0, k).join(" for ");
          who = parts.slice(k).join(" for ") || undefined;
          break;
        }
      }
    }
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


type Person = { id: string; name: string };

/** The company's person a name means (their full or first name), or null. */
function personNamed(ctx: ChatCtx, x: string): Person | null {
  const n = unquote(x).toLowerCase();
  const all = Object.entries(ctx.names);
  const hit = all.find(([, v]) => v.toLowerCase() === n) ?? all.find(([, v]) => v.toLowerCase().split(" ")[0] === n);
  return hit ? { id: hit[0], name: hit[1] } : null;
}

const words = (x: string) => x.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();

const actionDraft = (summary: string, op: string, item: Item | null, target: Values, before: Values, after: Values, preview: Preview): Draft => ({
  op, target, before, after, summary, item_id: item?.id ?? null, item_title: item?.title ?? null, preview, flow: null, fixes: [],
});

/** chat-actions' cards, for its phrases and Oracle's reader alike: a new owner or decider. */
function whoDraft(db: SimpleDb, ctx: ChatCtx, who: Person, i: Item, word: "owner" | "decider"): Draft {
  if (word === "owner") {
    const before = itemOwnerId(db, i.key);
    return actionDraft(`Make ${who.name} the owner of ${i.title}`, "set_owner", i, { item_id: i.id }, { owner_id: before }, { owner_id: who.id }, {
      kind: "owner", item_id: i.id, person_id: who.id, person_name: who.name, before_name: before ? (ctx.names[before] ?? i.owner?.name ?? null) : null,
    });
  }
  const before = itemDeciderId(db, i.key, ctx.roles);
  return actionDraft(`Make ${who.name} the decider of ${i.title}`, "set_decider", i, { item_id: i.id }, { decider_id: before }, { decider_id: who.id }, {
    kind: "decider", item_id: i.id, person_id: who.id, person_name: who.name, before_name: before ? (ctx.names[before] ?? null) : null,
  });
}

function noteDraft(meeting: Meeting, kind: "note" | "question", text: string): Draft {
  const t = words(text);
  return kind === "note"
    ? actionDraft(`Add to the minutes: ${t}`, "minutes_note", null, { meeting_id: meeting.id }, {}, { text: t }, { kind: "note", text: t })
    : actionDraft(`Add the open question: ${t}`, "open_question", null, { meeting_id: meeting.id }, {}, { text: t }, { kind: "question", text: t });
}

function agendaDraft(meeting: Meeting, i: Item, move: "next" | "skip"): Draft {
  return actionDraft(move === "next" ? `Take ${i.title} next` : `Skip ${i.title}`, `agenda_${move}`, i, { meeting_id: meeting.id, item_id: i.id }, {}, { move }, { kind: "agenda", item_id: i.id, move, item_title: i.title });
}

function decisionDraft(meeting: Meeting | null, documentId: string | null, who: Person, text: string, proposedTo: string | null = null, named: Person | null = null): Draft {
  const t = words(text);
  const target: Values = meeting ? { meeting_id: meeting.id } : documentId ? { document_id: documentId } : {};
  // A commenter's proposal goes to the page's decider, never a person they name (as chat_actions: the card says so).
  const notTo = proposedTo && named && named.name !== proposedTo ? { not_to: named.name } : {};
  const preview = proposedTo
    ? { kind: "decision" as const, text: t, decider_name: proposedTo, where: "page" as const, proposed_to: proposedTo, ...notTo }
    : { kind: "decision" as const, text: t, decider_name: who.name, where: meeting ? ("meeting" as const) : ("page" as const) };
  return actionDraft(`Record the decision: ${t}`, "record_decision", null, target, {}, { text: t, decider_id: proposedTo ? null : who.id }, preview);
}
/** A suggestion's name: the words' first clause, capitalised, at most 60 characters (never cut mid-word). */
function suggestionTitle(text: string): string {
  let t = text.split(/[.,;]| so | to /i)[0].trim();
  if (t.length > 60) t = t.slice(0, 61).replace(/\s+\S*$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "Suggest a feature for <goal>: <words>" (chat_actions.suggest_feature): the card, Oracle's restating and the look-alikes. */
function suggestDraft(db: SimpleDb, goalWords: string, what: string): Reply {
  const w = goalWords.trim().toLowerCase();
  const goal = Object.keys(GOALS).find((k) => k === w || GOALS[k].toLowerCase() === w);
  if (!goal) return { kind: "question", body: `Which goal: ${Object.values(GOALS).join(", ")}?`, cards: [] };
  const outcome = what.trim().replace(/\s+/g, " ");
  const title = suggestionTitle(outcome);
  const looks = lookalikes(db, title, null)
    .map((k) => db.items.find((x) => x.key === k)!)
    // As chat_actions.build_suggest_feature: the display code (none: the name alone) and what the item does (its outcome).
    .map((x) => ({ code: prdCode(x.section) ?? "", title: x.title, why: x.outcome ? `which already ${x.outcome.charAt(0).toLowerCase()}${x.outcome.slice(1).replace(/\.$/, "")}` : "which has a similar name" }));
  const said = looks.map((l, n) => ` ${n ? "It also looks like" : "It looks like"} ${`${l.code} ${l.title}`.trim()}, ${l.why}.`).join("");
  const draft = actionDraft(`Suggest ${title} for ${GOALS[goal]}`, "suggest_feature", null, { goal_id: goalId(goal) }, {}, { title, outcome }, {
    kind: "suggestion", goal_id: goalId(goal), goal_title: GOALS[goal], title, outcome, looks_like: looks,
  });
  return { kind: "cards", body: `${ONE_CHANGE} suggest ${title} for ${GOALS[goal]}.${said}`, cards: [draft] };
}

/** Chat actions' cards: "I understood one change:" (the contract's reply line). */
const ONE_CHANGE = "I understood one change:";
/** The meeting-only phrases' answer outside a meeting (no card). */
export const MEETING_ONLY = "Minutes notes, open questions and agenda changes belong to a meeting.";
/** Ops applied here, not through the change engine: a decision, the minutes' notes and the agenda. */
const LOCAL_OPS = new Set(["record_decision", "minutes_note", "open_question", "agenda_next", "agenda_skip", "suggest_feature"]);

/**
 * The chat actions' phrases (the contract's): "<person> owns <item>", "<person> decides
 * <item>", "decision[ by <person>]: <text>", and in a meeting only "note: <text>", "open
 * question: <text>", "next: <item>" and "skip <item>". Null: none of them.
 */
function chatAction(db: SimpleDb, ctx: ChatCtx, t: string, meeting: Meeting | null, items: Item[], documentId: string | null, change: (build: () => Reply) => Reply): Reply | null {
  // A phrase claims its line only when its item and person resolve (as the API's parse()):
  // an unknown one is `understood: false`, for the Ask panel's one box to send to Oracle's Ask.
  const r = chatActionReply(db, ctx, t, meeting, items, documentId, change);
  return r && r.missing ? { ...r, understood: false } : r;
}

function chatActionReply(db: SimpleDb, ctx: ChatCtx, t: string, meeting: Meeting | null, items: Item[], documentId: string | null, change: (build: () => Reply) => Reply): Reply | null {
  // "skip …", "<person> owns …" and "<person> decides …" leave a question ("…?") to the reader.
  const asks = t.trim().endsWith("?");
  const one = (d: Draft): Reply => ({ kind: "cards", body: ONE_CHANGE, cards: [d] });
  const person = (x: string): Person | Reply =>
    personNamed(ctx, x) ?? { kind: "question", body: `Who is “${unquote(x)}”? Name a person of the company.`, cards: [], missing: true };
  const isPerson = (x: Person | Reply): x is Person => "id" in x;
  let m: RegExpExecArray | null;

  if ((m = /^(note|open question):\s*(.+)$/i.exec(t)) || (m = /^(next):\s*(.+)$/i.exec(t)) || (!asks && (m = /^(skip)\s+(.+)$/i.exec(t)))) {
    const [, verb, rest] = m;
    if (!meeting) {
      // Outside a meeting, the note for a known item only ("skip the intro" is not one).
      const i = /^(next|skip)$/i.test(verb) ? findItem(items, rest) : null;
      return i && !isItem(i) ? i : { kind: "note", body: MEETING_ONLY, cards: [] };
    }
    return change(() => {
      const v = verb.toLowerCase();
      if (v === "note" || v === "open question") return one(noteDraft(meeting, v === "note" ? "note" : "question", rest));
      const i = findItem(items, rest);
      if (!isItem(i)) return i;
      return one(agendaDraft(meeting, i, v === "next" ? "next" : "skip"));
    });
  }
  if ((m = /^decision(?: by (.+?))?:\s*(.+)$/i.exec(t))) {
    const [, by, what] = m;
    return change(() => {
      const who = by ? person(by) : { id: ctx.id, name: ctx.names[ctx.id] ?? "someone" };
      if (!isPerson(who)) return who;
      return one(decisionDraft(meeting, documentId, who, what, askProposal(ctx, meeting, documentId), by ? who : null));
    });
  }
  if ((m = /^suggest a feature for (.+?):\s*(.+)$/i.exec(t))) {
    const [, g, what] = m;
    return change(() => suggestDraft(db, g, what));
  }
  if (!asks && (m = /^(.+?) (owns|decides) (.+)$/i.exec(t)) && !/^who$/i.test(m[1])) {
    const [, x, verb, y] = m;
    return change(() => {
      const who = person(x);
      if (!isPerson(who)) return who;
      const i = findItem(items, y);
      if (!isItem(i)) return i;
      return one(whoDraft(db, ctx, who, i, verb.toLowerCase() === "owns" ? "owner" : "decider"));
    });
  }
  return null;
}

/*
 * Oracle's reader (chat-reader), as a deterministic stand-in: a line the fixed parser above
 * does not know becomes a "pending" line ("Reading that…"), and the thread's next GET reads
 * it with keyword rules over the mock's invented items (no model). Each change is one op of
 * `mockReaderOps` (later steps add ops); a line with two changes gets two cards, an item
 * that names several gets "Which item?" with clickable choices (the last "Neither"), a line
 * with no change a plain refusal, a question (in the Ask panel's one box) kind "ask" for
 * Oracle's Ask, and a line with "flaky" in it fails its first read (Retry reads it again).
 */

/** The invented items the reader's rules talk about (the "simple-chat" scenario adds them). */
export function seedReaderItems(db: SimpleDb): void {
  const add: SimpleDb["items"] = [
    { key: "delivery-integrity", title: "Delivery integrity and release safety", horizon: "now", roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", start: 45, end: 85, source: "typed" },
    { key: "delivery-pipeline", title: "Delivery pipeline v2", horizon: "next", roadmap: "alerts-roadmap", track: "alerts", confidence: "medium", start: 10, end: 60, source: "typed" },
  ];
  for (const s of add) {
    if (db.items.some((x) => x.key === s.key)) continue;
    db.items.push(s);
    db.ids[s.key] = stableUuid(`simple-item/${s.key}`);
  }
}

/**
 * meet-chat-right-prd: the "meet-chat-right-prd" scenario's meeting reviews Guided setup, whose
 * new draft's features are only on its draft roadmap (Setup checklist first); Usage alerts, an
 * approved PRD, keeps its own items (Delivery pipeline v2) on its roadmap.
 */
export function seedRightPrd(db: SimpleDb, chat: ChatDb): void {
  const add: SimpleDb["items"] = [
    { key: "setup-checklist", title: "Setup checklist", horizon: "now", roadmap: "onboarding-roadmap", track: "onboarding", confidence: "medium", start: 5, end: 35, source: "typed", draft_roadmap: true },
    { key: "setup-reminders", title: "Setup reminders", horizon: "next", roadmap: "onboarding-roadmap", track: "onboarding", confidence: "medium", start: 20, end: 50, source: "typed", draft_roadmap: true },
  ];
  for (const s of add) {
    if (db.items.some((x) => x.key === s.key)) continue;
    db.items.push(s);
    db.ids[s.key] = stableUuid(`simple-item/${s.key}`);
  }
  const m = chat.meetings[CHAT_MEETING_ID];
  if (m) Object.assign(m, { title: "Guided setup review", prd: "guided-setup" });
}

function plusMonths(day: string, n: number): string {
  const d = new Date(msOf(day));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  return isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), last)));
}

function moveDraft(db: SimpleDb, i: Item, start: string, end: string, shift?: [number, number]): Draft {
  const s = seenDates(i);
  return {
    op: "move_dates", target: { item_id: i.id }, before: { start_date: s.start, end_date: s.end }, after: { start_date: start, end_date: end },
    summary: `Move ${i.title} to ${dayWords(start)} – ${dayWords(end, true)}`, item_id: i.id, item_title: i.title,
    // A move by a span carries it (as the API's chat._b_move): offered again on newer dates, it moves from those.
    preview: { kind: "dates", item_id: i.id, start_date: start, end_date: end, ...(shift ? { shift } : {}), current: currentDates(i) }, flow: null, fixes: [],
  };
}

/** A move by a span offered again: that span from the item's current dates, in its after, preview and words (the API's chat.rebase). */
function rebaseShift(c: StoredCard, current: Record<string, unknown>) {
  const p = c.preview;
  const [from, to] = [current.start_date, current.end_date];
  if (c.op !== "move_dates" || p?.kind !== "dates" || !p.shift || typeof from !== "string" || typeof to !== "string") return;
  const shift = p.shift;
  const [a, b] = [addDays(plusMonths(from, shift[0]), shift[1]), addDays(plusMonths(to, shift[0]), shift[1])];
  const [oa, ob] = [String(c.after.start_date), String(c.after.end_date)];
  c.after = { start_date: a, end_date: b };
  c.preview = { ...p, start_date: a, end_date: b };
  c.summary = c.summary.replace(`${dayWords(oa)} – ${dayWords(ob, true)}`, `${dayWords(a)} – ${dayWords(b, true)}`).replace(usSpan(oa, ob), usSpan(a, b));
  if (c.change_words) c.change_words = { ...c.change_words, after: usSpan(a, b) };
  if (c.correct) c.correct = { ...c.correct, values: { start_date: a, end_date: b } };
}

/**
 * ask-oracle-actions: the API's action catalogue (ask_actions), as cards: "add the assumption X"
 * is create_entity, a new record its Undo deletes; "add the gap X" is create_knowledge_gap, which
 * has no DELETE, so its card says before Apply that it cannot be undone. Apply all leaves them
 * (each is applied on its own).
 */
const API_OP = "api_action";
const API_CANNOT_UNDO = "This cannot be undone.";
const API_ADD = /^(?:please\s+)?add\s+(?:the\s+|an?\s+)?(?:new\s+)?(assumption|gap)\s+(.+?)\.?$/i;
/** ask_actions.SECRET_VALUE: a pasted key or token is never kept in a card (the API refuses it). */
const API_SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|bearer\s+\S{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=]*\d)(?=[A-Za-z0-9_+/=]*[A-Za-z])[A-Za-z0-9_+/=]{32,})/i;
export const API_SECRET_REFUSAL = "I can't do that from the chat: a value that looks like a secret is never kept in the chat.";

function apiDraft(kind: string, text: string): Draft {
  const title = words(text);
  if (kind.toLowerCase() === "assumption") {
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const body = { type: "assumption", key, title };
    // The key the mock makes up for the record is not shown on the card (no code-like values on cards).
    return actionDraft(`Add a product record: type “assumption”, title “${title}”.`, API_OP, null, { action: "create_entity", args: { body }, names: [] }, {}, { undo: "delete" }, null);
  }
  return actionDraft(`Add a gap: title “${title}”. ${API_CANNOT_UNDO}`, API_OP, null, { action: "create_knowledge_gap", args: { body: { title } }, names: [] }, {}, { undo: null }, null);
}

/**
 * ask-oracle-actions: "ask <person> to decide <title>" is create_decision (POST /v1/decisions,
 * "Request a decision"): its card names, by name, the person the route pings by Slack, and has
 * no Undo. A person the company does not have: no card (ask_actions' unknown record).
 */
const API_DECIDE = /^(?:please\s+)?ask\s+(.+?)\s+to\s+decide\s+(?:on\s+)?(.+?)\.?$/i;
export const API_NO_RECORD = "I can't tell which record that changes, so I made no card.";

function decisionRequest(ctx: ChatCtx, who: string, text: string): ReaderOut {
  const title = words(text);
  if (API_SECRET.test(title)) return { refusal: API_SECRET_REFUSAL };
  const p = personNamed(ctx, who);
  if (!p || !title) return { refusal: API_NO_RECORD };
  const body = { title, approver_id: p.id };
  // ask_actions._ping_words: truly whether Slack sends it.
  const reach = ctx.slackReach?.(p.id) ?? "none";
  const ping =
    reach === "on" ? `${p.name} gets a Slack message asking for a decision and sees it in their Inbox.`
    : reach === "off" ? `${p.name} sees it in their Inbox; they turned these Slack messages off.`
    : `${p.name} sees it in their Inbox; Slack is not connected.`;
  return {
    card: actionDraft(
      `Request a decision: title “${title}”, approver “${p.name}”. ${ping} ${API_CANNOT_UNDO}`,
      API_OP, null, { action: "create_decision", args: { body }, names: [], ids: { [p.id]: p.name }, pinged: [p.id] }, {}, { undo: null }, null,
    ),
  };
}

/** ask-oracle-actions: "it should not depend on X (. remove that dependency relationship)", "X depends on Y" (chat_actions' remove_dependency / add_dependency). */
const DEP_REMOVE = /^(.+?)\s+(?:should\s*n[o']t|must\s*n[o']t|does\s*n[o']t\s+need\s+to|no\s+longer(?:\s+needs\s+to)?)\s+depends?\s+on\s+(.+?)(?:[.,;]?\s+(?:so\s+|please\s+)?remove\s+(?:that|the|this)\s+dependency(?:\s+relationship)?)?$/i;
const DEP_REMOVE_OF = /^remove\s+(?:the\s+)?dependency\s+(?:of|from)\s+(.+?)\s+on\s+(.+)$/i;
const DEP_ADD = /^(?:make\s+)?(.+?)\s+(?:should\s+|must\s+)?depends?\s+on\s+(.+)$/i;
const label = (i: Item) => (i.code ? `${i.code} ${i.title}` : i.title);

/** The dependency in words: which of the patterns the line is, its two items' words. Null: none. */
function dependencyWords(t: string): { remove: boolean; x: string; on: string } | null {
  const m = DEP_REMOVE.exec(t) ?? DEP_REMOVE_OF.exec(t);
  if (m) return { remove: true, x: m[1], on: m[2] };
  const a = DEP_ADD.exec(t);
  return a ? { remove: false, x: a[1], on: a[2] } : null;
}

/** set_depends_on's card (chat_actions._depends_build): the item's depends_on keys without, or with, the other item's. */
function dependencyDraft(db: SimpleDb, i: Item, dep: Item, remove: boolean): ReaderOut {
  const own = db.items.find((x) => db.ids[x.key] === i.id);
  const other = db.items.find((x) => db.ids[x.key] === dep.id);
  if (!own || !other) return { refusal: "Which item?" };
  if (own.key === other.key) return { refusal: `${i.title} cannot depend on itself.` };
  const now_ = [...(own.depends ?? [])];
  if (remove && !now_.includes(other.key)) return { refusal: `${i.title} does not depend on ${label(dep)}.` };
  if (!remove && now_.includes(other.key)) return { refusal: `${i.title} depends on ${label(dep)} already.` };
  if (!remove && own.roadmap !== other.roadmap) return { refusal: `${label(dep)} is on another roadmap: a dependency joins items of one roadmap.` };
  const after = remove ? now_.filter((k) => k !== other.key) : [...now_, other.key];
  const summary = remove ? `Remove dependency: ${i.title} no longer depends on ${label(dep)}` : `Add dependency: ${i.title} depends on ${label(dep)}`;
  return { card: actionDraft(summary, "set_depends_on", i, { item_id: i.id, dependency_id: dep.id, dependency: label(dep) }, { depends_on: now_ }, { depends_on: after }, null) };
}

/** A builder's args: `item` is null for an op about no item (a decision, a minutes note). */
export type ReaderArgs = { db: SimpleDb; ctx: ChatCtx; item: Item | null; months?: number; period?: [string, string]; rest?: string; meeting: Meeting | null; documentId: string | null };
export type ReaderOut = { card: Draft } | { refusal: string };

/** The reader's ops: op -> builder (its args) -> a card or a refusal. An op not here is skipped. */
export const mockReaderOps: Record<string, (a: ReaderArgs) => ReaderOut> = {
  move_dates: ({ db, item, months: n, period }) => {
    if (!item) return { refusal: "Which item?" };
    if (period) {
      const len = Math.round((msOf(item.end.date) - msOf(item.start.date)) / DAY);
      return { card: moveDraft(db, item, period[0], dated(item) ? addDays(period[0], len) : period[1]) };
    }
    return { card: moveDraft(db, item, plusMonths(item.start.date, n ?? 3), plusMonths(item.end.date, n ?? 3), [n ?? 3, 0]) };
  },
  cut: ({ item }) =>
    !item
      ? { refusal: "Which item?" }
      : item.status === "cut"
      ? { refusal: `${item.title} is cut already.` }
      : { card: { op: "cut", target: { item_id: item.id }, before: { cut: false }, after: { cut: true }, summary: `Cut ${item.title}`, item_id: item.id, item_title: item.title, preview: { kind: "cut", item_id: item.id }, flow: null, fixes: [] } },
  // roadmap-talk: start after another item ends, and a new item in a milestone under a goal.
  move_after: ({ db, ctx, item, rest }) => {
    if (!item) return { refusal: "Which item?" };
    const [other] = named(itemsFor(db, ctx), rest ?? "");
    if (!other) return { refusal: `I could not find “${unquote(rest ?? "")}” on the roadmap.` };
    const len = Math.round((msOf(item.end.date) - msOf(item.start.date)) / DAY);
    const start = addDays(other.end.date, 1);
    return { card: talkMove(db, item, start, addDays(start, len), `after ${other.title}`) };
  },
  add_item: ({ db, ctx, rest }) => {
    const [title, m, goal] = (rest ?? "").split("|");
    return addItemDraft(db, ctx, title, m, goal);
  },
  // chat-join: chat-actions' ops, built by the same drafts as its phrases.
  set_owner: (a) => who(a, "owner"),
  set_decider: (a) => who(a, "decider"),
  api_add: ({ rest }) => {
    const [kind, text] = (rest ?? "").split("|");
    return API_SECRET.test(text) ? { refusal: API_SECRET_REFUSAL } : { card: apiDraft(kind, text) };
  },
  api_decide: ({ ctx, rest }) => {
    const [who, text] = (rest ?? "").split("|");
    return decisionRequest(ctx, who, text ?? "");
  },
  remove_dependency: (a) => dependsOn(a, true),
  add_dependency: (a) => dependsOn(a, false),
  record_decision: ({ ctx, meeting, documentId, rest }) => {
    if (!rest) return { refusal: "What was decided?" };
    return { card: decisionDraft(meeting, documentId, { id: ctx.id, name: ctx.names[ctx.id] ?? "someone" }, rest, askProposal(ctx, meeting, documentId)) };
  },
  minutes_note: ({ meeting, rest }) => (!meeting ? { refusal: MEETING_ONLY } : !rest ? { refusal: "What should the minutes say?" } : { card: noteDraft(meeting, "note", rest) }),
  open_question: ({ meeting, rest }) => (!meeting ? { refusal: MEETING_ONLY } : !rest ? { refusal: "What should the minutes say?" } : { card: noteDraft(meeting, "question", rest) }),
  agenda_next: ({ meeting, item }) => (!meeting ? { refusal: MEETING_ONLY } : !item ? { refusal: "Which item?" } : { card: agendaDraft(meeting, item, "next") }),
  agenda_skip: ({ meeting, item }) => (!meeting ? { refusal: MEETING_ONLY } : !item ? { refusal: "Which item?" } : { card: agendaDraft(meeting, item, "skip") }),
};

/** remove_dependency / add_dependency: the item `rest` names, on the same roadmap's items. */
function dependsOn({ db, ctx, item, rest }: ReaderArgs, remove: boolean): ReaderOut {
  if (!item) return { refusal: "Which item?" };
  const [dep] = named(itemsFor(db, ctx), rest ?? "");
  return dep ? dependencyDraft(db, item, dep, remove) : { refusal: `I could not find “${unquote(rest ?? "")}” on the roadmap.` };
}

/** set_owner / set_decider: the person `rest` names (a person the company does not have: a refusal). */
function who({ db, ctx, item, rest }: ReaderArgs, word: "owner" | "decider"): ReaderOut {
  if (!item) return { refusal: "Which item?" };
  const p = personNamed(ctx, rest ?? "");
  return p ? { card: whoDraft(db, ctx, p, item, word) } : { refusal: `Who is “${unquote(rest ?? "")}”? Name a person of the company.` };
}

/** The ops about no item: their clause carries only its words (`rest`). */
const ITEMLESS = new Set(["record_decision", "minutes_note", "open_question", "add_item", "api_add", "api_decide"]);

type Clause = { op: string; x: string; months?: number; period?: [string, string]; rest?: string };

/**
 * The line's changes, one clause per verb ("… and cut …"; an item's own "and" stays), each
 * line or ";" its own part; qa-simple-decide-24: a part it cannot read goes to `skipped`.
 */
function clauses(text: string, skipped: string[] = []): Clause[] {
  const out: Clause[] = [];
  const lines = text.split(/\n|;/).map((l) => l.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "")).filter(Boolean);
  for (const part of lines.flatMap((t) => t.split(/,?\s+and\s+(?:then\s+)?(?=(?:push|move|shift|slip|cut|drop|make|let'?s|skip|note|we decided|add)\b)/i))) {
    const had = out.length;
    let m: RegExpExecArray | null;
    // roadmap-talk: "push X after Y" (start the day after Y ends), "add a(n) X item to M2 under Growth".
    if ((m = /^(?:push|move|shift|slip)\s+(.+?)\s+(?:to\s+start\s+)?after\s+(.+)$/i.exec(part))) {
      out.push({ op: "move_after", x: m[1], rest: m[2] });
      continue;
    }
    if ((m = /^add\s+(?:an?\s+)?(.+?)\s+item\s+to\s+(M\d)\b(?:\s+under\s+(.+))?$/i.exec(part))) {
      out.push({ op: "add_item", x: "", rest: [m[1], m[2], m[3] ?? ""].join("|") });
      continue;
    }
    // ask-oracle-actions: an action of the API ("add the assumption X").
    if ((m = API_ADD.exec(part))) {
      out.push({ op: "api_add", x: "", rest: `${m[1]}|${m[2]}` });
      continue;
    }
    // ask-oracle-actions: a decision requested of a person ("ask Priya to decide X").
    if ((m = API_DECIDE.exec(part))) {
      out.push({ op: "api_decide", x: "", rest: `${m[1]}|${m[2]}` });
      continue;
    }
    // ask-oracle-actions: a dependency removed or added ("X should not depend on Y").
    const dw = dependencyWords(part);
    if (dw) {
      out.push({ op: dw.remove ? "remove_dependency" : "add_dependency", x: dw.x, rest: dw.on });
      continue;
    }
    // chat-join: chat-actions' ops in free words.
    if ((m = /^(?:ok(?:ay)?,?\s+)?(?:so\s+)?we(?:'ve| have)?\s+decided\s+(?:to\s+|that\s+)?(.+)$/i.exec(part))) {
      out.push({ op: "record_decision", x: "", rest: m[1] });
      continue;
    }
    if ((m = /^(?:please\s+)?(?:note|write down)\s+(?:that\s+)?(.+)$/i.exec(part))) {
      out.push({ op: "minutes_note", x: "", rest: m[1] });
      continue;
    }
    if ((m = /^we\s+(?:still\s+)?need to find out\s+(?:whether\s+|if\s+)?(.+)$/i.exec(part))) {
      out.push({ op: "open_question", x: "", rest: m[1] });
      continue;
    }
    if ((m = /\b(?:let'?s\s+)?(?:do|take|discuss|cover)\s+(.+?)\s+next$/i.exec(part))) {
      out.push({ op: "agenda_next", x: m[1] });
      continue;
    }
    if ((m = /^(?:let'?s\s+)?skip\s+(.+)$/i.exec(part))) {
      out.push({ op: "agenda_skip", x: m[1] });
      continue;
    }
    if ((m = /\bmake\s+(.+?)\s+(?:the\s+)?(?:decider (?:of|for)|decide)\s+(.+)$/i.exec(part))) {
      out.push({ op: "set_decider", x: m[2], rest: m[1] });
      continue;
    }
    if ((m = /\b(?:push|move|shift|slip)\s+(.+?)\s+(?:out\s+)?(?:by\s+)?(?:a|one)\s+quarter$/i.exec(part))) out.push({ op: "move_dates", x: m[1], months: 3 });
    else if ((m = /\b(?:push|move|shift|slip)\s+(.+?)\s+(?:out\s+)?(?:to|into)\s+(.+)$/i.exec(part)) && parsePeriod(m[2])) out.push({ op: "move_dates", x: m[1], period: parsePeriod(m[2])! });
    // meet-chat-right-prd: "move X to start on Dec 1, 2026" (a day, its year optional): it starts that day.
    else if ((m = /\b(?:push|move|shift|slip)\s+(.+?)\s+to\s+(?:start\s+(?:on\s+)?)?([a-z]+ \d{1,2}(?:,? \d{4})?)$/i.exec(part)) && fullDay(m[2])) {
      const d = fullDay(m[2])!;
      out.push({ op: "move_dates", x: m[1], period: [d, addDays(d, 29)] });
    }
    else if ((m = /\b(?:cut|drop)\s+(.+)$/i.exec(part))) out.push({ op: "cut", x: m[1] });
    else if ((m = /\bmake\s+(.+?)\s+(?:the\s+owner\s+of|own)\s+(.+)$/i.exec(part))) out.push({ op: "set_owner", x: m[2], rest: m[1] });
    if (out.length === had) skipped.push(part);
  }
  return out;
}

/** ask-length-limit: the most a chat message holds (the API's ChatIn). */
const CHAT_TEXT_MAX = 4000;

/** Tests set this localStorage key to a number to make the server's chat limit stricter than the browser's. */
export const MOCK_CHAT_TEXT_MAX_KEY = "po-mock-chat-text-max";
const chatTextMax = () => Number(localStorage.getItem(MOCK_CHAT_TEXT_MAX_KEY)) || CHAT_TEXT_MAX;

/** ask-length-limit: ChatIn's 422 for an empty or too long text, shaped as FastAPI's. */
const textRefused = (text: string) => ({
  detail: [
    text
      ? { type: "string_too_long", loc: ["body", "text"], msg: `String should have at most ${chatTextMax()} characters`, input: text, ctx: { max_length: chatTextMax() } }
      : { type: "string_too_short", loc: ["body", "text"], msg: "String should have at least 1 character", input: text, ctx: { min_length: 1 } },
  ],
});

/** ask-length-limit: parts no chat change does yet, said as such with where they are changed (as chat.NOT_YET). */
const NOT_YET: [RegExp, string, string, string][] = [
  [/\bgate\b/i, "I can't change an item that is off the gate but still in Now from a chat yet", "Roadmap", "/simple/roadmap"],
  [/\bcapacity\b|\bheadcount\b|\bengineer[- ]weeks?\b/i, "I can't change capacity from a chat yet", "Priorities", "/simple/priorities"],
  [/\bdates?\b|\bdeadlines?\b/i, "I can't change dates from a chat yet", "Roadmap", "/simple/roadmap"],
];

/** qa-simple-decide-24: every part of a line the reader could not read, said back (as chat._unread): capacity, dates
 * and the gate are not yet supported, with where to change them (into `links`, once each). */
function unread(skipped: string[], links: { label: string; href: string }[] = []): string[] {
  return skipped.map((raw) => {
    const p = raw.split(/\s+/).filter(Boolean).join(" ").slice(0, 120);
    const hit = NOT_YET.find(([re]) => re.test(p));
    if (!hit) return `I did not understand: “${p}”.`;
    if (!links.some((l) => l.href === hit[3])) links.push({ label: hit[2], href: hit[3] });
    return `${hit[1]} (“${p}”); change it on ${hit[2]}.`;
  });
}

const QUESTION = /^(why|how|what|who|when|where|which|should|is|are|does|do)\b/i;
const SAY_AGAIN = "I could not tell what to change. Say it another way.";
/** qa-simple-decide-3: a question in a meeting's chat is kept for the minutes' open questions; Ask Oracle answers it. */
const MEETING_ASK = "Kept as a question for the minutes. For an answer now, use Ask Oracle.";

/** The items a phrase names (exact first, then every title that holds it). */
function named(items: Item[], x: string): Item[] {
  const q = unquote(x).toLowerCase().replace(/^the /, "");
  const exact = items.filter((i) => i.title.toLowerCase() === q);
  return exact.length ? exact : items.filter((i) => i.title.toLowerCase().includes(q));
}

/** The reader's reply to one line (deterministic). */
function readLine(db: SimpleDb, ctx: ChatCtx, r: NonNullable<StoredMessage["reading"]>, items: Item[], meeting: Meeting | null): Reply {
  const skipped: string[] = [];
  const cs = clauses(r.text, skipped);
  // "What should we cut first?" is a question, whatever verbs it holds.
  if (!cs.length || QUESTION.test(r.text.trim())) {
    if (QUESTION.test(r.text.trim()) || r.text.trim().endsWith("?"))
      return r.ask ? { kind: "ask", body: "Asking Oracle…", cards: [] } : { kind: "note", body: r.meeting_id && r.text.trim().endsWith("?") ? MEETING_ASK : SAY_AGAIN, cards: [] };
    return { kind: "note", body: SAY_AGAIN, cards: [] };
  }
  if (r.meeting_id && r.role === "viewer") return { kind: "note", body: "Viewers ask questions here; ask the presenter to make a change.", cards: [] };
  const drafts: Draft[] = [];
  const refusals: string[] = [];
  let last: Item | null = null;
  const documentId = r.document_id ?? null;
  for (const c of cs.slice(0, 5)) {
    const build = mockReaderOps[c.op];
    let item: Item | null;
    if (ITEMLESS.has(c.op)) item = null;
    else if (/^(it|that)$/i.test(c.x.trim()) && last) item = last;
    else {
      const hits = named(items, c.x);
      if (!hits.length) return { kind: "note", body: `I could not find “${unquote(c.x)}” on the roadmap. Say it another way.`, cards: [] };
      if (hits.length > 1) {
        if (cs.length > 1 || !build) return { kind: "note", body: `“${unquote(c.x)}” names more than one item. Say one change at a time.`, cards: [] };
        const choices = hits.slice(0, 5).map((h) => {
          const o = build({ db, ctx, item: h, months: c.months, period: c.period, rest: c.rest, meeting, documentId });
          return { label: h.title, draft: "card" in o ? o.card : null };
        });
        return { kind: "question", body: "Which item?", cards: [], choices: [...choices, { label: "Neither", draft: null }] };
      }
      item = hits[0];
    }
    last = item ?? last;
    if (!build) continue;
    const o = build({ db, ctx, item, months: c.months, period: c.period, rest: c.rest, meeting, documentId });
    if ("card" in o) drafts.push(o.card);
    else refusals.push(o.refusal);
  }
  const links: { label: string; href: string }[] = [];
  const said = unread(skipped, links);
  if (cs.length > 5) said.push(unused(db, ctx, cs.slice(5), items, last, meeting, documentId));
  if (!drafts.length && refusals.length === 1 && refusals[0] === API_NO_RECORD && !said.length) return { kind: "note", body: API_NO_RECORD, cards: [], links };
  if (!drafts.length) return { kind: "note", body: [refusals.length ? `I can't do that here: ${refusals.join(" ")}` : SAY_AGAIN, ...said].join(" "), cards: [], links };
  const n = drafts.length;
  // The valid cards stay; the line says which ones it cannot do and what it did not read.
  const cant = refusals.length ? [`${["One", "Two", "Three"][refusals.length - 1] ?? refusals.length} I can't do: ${refusals.join(" ")}`] : [];
  return { kind: "cards", body: [...cant, ...said, `I understood ${n === 1 ? "one change" : n === 2 ? "two changes" : `${n} changes`}:`].join(" "), cards: drafts, links };
}

/** ask-length-limit: the changes past the fifth, each named, for the person to say again (as chat._unused). */
function unused(db: SimpleDb, ctx: ChatCtx, cs: Clause[], items: Item[], last: Item | null, meeting: Meeting | null, documentId: string | null): string {
  const names: string[] = [];
  for (const c of cs) {
    const build = mockReaderOps[c.op];
    const hits = ITEMLESS.has(c.op) ? [] : /^(it|that)$/i.test(c.x.trim()) && last ? [last] : named(items, c.x);
    if (!build || (!ITEMLESS.has(c.op) && hits.length !== 1)) continue;
    const o = build({ db, ctx, item: hits[0] ?? null, months: c.months, period: c.period, rest: c.rest, meeting, documentId });
    if ("card" in o && o.card.summary) names.push(`“${o.card.summary}”`);
  }
  return names.length ? `I did not use these changes yet; say them again: ${names.join("; ")}.` : "I read the first five changes; say the rest again.";
}

let readerWrote = false;

/** Whether the last call's read wrote (a meeting chat's poll then saves, unlike other polls); clears it. */
export function takeReaderWrote(): boolean {
  const was = readerWrote;
  readerWrote = false;
  return was;
}

/** The thread's pending lines, read now (the reader's job ends on the thread's next read). */
function resolvePending(db: SimpleDb, chat: ChatDb, key: string, ctx: ChatCtx, s8?: ChatMeetings): void {
  const t = chat.threads[key];
  if (!t) return;
  for (const msg of t.messages) {
    if (msg.kind !== "pending" || !msg.reading) continue;
    readerWrote = true;
    const r = msg.reading;
    r.attempts += 1;
    // A line saying "slowly" stays pending for 25 reads (longer than the Ask chat's first wait).
    if (/\bslowly\b/i.test(r.text) && r.attempts < 25) continue;
    if (/\bflaky\b/i.test(r.text) && r.attempts === 1) {
      Object.assign(msg, { kind: "failed", body: "I couldn't read that just now.", retry: true });
      continue;
    }
    const meeting = r.meeting_id ? (chat.meetings[r.meeting_id] ?? null) : null;
    const reply = redoReading(chat, key, msg.id, r.text) ?? readLine(db, { ...ctx, role: r.role }, r, itemsFor(db, ctx, meeting), meeting);
    Object.assign(msg, {
      kind: reply.kind, body: reply.body, retry: false, at: now(), links: reply.links ?? [],
      card_ids: storeCards(db, chat, reply.cards, msg.id, key, meeting),
      choices: (reply.choices ?? []).map((c, index) => ({ index, label: c.label })),
      choice_drafts: (reply.choices ?? []).map((c) => c.draft),
    });
    // As chat._keep_question: a kept question is the meeting's open question at once (Notes so far, then the minutes).
    if (meeting && !meeting.ended && reply.body === MEETING_ASK) {
      const by = t.messages.find((x) => x.id === msg.reply_to)?.author_name ?? "someone";
      const n: MeetingNote = { id: `note-${msg.id}`, kind: "question", text: r.text.trim().slice(0, 1000), by_name: by, at: now(), card_id: null };
      if (meeting.s8 && s8) s8.note(meeting.id, n);
      else (meeting.notes ??= []).push(n);
    }
    delete msg.reading;
  }
}

// --------------------------------------------------------------------------- roadmap-talk

/** An item's own talk: the Ask thread of page /simple/roadmap/items/<id> (one per item and person). */
const TALK_KEY = /:\/simple\/roadmap\/items\/([^/]+)$/;

/** "Nov 30" (the talk's day words, as the roadmap's). */
// roadmap-talk: the API's company-day words ("30 Nov – 11 Dec").
const usDay = (day: string) => dayWords(day);
const usSpan = (a: string, b: string) => `${usDay(a)} – ${usDay(b)}`;

/** The "roadmap-talk" scenario's milestones: name and days from this quarter's start. */
export const TALK_MILESTONES: { name: string; day: number }[] = [
  { name: "M1 Launch prep", day: 57 },
  { name: "M2 Scale volume", day: 78 },
  { name: "M3 Wider rollout", day: 90 },
];

function milestoneDays(): { name: string; date: string; from: string }[] {
  const q = simpleWindows(isoDay(mockNowMs())).now[0];
  return TALK_MILESTONES.map((m, n) => ({ name: m.name, date: addDays(q, m.day), from: n ? addDays(q, TALK_MILESTONES[n - 1].day + 1) : q }));
}

/** The milestone a name means ("M2", "m2 scale volume"), or null. */
function milestoneNamed(x: string) {
  const q = x.trim().toLowerCase();
  if (!q) return null;
  return milestoneDays().find((m) => m.name.toLowerCase() === q || m.name.toLowerCase().startsWith(`${q} `)) ?? null;
}

/** The goal a name means (its key or title, "Growth"), or null. */
function goalNamed(x: string): string | null {
  const q = x.trim().toLowerCase();
  return Object.keys(GOALS).find((k) => k === q || GOALS[k].toLowerCase() === q) ?? null;
}

// fix4 qa-simple-roadmap-3: the talk names an item by its title alone, no code (api roadmap_talk.label).
const about = (i: Item) => i.title;

/**
 * The "roadmap-talk" scenario's invented items (on "simple-chat"): F-16 Adaptive pacing ending
 * on M1 Launch prep, F-17 Sign-up work and F-18 Reliability work, and the goals Reliability,
 * Growth, Activation and Revenue.
 */
export function seedTalkItems(db: SimpleDb): void {
  const add: SimpleDb["items"] = [
    { key: "adaptive-pacing", title: "Adaptive pacing", horizon: "now", roadmap: "alerts-roadmap", goal: "growth", track: "alerts", confidence: "medium", start: 46, end: 57, source: "typed", milestone: { name: "M1 Launch prep", day: 57 }, section: "f-16", heading: "F-16 Adaptive pacing", outcome: "Alerts slow down when a team is flooded", why: "Teams muted alerts during bursts." },
    { key: "signup-work", title: "Sign-up work", horizon: "now", roadmap: "onboarding-roadmap", goal: "activation", track: "onboarding", confidence: "high", start: 20, end: 40, source: "typed", section: "f-17", heading: "F-17 Sign-up work" },
    { key: "reliability-work", title: "Reliability work", horizon: "now", roadmap: "alerts-roadmap", goal: "reliability", track: "alerts", confidence: "medium", start: 30, end: 50, source: "typed", section: "f-18", heading: "F-18 Reliability work" },
  ];
  for (const s of add) {
    if (db.items.some((x) => x.key === s.key)) continue;
    db.items.push(s);
    db.ids[s.key] = stableUuid(`simple-item/${s.key}`);
  }
  knowTalkGoals(db);
}

/** A move restated ("Move F-16 Adaptive pacing two weeks later, to Nov 30 – Dec 11, 2026"), its words and Correct. */
function talkMove(db: SimpleDb, i: Item, start: string, end: string, how = "", shift?: [number, number]): Draft {
  const d = moveDraft(db, i, start, end, shift);
  return {
    ...d,
    summary: `Move ${about(i)}${how ? ` ${how},` : ""} to ${usSpan(start, end)}`,
    change_words: { before: usSpan(i.start.date, i.end.date), after: usSpan(start, end) },
    correct: { fields: ["start_date", "end_date"], values: { start_date: start, end_date: end } },
  };
}

/** An add_item card: the title, its goal, milestone and dates: the API's rule, the milestone's last two weeks, never before today. */
function addItemDraft(db: SimpleDb, ctx: ChatCtx, rawTitle: string, m: string, g: string): ReaderOut {
  const title = unquote(rawTitle).replace(/^./, (c) => c.toUpperCase());
  if (!title) return { refusal: "What should the new item be called?" };
  const ms = milestoneNamed(m);
  if (!ms) return { refusal: `I could not find the milestone “${m}”.` };
  const goal = g ? goalNamed(g) : null;
  if (g && !goal) return { refusal: `I could not find the goal “${g}”.` };
  const end = ms.date;
  const start = addDays(end, -13) > today() ? addDays(end, -13) : today();
  return { card: buildAdd(title, goal, ms.name, start, end) };
}

function buildAdd(title: string, goal: string | null, milestone: string | null, start: string, end: string): Draft {
  return {
    op: "add_item", target: { where: { kind: goal ? "goal" : "horizon", value: goal ?? "now" } }, before: {},
    after: { title, start_date: start, end_date: end, milestone, goal },
    summary: `Add ${title}${goal ? ` under ${GOALS[goal]}` : ""}${milestone ? ` to ${milestone}` : ""}, ${usSpan(start, end)}`,
    item_id: null, item_title: null, preview: null, flow: null, fixes: [],
    change_words: null,
    correct: { fields: ["title", "goal", "milestone", "start_date", "end_date"], values: { title, goal: goal ? GOALS[goal] : null, milestone, start_date: start, end_date: end } },
  };
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const countOf = (x: string) => NUMBERS[x.toLowerCase()] ?? Number(x);

/** item-chat-understands (shipped.SAID / HINT / WHERE / IMPROVE): a line saying the item already exists, one that may mean it, where it runs, "will keep improving it". */
const SHIPPED_SAID = /\b(?:already (?:happening|shipped|live|out|built|done|running|in use|available|exists?|there|have (?:it|this)|ha(?:s|ve) (?:it|this))|(?:is|it's|its|has been|was) (?:shipped|live|launched|released)|(?:has|have|we) shipped|(?:partly|partially) (?:done|shipped|built|live))\b/i;
const SHIPPED_HINT = /\b(?:already|shipped|live|launched|released|exists?|in use|using|used|been out|for a while|for months|for years|we have (?:it|this)|built)\b/i;
const SHIPPED_WHERE = /\b(?:in|on|inside|within|as part of) ((?:our|the|their|its|my|your) [^.,;!?]+?)(?=[.,;!?]|$| and | but | so )/i;
/** shipped.NOT_SAID: a line that asks or says the opposite ("this isn't already live") is no mark. */
const SHIPPED_NOT = /\?\s*$|\b(?:not|never|\w+n['’]t|isnt|arent|hasnt|havent)\b/i;
const SHIPPED_IMPROVE = /\b(?:keep|continue|will|going to)\b[^.]*?\b(?:improv|iterat|polish|work on|grow)/i;

/** The "Mark as already shipped" card (shipped.build): its evidence note says where it runs, in the person's words. */
function shippedDraft(i: Item, said: string): Draft {
  const where = SHIPPED_WHERE.exec(said)?.[1]?.trim();
  const note = (where ? `Runs in ${where}` : `Said in its talk: “${said.slice(0, 200)}”`).slice(0, 200);
  return {
    op: "mark_shipped", target: { item_id: i.id }, before: { shipped: null }, after: { shipped: { note, on: today() } },
    summary: `Mark as already shipped: ${i.title}`, item_id: i.id, item_title: i.title, preview: null, flow: null, fixes: [], change_words: { before: "Planned work", after: `Already shipped · ${note}` }, correct: null,
  };
}

/** A line with no change read in an item's talk (shipped.choices): a short question with choices drawn from it, "Neither" last. */
function talkChoices(i: Item, said: string, shipped: boolean, owner: boolean): Reply {
  const choices: { label: string; draft: Draft | null }[] = [];
  // As the API: only an owner applies it, so no one else is offered it; the item's own mark, not a Done its tracker gives it.
  if (owner && SHIPPED_HINT.test(said) && !SHIPPED_NOT.test(said) && !shipped && i.status !== "cut") choices.push({ label: "Mark it as already shipped?", draft: shippedDraft(i, said) });
  const title = said.slice(0, 120).replace(/\.$/, "");
  choices.push({
    label: "Add this as a task?",
    draft: { op: "add_item_task", target: { item_id: i.id }, before: {}, after: { title, owner_name: null, due_date: null }, summary: `Add the task “${title}” to ${i.title}`, item_id: i.id, item_title: i.title, preview: null, flow: null, fixes: [] },
  });
  if (choices.length < 2) {
    choices.push({
      label: "Add it as a feature ask?",
      draft: { op: "add_feature_ask", target: {}, before: {}, after: { title, requester_name: null, requester_kind: "unknown" }, summary: `New feature ask: ${title}`, item_id: null, item_title: null, preview: null, flow: null, fixes: [] },
    });
  }
  return { kind: "question", body: "What should I do with that?", cards: [], choices: [...choices, { label: "Neither", draft: null }] };
}

/** Oracle in an item's own talk: "it" and "this" mean the item (deterministic, the demo's sentences). */
function itemTalk(db: SimpleDb, ctx: ChatCtx, items: Item[], itemId: string, text: string): Reply {
  const i = items.find((x) => x.id === itemId);
  if (!i) return { kind: "note", body: "I can't find this item on the roadmap any more.", cards: [] };
  const t = text.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  const it = "(?:it|this|this item)";
  if (QUESTION.test(t) || t.endsWith("?")) {
    // As the API: its own read of when / who is the roadmap's; the reader's answers cite the PRD when the item has one.
    const source = i.code && !/\b(when|who)\b/i.test(t) ? `From the PRD · ${about(i)}` : `From the roadmap · ${about(i)}`;
    if (/\bwho\b.*\bown/i.test(t)) return { kind: "answer", body: i.owner ? `${i.owner.name} owns ${i.title}.` : `${i.title} has no owner yet.`, cards: [], source };
    const why = i.reasons[0] ? ` ${i.reasons[0]}` : "";
    const outcome = i.outcome ? ` Its outcome: ${i.outcome}.` : "";
    return { kind: "answer", body: `${i.title} runs ${usSpan(i.start.date, i.end.date)}; it is ${i.status.replace("_", " ")}.${outcome}${why}`, cards: [], source };
  }
  if (ctx.role === "viewer") return { kind: "note", body: "Viewers ask questions here; changes need a commenter or above.", cards: [] };
  const one = (d: Draft): Reply => ({ kind: "cards", body: `I understood: ${d.summary.replace(/^./, (c) => c.toLowerCase())}.`, cards: [d] });
  let m: RegExpExecArray | null;
  const seed = db.items.find((x) => db.ids[x.key] === i.id);
  if (SHIPPED_SAID.test(t) && !SHIPPED_NOT.test(t)) {
    // item-chat-understands (shipped.build): "this already exists" marks it shipped; "will keep improving it" leaves a smaller item.
    if (i.status === "cut") return { kind: "note", body: `${i.title} is cut already.`, cards: [] };
    if (seed?.shipped) return { kind: "note", body: `${i.title} is marked as shipped already.`, cards: [] };
    const ship = shippedDraft(i, t);
    if (!SHIPPED_IMPROVE.test(t)) return one(ship);
    const title = `Improve ${i.title}`;
    const keep: Draft = {
      op: "add_item", target: { where: { kind: "horizon", value: "next" } }, before: {}, after: { title, outcome: null, start_date: null, end_date: null, milestone: null },
      summary: `Keep improving it: add ${title} to Next`, item_id: null, item_title: null, preview: null, flow: null, fixes: [],
      change_words: null, correct: { fields: ["title", "goal", "milestone", "start_date", "end_date"], values: { title, goal: null, milestone: null, start_date: null, end_date: null } },
    };
    const note = String((ship.after.shipped as { note: string }).note);
    return { kind: "cards", body: `I understood: ${i.title} already runs. ${note}.`, cards: [ship, keep] };
  }
  if ((m = new RegExp(`^(?:move|push|shift|slip) ${it}(?: by)? (a|an|one|two|three|four|five|six|\\d+) (day|week|month|quarter)s? (later|earlier|out|back|sooner)$`, "i").exec(t))) {
    // As the API's roadmap_talk._move_kw: a shift of (months, days), as chat.parse_shift.
    const count = countOf(m[1]);
    const unit = m[2].toLowerCase();
    const sign = /later|out/i.test(m[3]) ? 1 : -1;
    const shift: [number, number] = [sign * (unit === "quarter" ? 3 * count : unit === "month" ? count : 0), sign * (unit === "week" ? 7 * count : unit === "day" ? count : 0)];
    const moved = (day: string) => addDays(plusMonths(day, shift[0]), shift[1]);
    const words = `${/^an?$/i.test(m[1]) ? "one" : m[1].toLowerCase()} ${unit}${count === 1 ? "" : "s"} ${sign > 0 ? "later" : "earlier"}`;
    return one(talkMove(db, i, moved(i.start.date), moved(i.end.date), words, shift));
  }
  if ((m = new RegExp(`^(?:move|put) ${it} (?:in|into|to|under) (M\\d)\\b.*$`, "i").exec(t))) {
    const ms = milestoneNamed(m[1]);
    if (!ms) return { kind: "note", body: `I could not find the milestone “${m[1]}”.`, cards: [] };
    return one({
      op: "set_milestone", target: { item_id: i.id }, before: { milestone: i.milestone ? { name: i.milestone.name, date: i.milestone.date } : null }, after: { milestone: { name: ms.name, date: ms.date, date_source: "typed" } },
      summary: `Move ${about(i)} to ${ms.name} (${usDay(ms.date)})`, item_id: i.id, item_title: i.title, preview: { kind: "milestone", item_id: i.id, name: ms.name, date: ms.date }, flow: null, fixes: [],
      change_words: { before: i.milestone?.name ?? "No milestone", after: ms.name },
      correct: { fields: ["milestone"], values: { milestone: ms.name } },
    });
  }
  if ((m = new RegExp(`^rename ${it} (?:to )?(.+)$`, "i").exec(t))) {
    const title = unquote(m[1]);
    return one({
      op: "edit_title", target: { item_id: i.id }, before: { title: i.title }, after: { title }, summary: `Rename ${about(i)} to “${title}”`, item_id: i.id, item_title: i.title,
      preview: { kind: "title", item_id: i.id, title }, flow: null, fixes: [], change_words: { before: i.title, after: title }, correct: { fields: ["title"], values: { title } },
    });
  }
  if ((m = new RegExp(`^(?:make (.+?) (?:the )?owner(?: of ${it})?|(.+?) (?:should )?owns? ${it}|give ${it} to (.+))$`, "i").exec(t))) {
    const p = personNamed(ctx, m[1] ?? m[2] ?? m[3] ?? "");
    if (!p) return { kind: "note", body: `Who is “${unquote(m[1] ?? m[2] ?? m[3] ?? "")}”? Name a person of the company.`, cards: [] };
    const d = whoDraft(db, ctx, p, i, "owner");
    return one({ ...d, summary: `Make ${p.name} the owner of ${about(i)}`, change_words: { before: i.owner?.name ?? "No owner", after: p.name }, correct: { fields: ["owner"], values: { owner: p.name } } });
  }
  if (new RegExp(`^(?:cut|drop) ${it}$`, "i").test(t)) {
    if (i.status === "cut") return { kind: "note", body: `${i.title} is cut already.`, cards: [] };
    return one({ op: "cut", target: { item_id: i.id }, before: { cut: false }, after: { cut: true }, summary: `Cut ${about(i)}`, item_id: i.id, item_title: i.title, preview: { kind: "cut", item_id: i.id }, flow: null, fixes: [], change_words: null, correct: { fields: [], values: {} } });
  }
  if ((m = new RegExp(`^split ${it} (?:into|in) (two|three|four|\\d) (?:slices|parts|pieces)$`, "i").exec(t))) {
    const n = Math.min(4, Math.max(2, countOf(m[1])));
    const len = Math.round((msOf(i.end.date) - msOf(i.start.date)) / DAY) + 1;
    const each = Math.max(1, Math.floor(len / n));
    const cards: Draft[] = [talkMove(db, i, i.start.date, addDays(i.start.date, each - 1), "to its first slice")];
    for (let k = 1; k < n; k++) {
      const a = addDays(i.start.date, each * k);
      const b = k === n - 1 ? i.end.date : addDays(a, each - 1);
      const goal = i.goal ? (goalNamed(i.goal.key) ?? null) : null;
      cards.push(buildAdd(`${i.title}: slice ${k + 1}`, goal, i.milestone?.name ?? null, a, b));
    }
    return { kind: "cards", body: `I understood: split ${about(i)} into ${n} slices.`, cards };
  }
  const api = API_ADD.exec(t);
  if (api && API_SECRET.test(api[2])) return { kind: "note", body: API_SECRET_REFUSAL, cards: [] };
  if (api) return { kind: "cards", body: ONE_CHANGE, cards: [apiDraft(api[1], api[2])] };
  const decide = API_DECIDE.exec(t);
  if (decide) {
    const o = decisionRequest(ctx, decide[1], decide[2]);
    return "card" in o ? { kind: "cards", body: ONE_CHANGE, cards: [o.card] } : { kind: "note", body: o.refusal, cards: [] };
  }
  const dw = dependencyWords(t);
  if (dw && new RegExp(`^${it}$`, "i").test(dw.x.trim())) {
    const [dep] = named(items, dw.on);
    if (!dep) return { kind: "note", body: `I could not find “${unquote(dw.on)}” on the roadmap. Say it another way.`, cards: [] };
    const o = dependencyDraft(db, i, dep, dw.remove);
    return "card" in o ? { kind: "cards", body: ONE_CHANGE, cards: [o.card] } : { kind: "note", body: o.refusal, cards: [] };
  }
  const add = /^add (?:an? )?(.+?) item(?: to (M\d))?(?: under (.+))?$/i.exec(t);
  if (add) {
    const o = addItemDraft(db, ctx, add[1], add[2] ?? i.milestone?.name ?? "M1", add[3] ?? (i.goal ? i.goal.title : ""));
    return "card" in o ? one(o.card) : { kind: "note", body: o.refusal, cards: [] };
  }
  // item-chat-understands: never "say it another way" alone; a short question with choices drawn from the line.
  return talkChoices(i, t, !!seed?.shipped, ctx.role === "owner");
}

/** Apply with `values` (Correct): the card rebuilt from the corrected values; Correct's values win. A refusal's words, else null. */
function correctCard(db: SimpleDb, ctx: ChatCtx, c: StoredCard, values: Record<string, unknown>): string | null {
  const allowed = new Set(c.correct?.fields ?? []);
  const v: Record<string, string | null> = { ...(c.correct?.values ?? {}) };
  for (const [k, x] of Object.entries(values)) if (allowed.has(k)) v[k] = x == null || x === "" ? null : String(x);
  const day = (x: string | null) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  const item = c.item_id ? itemsFor(db, ctx, null, true).find((x) => x.id === c.item_id) : undefined;
  if (c.op === "move_dates" && item) {
    const [a, b] = [day(v.start_date), day(v.end_date)];
    if (!a || !b || b < a) return "Start and End: two days, the end on or after the start";
    // Corrected dates: the restatement names the new dates only (a "two weeks later" no longer holds).
    const d = talkMove(db, item, a, b);
    Object.assign(c, { after: d.after, summary: d.summary, preview: d.preview, change_words: { before: c.change_words?.before ?? d.change_words!.before, after: d.change_words!.after }, correct: { ...c.correct!, values: { start_date: a, end_date: b } } });
    return null;
  }
  if (c.op === "set_milestone" && item) {
    const ms = milestoneNamed(v.milestone ?? "");
    if (!ms) return `Milestone: one of ${milestoneDays().map((m) => m.name).join(", ")}`;
    Object.assign(c, { after: { milestone: { name: ms.name, date: ms.date, date_source: "typed" } }, summary: `Move ${about(item)} to ${ms.name} (${usDay(ms.date)})`, preview: { kind: "milestone", item_id: item.id, name: ms.name, date: ms.date }, change_words: { before: c.change_words?.before ?? "No milestone", after: ms.name }, correct: { ...c.correct!, values: { milestone: ms.name } } });
    return null;
  }
  if (c.op === "edit_title" && item) {
    const title = (v.title ?? "").trim();
    if (!title) return "Title: write the item's name";
    Object.assign(c, { after: { title }, summary: `Rename ${about(item)} to “${title}”`, preview: { kind: "title", item_id: item.id, title }, change_words: { before: item.title, after: title }, correct: { ...c.correct!, values: { title } } });
    return null;
  }
  if (c.op === "set_owner" && item) {
    const p = personNamed(ctx, v.owner ?? "");
    if (!p) return `Owner: name a person of the company`;
    const d = whoDraft(db, ctx, p, item, "owner");
    Object.assign(c, { after: d.after, preview: d.preview, summary: `Make ${p.name} the owner of ${about(item)}`, change_words: { before: item.owner?.name ?? "No owner", after: p.name }, correct: { ...c.correct!, values: { owner: p.name } } });
    return null;
  }
  if (c.op === "add_item") {
    const title = (v.title ?? "").trim();
    if (!title) return "Title: write the new item's name";
    const goal = v.goal ? goalNamed(v.goal) : null;
    if (v.goal && !goal) return `Goal: one of ${Object.values(GOALS).join(", ")}`;
    const ms = v.milestone ? milestoneNamed(v.milestone) : null;
    if (v.milestone && !ms) return `Milestone: one of ${milestoneDays().map((m) => m.name).join(", ")}`;
    const [a, b] = [day(v.start_date), day(v.end_date)];
    if (!a || !b || b < a) return "Start and End: two days, the end on or after the start";
    const d = buildAdd(title, goal, ms?.name ?? null, a, b);
    Object.assign(c, { target: d.target, after: d.after, summary: d.summary, correct: { ...c.correct!, values: d.correct!.values } });
    return null;
  }
  return null;
}

/** After the engine applied it: what the mock's engine does not store itself (the new item's dates and milestone, a milestone moved). */
function afterApplied(db: SimpleDb, c: StoredCard, result: Schemas["SimpleChangeResult"]): void {
  const q = simpleWindows(isoDay(mockNowMs())).now[0];
  const dayOf = (date: string) => Math.round((msOf(date) - msOf(q)) / DAY);
  if (c.op === "add_item" && result.change.status === "applied") {
    const id = String(result.change.target.item_id ?? "");
    const key = Object.keys(db.ids).find((k) => db.ids[k] === id);
    const s = db.items.find((x) => x.key === key);
    if (!s || !key) return;
    const a = c.after;
    if (a.start_date && a.end_date) db.own[key] = { start: String(a.start_date), end: String(a.end_date), source: "typed" };
    s.horizon = "now";
    s.drafting_until = undefined;
    const ms = typeof a.milestone === "string" ? milestoneNamed(a.milestone) : null;
    if (ms) s.milestone = { name: ms.name, day: dayOf(ms.date) };
    c.item_id = id;
    c.item_title = s.title;
  }
  if (c.op === "set_milestone" && c.item_id && result.change.status === "applied" && c.correct) {
    const key = Object.keys(db.ids).find((k) => db.ids[k] === c.item_id);
    const s = db.items.find((x) => x.key === key);
    const m = c.after.milestone as { name: string; date: string } | undefined;
    if (s && m) s.milestone = { name: m.name, day: dayOf(m.date) };
  }
}

/** The roadmap as the reader reads it (and as an owner, for the constraint check). */
/**
 * Oracle's Ask on a Simple page reads the company's plan first (oracle.discussions.plan): a
 * question naming a roadmap item the asker may read is answered from the plan, its dates,
 * status and outcome; null when it names none (the canned reply).
 */
export function planAnswer(db: SimpleDb, ctx: ChatCtx, question: string): { text: string; citations: Record<string, unknown>[] } | null {
  const q = question.toLowerCase();
  const [i] = itemsFor(db, ctx)
    .filter((x) => q.includes(x.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length);
  if (!i) return null;
  // The shape the API's prompt asks for (oracle.discussions.plan.PLAN_FIRST): the name in bold,
  // when it runs, then short labelled lists; the plan cited.
  // "Nov 16 – Dec 11", as the pick's answer reads.
  const us = (day: string) => new Date(msOf(day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const when = `${us(i.start.date)} – ${us(i.end.date)}${i.estimated ? " (estimated)" : ""}`;
  const status = i.status.replace("_", " ");
  const sections: [string, string[]][] = [
    ["Outcome", i.outcome ? [i.outcome] : []],
    ["Goal", i.goal ? [i.goal.title] : []],
    ["Milestone", i.milestone?.name ? [`${i.milestone.name}${i.milestone.date ? `, ${us(i.milestone.date)}` : ""}`] : []],
  ];
  const text = [
    `**${i.title}** [c:1]`,
    `Runs **${when}** · ${status} (${i.horizon})`,
    ...sections.filter(([, lines]) => lines.length).map(([label, lines]) => `### ${label}\n${lines.map((l) => `- ${l}`).join("\n")}`),
  ].join("\n\n");
  const citations: Record<string, unknown>[] = [{ n: 1, kind: "roadmap_item", ref: i.id, title: `Roadmap item: ${i.title}`, url: "/simple/roadmap" }];
  if (i.prd) citations.unshift({ n: 2, kind: "section", ref: i.prd.id, title: `${i.prd.title}: Roadmap`, url: `/documents/${i.prd.slug}` });
  return { text: i.prd ? text.replace("[c:1]", "[c:1] [c:2]") : text, citations };
}

/**
 * The items a line is read against: a meeting's chat reads only its PRD's items, those on the
 * PRD's draft roadmap too (meet-chat-right-prd, as the API's chat.meeting_prd); `lookup` (a
 * card's own item) finds any of them.
 */
function itemsFor(db: SimpleDb, ctx: ChatCtx, meeting: Meeting | null = null, lookup = false): Item[] {
  const q = new URLSearchParams();
  if (meeting?.prd || lookup) q.set("draft_roadmap", "1");
  if (meeting?.prd) q.set("prd", meeting.prd);
  return roadmapOut(db, ctx.role, q, { id: ctx.id, role: ctx.role, roles: ctx.roles, owners: ctx.owners, names: ctx.names })?.items ?? [];
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
  if (replacedBy(chat, c)) return { may: null, why_not: null };
  const m = meetingOf(chat, c);
  const bar = m ? meetingBar(m, ctx) : ctx.role === "viewer" ? "Viewers read the plan; they don't change it" : null;
  if (bar) return { may: null, why_not: bar };
  // As the API (chat_actions.proposes): on Ask, approvers and owners record decisions; a commenter proposes one.
  if (!m && c.op === "record_decision" && ctx.role === "commenter") return { may: "propose", why_not: null };
  // item-chat-understands (shipped.bar): only an owner marks an item as already shipped.
  if (c.op === "mark_shipped") return ctx.role === "owner" ? { may: "apply", why_not: null } : { may: null, why_not: "Only an owner marks an item as already shipped" };
  const item = c.item_id ? itemsFor(db, ctx, null, true).find((i) => i.id === c.item_id) : undefined;
  // Filing a feature ask is every commenter's right (Requests), as are a meeting's notes, agenda
  // and decisions (the meeting's rules came first) and a decision on Ask; else the item's rule.
  const decides = c.op === "add_feature_ask" || LOCAL_OPS.has(c.op) ? true : c.item_id ? !!item?.can_decide : ctx.role === "owner";
  return { may: decides ? "apply" : "propose", why_not: null };
}

/**
 * chat-latest-card (card_order.topic): the record a card changes, its item or the record its
 * target names. A card that makes a new record (a note, a question, a decision, a suggestion, a
 * feature ask, a new item) is its own topic; the meeting, page or goal it is made in is where.
 */
const NOT_TOPIC = new Set(["note_id", "suggestion_id", "meeting_id", "dependency_id", "decider_id"]);
const NEW_OPS = new Set(["minutes_note", "open_question", "record_decision", "suggest_feature", "add_feature_ask", "add_item"]);
/** The API's path parameters of each action the mock offers (ask_actions' catalogue: its route's path). */
const API_PATHS: Record<string, string> = { create_entity: "/v1/baseline/entities", create_knowledge_gap: "/v1/gaps" };
const sortedJson = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
function cardTopic(c: StoredCard): string {
  if (c.item_id) return c.item_id;
  const t = (c.target ?? {}) as Record<string, unknown>;
  if (NEW_OPS.has(c.op)) return `new:${c.id}`;
  if (c.op === API_OP) {
    // card_order._api_topic: the record the route's path names (its last id); a create names none.
    const args = (t.args ?? {}) as Record<string, unknown>;
    const path = [...(API_PATHS[String(t.action)] ?? "").matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]);
    const ids = path.filter((p) => args[p] != null).map((p) => String(args[p]));
    return ids.length ? ids[ids.length - 1] : `${String(t.action)}:${sortedJson(args)}`;
  }
  const id = Object.entries(t).find(([k, v]) => k.endsWith("_id") && !NOT_TOPIC.has(k) && v);
  if (id) return String(id[1]);
  return `${c.op}:${sortedJson(Object.fromEntries(Object.entries(t).filter(([k]) => k !== "note_id" && k !== "suggestion_id")))}`;
}

/** card_order.topics: each card's topic, oldest first; a redo of an earlier draft (redo_of) takes that draft's topic. */
function cardTopics(cards: StoredCard[]): string[] {
  const keys: string[] = [];
  const at = new Map<string, number>();
  cards.forEach((c) => {
    const j = c.redo_of ? at.get(c.redo_of) : undefined;
    at.set(c.id, keys.length);
    keys.push(j !== undefined ? keys[j] : cardTopic(c));
  });
  return keys;
}

/** card_order.redo_line: the change a line asks for when it answers the previous card to change it ("no, note: ..."), else null. */
const REDO = /^(?:no|nope|rather|instead)\b[,:;.!]?\s+(.+)$|^(.+?),?\s+instead[.!]?$/i;
function redoLine(text: string): string | null {
  const m = REDO.exec(text.split(/\s+/).filter(Boolean).join(" "));
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * card_order.redo_of: the earlier open draft a new record's card redoes: the one the reader named (the draft's redo_of,
 * an open draft of the same op on an earlier line of this thread), else, when the line asks to change the previous card
 * (`explicit`), that reply's open draft of the same op. Else null: the card is its own topic.
 */
function redoOf(chat: ChatDb, key: string, messageId: string, d: Draft, explicit: boolean): string | null {
  if (d.item_id || !NEW_OPS.has(d.op)) return null;
  const named = d.redo_of ?? null;
  const t = chat.threads[key];
  if (!t || (!named && !explicit)) return null;
  const at = t.messages.findIndex((m) => m.id === messageId);
  const earlier = (at < 0 ? t.messages : t.messages.slice(0, at)).filter((m) => m.card_ids.length);
  const draft = (c: StoredCard | undefined): c is StoredCard => !!c && c.status === "open" && c.op === d.op && !c.item_id;
  if (named) return earlier.some((m) => m.card_ids.includes(named)) && draft(chat.cards[named]) ? named : null;
  const same = (earlier[earlier.length - 1]?.card_ids ?? []).map((id) => chat.cards[id]).filter(draft);
  return same.length ? same[same.length - 1].id : null;
}

/** The mock reader's "make it April instead" (the reader's redo_of, chat_reader.v6): the newest open draft on an earlier line, its month changed. */
const MAKE_IT = /^(?:no,?\s+)?make it (.+?) instead[.!]?$/i;
const MONTH = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
function redoReading(chat: ChatDb, key: string, messageId: string, text: string): Reply | null {
  const m = MAKE_IT.exec(text.trim());
  const t = chat.threads[key];
  if (!m || !t || !MONTH.test(m[1])) return null;
  const at = t.messages.findIndex((x) => x.id === messageId);
  const drafts = t.messages.slice(0, at < 0 ? undefined : at).flatMap((x) => x.card_ids.map((id) => chat.cards[id]))
    .filter((c) => c && c.status === "open" && !c.item_id && NEW_OPS.has(c.op));
  const last = drafts[drafts.length - 1];
  const old = last && String(last.after.text ?? last.after.title ?? "").match(MONTH)?.[0];
  if (!last || !old) return null;
  const month = m[1].trim()[0].toUpperCase() + m[1].trim().slice(1).toLowerCase();
  const draft: Record<string, unknown> = { ...last };
  for (const k of ["id", "message_id", "thread", "meeting_id", "status", "change_id", "decided_by_name", "decided_by", "decided_at", "decision_id"]) delete draft[k];
  const again = JSON.parse(JSON.stringify(draft).split(old).join(month)) as Draft;
  return { kind: "cards", body: "I understood one change:", cards: [{ ...again, redo_of: last.id }] };
}

/**
 * chat-latest-card (card_order.replaced): the card that replaced `c` in its chat, or null. Once a
 * card is acted on, every card on an earlier line is replaced; among open cards, only the newest
 * per topic acts. Cards on one line never replace one another.
 */
function replacedBy(chat: ChatDb, c: StoredCard): string | null {
  const t = chat.threads[c.thread];
  if (!t) return null;
  const all = t.messages.flatMap((m) => m.card_ids.map((id) => chat.cards[id]).filter(Boolean));
  const at = all.findIndex((x) => x.id === c.id);
  if (at < 0) return null;
  const keys = cardTopics(all);
  const later = all.map((x, i) => ({ x, k: keys[i] })).slice(at + 1).filter(({ x }) => x.message_id !== c.message_id);
  const acted = later.filter(({ x }) => x.status !== "open").map(({ x }) => x);
  const same = later.filter(({ k }) => k === keys[at]).map(({ x }) => x);
  const pick = c.status === "open" ? (same.length ? same : acted) : acted.filter((x) => same.includes(x)).length ? acted.filter((x) => same.includes(x)) : acted;
  return pick.length ? pick[pick.length - 1].id : null;
}

export const REPLACED = "This card was replaced by a newer card in the chat: use the newest one";

/** qa4-simple-decide-1 (chat._undo_bar): why the reader may not undo an applied card, by its Apply's rule. */
function undoBar(db: SimpleDb, chat: ChatDb, c: StoredCard, ctx: ChatCtx): string | null {
  const m = meetingOf(chat, c);
  const bar = m ? meetingBar(m, ctx) : ctx.role === "viewer" ? "Viewers read the plan; they don't change it" : null;
  if (!bar && c.op === API_OP && !c.after.undo) return API_CANNOT_UNDO;
  if (bar || c.op === API_OP || LOCAL_OPS.has(c.op) || c.op === "add_feature_ask" || c.op === "suggest_feature" || c.decided_by === ctx.id) return bar;
  const item = c.item_id ? itemsFor(db, ctx).find((i) => i.id === c.item_id) : undefined;
  const decides = c.item_id ? !!item?.can_decide : ctx.role === "owner";
  return decides ? null : "Only someone who may change this item undoes it";
}

function cardOut(db: SimpleDb, chat: ChatDb, c: StoredCard, ctx: ChatCtx) {
  const check = c.flag !== undefined ? { flags: c.flag ? [c.flag] : [] } : asIf(db, c);
  // walkc-meeting (chat.cards_out): an open card's fixes are checked again on each read, on
  // the working state (the meeting's applied changes), never kept from when it was made.
  if (c.status === "open" && "fixes" in check) c.fixes = check.fixes;
  const { flag: _flag, thread: _thread, meeting_id: _meeting, undo: _undo, decided_by: _by, ...rest } = c;
  void _undo;
  void _by;
  void _flag;
  void _thread;
  void _meeting;
  // fix5-cut-dependents: what "Cut it and its dependents" cuts with the item (chat.cards_out).
  const items = c.status === "open" && c.op === "cut" && c.item_id ? itemsFor(db, ctx) : [];
  const waiting = c.item_id && items.length ? cutDependents(items, c.item_id) : [];
  const may = mayOf(db, chat, c, ctx);
  // Review major (chat.cards_out): "Cut it and its dependents" applies only when the reader decides every item it cuts.
  const allMine = [c.item_id, ...waiting.map((i) => i.id)].every((id) => !!items.find((i) => i.id === id)?.can_decide);
  const may_with_dependents = waiting.length && may.may ? (allMine ? "apply" : "propose") : null;
  // walkc-meeting (chat.cards_out): who Propose asks, and who a proposed card went to.
  const m = meetingOf(chat, c);
  let asks: string[] = [];
  let here = true;
  if (may.may === "propose" && c.item_id && c.op !== "add_item") {
    const route = proposalRoute(db, ctx, c.item_id);
    ({ ids: asks, here } = m ? meetingRoute(db, m.attendee_ids, ctx, [c.item_id], route) : { ids: route, here: true });
  } else if (c.status === "proposed" && c.change_id) {
    asks = db.changes?.find((x) => x.id === c.change_id)?.routed_to ?? [];
  }
  // walkc-meeting review (chat.cards_out): who the cut with its dependents asks, by every item it cuts.
  let asksAll: string[] = [];
  let hereAll = true;
  if (may_with_dependents === "propose" && c.item_id) {
    const cut = [c.item_id, ...waiting.map((i) => i.id)];
    const route = cutRoute(db, ctx, cut);
    ({ ids: asksAll, here: hereAll } = m ? meetingRoute(db, m.attendee_ids, ctx, cut, route) : { ids: route, here: true });
  }
  // meeting-changes-only-its-agenda (chat.cards_out): an item on a roadmap the meeting does not review.
  const off = m?.roadmaps && c.item_id && c.op !== "add_item" ? itemsFor(db, ctx, null, true).find((i) => i.id === c.item_id) : undefined;
  const elsewhere = off && !m!.roadmaps!.includes(off.roadmap.id) ? `${off.title} is on another roadmap: sent to its owner to decide` : null;
  const asksOut = {
    elsewhere,
    asks: asks.map((i) => ctx.names[i] ?? "someone"),
    asks_outside: !here,
    asks_with_dependents: asksAll.map((i) => ctx.names[i] ?? "someone"),
    asks_with_dependents_outside: !hereAll,
  };
  // walkc-meeting r2 (chat.cards_out): a proposed card whose proposal was declined since reads as declined, by whom and when.
  const no = c.status === "proposed" && c.change_id ? db.changes?.find((x) => x.id === c.change_id && x.status === "declined") : undefined;
  const declined = no ? { status: "declined" as const, decided_by_name: no.decided_by ? (ctx.names[no.decided_by] ?? "someone") : null, decided_at: no.decided_at ?? null } : {};
  return { change_words: null, correct: null, ...rest, ...declined, ...may, ...asksOut, flags: check.flags, dependents: waiting.map((i) => i.title), dependent_ids: waiting.map((i) => i.id), may_with_dependents, can_undo: c.status === "applied" && !undoBar(db, chat, c, ctx), replaced_by: replacedBy(chat, c), ...(c.status === "open" && replacedBy(chat, c) ? { correct: null } : {}) };
}

function rulesOut(m: Meeting, ctx: ChatCtx) {
  const ref = (id: string) => ({ id, name: ctx.names[id] ?? "someone" });
  return {
    change_mode: m.change_mode, change_people: m.change_people.map(ref), presenter: ref(m.presenter_id),
    is_presenter: ctx.id === m.presenter_id, may_apply: meetingBar(m, ctx) === null, ask_only: ctx.role === "viewer", ended: m.ended,
    ended_at: m.ended ? (m.ended_at ?? null) : null,
    ended_by: m.ended && !m.ended_by_itself && m.ended_by ? ref(m.ended_by) : null,
    ended_by_itself: m.ended && !!m.ended_by_itself,
  };
}

function threadOut(db: SimpleDb, chat: ChatDb, t: Thread | null, ctx: ChatCtx, meeting: Meeting | null) {
  return {
    understood: true,
    id: t?.id ?? null,
    meeting_id: meeting?.id ?? null,
    messages: (t?.messages ?? []).map(({ card_ids, choice_drafts: _drafts, reading: _reading, ...msg }) => {
      void _drafts;
      void _reading;
      // meet-chat-kind: as the API's thread(), a line that is not a chat kind reads as an answer.
      const kind = (KINDS.includes(msg.kind) ? msg.kind : "answer") as ChatKind;
      return { source: null, links: [], ...msg, kind, cards: card_ids.map((id) => cardOut(db, chat, chat.cards[id], ctx)) };
    }),
    rules: meeting ? rulesOut(meeting, ctx) : null,
    ask_id: t?.ask_id ?? null,
  };
}

/** The new cards of Oracle's line `messageId`. */
/** roadmap-talk: as the API, every open card on the roadmap's pages may be corrected (its fields, Oracle's reading). */
function roadmapCorrect(d: Draft): Draft {
  if (d.correct !== undefined && d.correct !== null) return d;
  const a = d.after as Record<string, unknown>;
  const b = d.before as Record<string, unknown>;
  const p = (d.preview ?? {}) as Record<string, unknown>;
  if (d.op === "move_dates" && typeof a.start_date === "string" && typeof a.end_date === "string") {
    const words = typeof b.start_date === "string" && typeof b.end_date === "string" ? { before: usSpan(b.start_date, b.end_date), after: usSpan(a.start_date, a.end_date) } : null;
    return { ...d, change_words: d.change_words ?? words, correct: { fields: ["start_date", "end_date"], values: { start_date: a.start_date, end_date: a.end_date } } };
  }
  if (d.op === "edit_title" && typeof a.title === "string") return { ...d, change_words: d.change_words ?? { before: String(b.title ?? ""), after: a.title }, correct: { fields: ["title"], values: { title: a.title } } };
  // A cut has nothing to correct; it is still a roadmap card (Reject, not Discard).
  if (d.op === "cut") return { ...d, correct: { fields: [], values: {} } };
  if (d.op === "set_owner" && typeof p.person_name === "string") return { ...d, change_words: d.change_words ?? { before: typeof p.before_name === "string" ? p.before_name : "No owner", after: p.person_name }, correct: { fields: ["owner"], values: { owner: p.person_name } } };
  return d;
}

function storeCards(db: SimpleDb, chat: ChatDb, drafts: Draft[], messageId: string, key: string, meeting: Meeting | null, redo = false): string[] {
  // As the API (roadmap_talk.on_roadmap: the thread's page starts /simple/roadmap); a new chat's key ends "#<id>".
  const onRoadmap = !meeting && /:\/simple\/roadmap(\/|#|$)/.test(key);
  return (onRoadmap ? drafts.map(roadmapCorrect) : drafts).map((d) => {
    const c: StoredCard = { ...d, id: crypto.randomUUID(), message_id: messageId, thread: key, meeting_id: meeting?.id ?? null, status: "open", change_id: null, decided_by_name: null, decided_at: null, decision_id: null, redo_of: redoOf(chat, key, messageId, d, redo) };
    c.fixes = asIf(db, c).fixes;
    chat.cards[c.id] = c;
    return c.id;
  });
}

const line = (ctx: ChatCtx, body: string, at: string): StoredMessage => ({
  id: crypto.randomUUID(), author_kind: "person", author_id: ctx.id, author_name: ctx.names[ctx.id] ?? "someone", body, at, kind: "request", card_ids: [], reply_to: null, choices: [], picked: null, retry: false,
});

/**
 * The line and Oracle's reply. A line the fixed parser does not know goes to the reader: its
 * Oracle line is "pending" until the thread's next read. `onlyUnderstood` (the Ask panel's one
 * box): a question the reader finds comes back kind "ask", for the panel to hand to Ask.
 */
function say(db: SimpleDb, chat: ChatDb, key: string, meeting: Meeting | null, ctx: ChatCtx, text: string, onlyUnderstood = false, documentId: string | null = null): boolean {
  const talk = TALK_KEY.exec(key);
  const read = (line: string) => talk ? itemTalk(db, ctx, itemsFor(db, ctx), talk[1], line) : parse(db, ctx, line, meeting, itemsFor(db, ctx, meeting), Object.values(ctx.names), documentId);
  // chat-latest-card (chat.post): a line answering the previous card to change it ("no, note: ...") is that change, a redo of its draft.
  const rest = redoLine(text);
  const again = rest !== null ? read(rest) : null;
  const redo = again?.kind === "cards";
  const reply = redo && again ? again : read(text);
  // A question about something not on the roadmap is Ask's (the one box writes nothing); a
  // change phrase naming no item is read by the reader in context, as the API does.
  const asksElsewhere = reply.understood === false && !!reply.missing;
  if (asksElsewhere && onlyUnderstood) return false;
  if (!asksElsewhere && reply.missing) reply.understood = false;
  const t = (chat.threads[key] ??= { id: crypto.randomUUID(), meeting_id: meeting?.id ?? null, owner_id: meeting ? null : ctx.id, messages: [] });
  const at = now();
  const person = line(ctx, text, at);
  t.messages.push(person);
  const id = crypto.randomUUID();
  const base = { id, author_kind: "oracle" as const, author_id: null, author_name: "Oracle", at, reply_to: person.id, picked: null, retry: false };
  if (reply.understood === false && !asksElsewhere) {
    t.messages.push({ ...base, kind: "pending", body: "Reading that…", card_ids: [], choices: [], reading: { text, role: ctx.role, meeting_id: meeting?.id ?? null, attempts: 0, ask: onlyUnderstood, document_id: documentId } });
    return true;
  }
  t.messages.push({
    ...base, body: reply.body, kind: reply.kind, source: reply.source ?? null, links: reply.links ?? [], card_ids: storeCards(db, chat, reply.cards, id, key, meeting, redo),
    choices: (reply.choices ?? []).map((c, index) => ({ index, label: c.label })), choice_drafts: (reply.choices ?? []).map((c) => c.draft),
  });
  return true;
}

/** The line `id` in a thread the caller reads: their Ask thread or a meeting they attend. */
function findMessage(chat: ChatDb, ctx: ChatCtx, id: string): { key: string; meeting: Meeting | null; msg: StoredMessage } | null {
  for (const [key, t] of Object.entries(chat.threads)) {
    const msg = t.messages.find((x) => x.id === id);
    if (!msg) continue;
    const meeting = t.meeting_id ? (chat.meetings[t.meeting_id] ?? null) : null;
    // The person's own Ask threads (one per page: "ask:<id>:<page>"), as the API.
    if (meeting ? !meeting.attendee_ids.includes(ctx.id) : key !== `ask:${ctx.id}` && !key.startsWith(`ask:${ctx.id}:`)) return null;
    return { key, meeting, msg };
  }
  return null;
}

/** One card through the change engine (or its fix n): the card out and the result, or the engine's refusal. */
async function applyOne(db: SimpleDb, chat: ChatDb, c: StoredCard, ctx: ChatCtx, n: number | null, s8?: ChatMeetings, withDependents: boolean | string[] = false): Promise<Response | { card: unknown; result: Schemas["SimpleChangeResult"] }> {
  // fix5-cut-dependents: a cut card applies as cut_with_dependents (one change), and then names every item it cut.
  const use = withDependents ? { op: CUT_ALL, target: c.target, before: withDependents === true ? c.before : { ...c.before, dependents: withDependents }, after: {} } : n == null ? c : c.fixes[n];
  if (c.op === API_OP) {
    // ask-oracle-actions: the action's route ran as the person (ask_actions.apply); no change of the engine.
    if (c.target.action === "create_decision") {
      // POST /v1/decisions as the person: a proposed decision, its approver the named person, made by them.
      const body = ((c.target.args as { body?: Schemas["DecisionCreate"] } | undefined)?.body ?? null);
      const id = body && ctx.proposeDecision ? await ctx.proposeDecision(body) : null;
      if (!id) return json(422, { detail: "The approver must be an active member with the approver role or above" });
      c.target = { ...c.target, decision_id: id };
    }
    Object.assign(c, { status: "applied", decided_by_name: ctx.names[ctx.id] ?? "someone", decided_by: ctx.id, decided_at: now() });
    return { card: cardOut(db, chat, c, ctx), result: null as unknown as Schemas["SimpleChangeResult"] };
  }
  if (c.op === "suggest_feature") {
    // Filed as the person's own suggestion (origin "person"): it lands under People.
    const goal = Object.keys(GOALS).find((k) => goalId(k) === c.target.goal_id) ?? "";
    const r = fileSuggestion(db, ctx, goal, String(c.after.title ?? ""), String(c.after.outcome ?? ""));
    if ("detail" in r) return json(r.status, { detail: r.detail });
    c.target = { ...c.target, suggestion_id: r.id };
    const result = applyLocal(c, null, ctx, s8);
    return { card: cardOut(db, chat, c, ctx), result };
  }
  if (c.op === "mark_shipped") {
    // item-chat-understands (shipped.apply): the item reads done, out of planned work; Undo puts its status back.
    const s = db.items.find((x) => db.ids[x.key] === c.item_id);
    if (!s) return json(404, { detail: "No such roadmap item" });
    if (s.shipped) return json(409, { detail: `${s.title} is marked as shipped already` });
    const was = s.status ?? null;
    s.shipped = (c.after.shipped as { note: string; on: string } | null) ?? { note: "Already shipped", on: today() };
    s.status = "done";
    const result = applyLocal(c, null, ctx, s8);
    c.undo = { status: was };
    return { card: cardOut(db, chat, c, ctx), result };
  }
  if (LOCAL_OPS.has(c.op)) {
    const meeting = meetingOf(chat, c);
    if (!meeting && c.op === "record_decision" && ctx.role === "commenter") {
      const proposed = await proposeLocal(c, ctx);
      if (proposed instanceof Response) return proposed;
      return { card: cardOut(db, chat, c, ctx), result: proposed };
    }
    const result = applyLocal(c, meeting, ctx, s8);
    return { card: cardOut(db, chat, c, ctx), result };
  }
  // The new owner or decider's name, for the roadmap's owner line.
  if (c.op === "set_owner" || c.op === "set_decider") {
    const id = String(c.after.owner_id ?? c.after.decider_id ?? "");
    if (id && ctx.names[id]) (db.people ??= {})[id] = ctx.names[id];
  }
  // meeting-changes-only-its-agenda (changes.create): in a meeting, an item on a roadmap it does
  // not review is never changed: a proposal for the item's owner, naming the meeting.
  const asked = meetingOf(chat, c);
  const off = asked?.roadmaps && c.item_id && !withDependents ? itemsFor(db, ctx, null, true).find((i) => i.id === c.item_id) : undefined;
  if (asked && off && !asked.roadmaps!.includes(off.roadmap.id)) {
    const out = proposeOffAgenda(db, ctx, { op: use.op, target: use.target, before: use.before, after: use.after } as Schemas["SimpleChangeIn"], { id: asked.id, title: asked.title }, asked.id);
    if (out instanceof Response) return out;
    Object.assign(c, { status: "proposed", change_id: out.change.id, decided_by_name: ctx.names[ctx.id] ?? "someone", decided_by: ctx.id, decided_at: now() });
    return { card: cardOut(db, chat, c, ctx), result: out };
  }
  const res = await engine(db, ctx, "POST", "/v1/simple/changes", { op: use.op, target: use.target, before: use.before, after: use.after });
  if (!res.ok) {
    // dod-data: a card refused because its item changed since stays open, offered again on the new state (as the API's chat.rebase).
    if (res.status === 409 && n == null && !withDependents) {
      const current = ((await res.clone().json()) as { detail?: { current?: Record<string, unknown> } }).detail?.current;
      if (current && Object.keys(current).length && Object.keys(current).every((k) => k in c.before)) {
        c.before = { ...c.before, ...current };
        rebaseShift(c, current);
      }
    }
    return res;
  }
  const result = (await res.json()) as Schemas["SimpleChangeResult"];
  const inMeeting = meetingOf(chat, c);
  if (inMeeting && result.change.status === "proposed") {
    // walkc-meeting (changes.create): a proposal made in a meeting goes to its deciders.
    const stored = db.changes?.find((x) => x.id === result.change.id);
    // The items it is on (changes.create: the cut's items, else its own item; none for an addition).
    const on = result.change.op === CUT_ALL ? Object.keys(result.change.after ?? {}) : typeof result.change.target.item_id === "string" ? [result.change.target.item_id] : [];
    const routed = meetingRoute(db, inMeeting.attendee_ids, ctx, on, result.change.routed_to).ids;
    if (stored) stored.routed_to = routed;
    result.change.routed_to = routed;
    markMeetingProposal(db, result.change.id);
  }
  afterApplied(db, c, result);
  if (withDependents) {
    const t = result.change.target as Record<string, unknown>;
    const said = changePhrase(CUT_ALL, t, {}, {}, ((t.titles as string[] | undefined) ?? [])[0] ?? null);
    c.summary = said.slice(0, 1).toUpperCase() + said.slice(1);
  }
  Object.assign(c, {
    status: result.change.status === "applied" ? "applied" : "proposed", change_id: result.change.id,
    decided_by_name: ctx.names[ctx.id] ?? "someone", decided_by: ctx.id, decided_at: now(),
  });
  if (n != null) Object.assign(c, { op: use.op, target: use.target, before: use.before, after: use.after });
  const meeting = meetingOf(chat, c);
  if (meeting && (c.status as StoredCard["status"]) === "applied") {
    // In an S8 review meeting the applied card is one of its meeting decisions (meeting_decisions).
    c.decision_id = meeting.s8 && s8 ? s8.decide(meeting.id, n == null ? c.summary : c.fixes[n].label, ctx.id, null) : crypto.randomUUID();
    meeting.decisions.push({ id: c.decision_id, title: n == null ? c.summary : c.fixes[n].label, card_id: c.id, at: c.decided_at! });
  }
  return { card: cardOut(db, chat, c, ctx), result };
}

/** Whether the reader sees the card: their own Ask thread's, or a meeting they attend. */
function sees(chat: ChatDb, c: StoredCard, ctx: ChatCtx): boolean {
  const m = meetingOf(chat, c);
  if (m) return m.attendee_ids.includes(ctx.id);
  return c.thread.startsWith(`ask:${ctx.id}:`) || c.thread === `walk:${ctx.id}`;
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

/**
 * GET /v1/simple/walk (chat.walk): broken links (every red flag with a fix, as Home's
 * brokenLinks counts and lists them: the card applies or proposes by the reader's rights),
 * then the next meeting's agenda decisions, then proposals waiting on the reader.
 */
async function walkOut(db: SimpleDb, chat: ChatDb, ctx: ChatCtx) {
  const items = itemsFor(db, ctx);
  const byId = new Map(items.map((i) => [i.id, i]));
  const steps: unknown[] = [];
  for (const i of ctx.role === "viewer" ? [] : items) {
    for (const f of i.flags.filter((x) => x.state === "red" && x.fixes.length > 0)) {
      const dep = f.subject ? byId.get(f.subject) : undefined;
      const sd = (it: Item) => {
        const s = seenDates(it);
        return { start_date: s.start, end_date: s.end };
      };
      const fixes: Fix[] = f.fixes.map((op) =>
        op === "accept_risk"
          ? { label: "Accept as risk", op, target: { item_id: i.id, flag: f.kind, subject: f.subject ?? null }, before: { risk: null }, after: { risk: { note: "Accepted as a risk in a walk-through" } } }
          : {
              label: op === "shift_dependents" ? "Move the dependents" : "Move the dependency", op, target: { item_id: i.id, subject: f.subject ?? null },
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
      // The problem said once (the step's why), under the item's name (chat.walk).
      steps.push({ id: `broken_link:${i.id}:${f.kind}:${f.subject ?? ""}`, kind: "broken_link", title: i.title, why: f.reason, card: cardOut(db, chat, chat.cards[id], ctx), change: null, decision: null });
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

/** The Simple page an Ask thread belongs to (oracle.simple.chat.page_of). */
export function pageOf(page: string | null | undefined): string {
  const path = `/${(page ?? "").split("?")[0].split("#")[0].split("/").filter(Boolean).join("/")}`;
  return path === "/simple" || path.startsWith("/simple/") ? path : "/simple";
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
    const n: MeetingNote = { id: `note-${c.id}`, kind: c.op === "minutes_note" ? "note" : "question", text: String(c.after.text ?? ""), by_name: by, card_id: c.id };
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
    if (c.preview && "proposed_to" in c.preview) {
      // Built while they proposed, applied once they record (as chat_actions): the card says who decided.
      const rest: Record<string, unknown> = { ...c.preview, decider_name: ctx.names[decider] ?? "you" };
      delete rest.proposed_to;
      delete rest.not_to;
      c.preview = rest as typeof c.preview;
    }
    if (remote) decision = remote.decide(meeting!.id, text, decider, null);
    else if (meeting) {
      decision = crypto.randomUUID();
      meeting.decisions.push({ id: decision, title: text, card_id: c.id, at });
    } else if (s8) undo.decision_id = s8.decide(null, text, decider, (c.target.document_id as string | undefined) ?? null);
  }
  Object.assign(c, { status: "applied", change_id: crypto.randomUUID(), decided_by_name: by, decided_by: ctx.id, decided_at: at, decision_id: decision, undo });
  const change = {
    id: c.change_id, session_id: null, document_id: null, draft_ids: [], op: c.op, target: c.target, before: c.before, after: c.after, status: "applied", by: ctx.id, by_name: by, at,
    decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: true,
  };
  return { change, flags: [] } as unknown as Schemas["SimpleChangeResult"];
}

/** A commenter's decision on Ask: an open decision (the decision log's POST, as them) for the document's decider. */
async function proposeLocal(c: StoredCard, ctx: ChatCtx): Promise<Response | Schemas["SimpleChangeResult"]> {
  const documentId = (c.target.document_id as string | undefined) ?? null;
  const to = ctx.proposeTo?.(documentId);
  if (!to || !ctx.proposeDecision) return json(409, { detail: "No one can decide this yet: ask an owner" });
  const text = String(c.after.text ?? "").slice(0, 200);
  const id = await ctx.proposeDecision({
    title: text, context: "Proposed from the Ask panel", approver_id: to.id,
    options: [{ key: "decided", label: text }, { key: "declined", label: "Decline" }] as Schemas["DecisionCreate"]["options"],
    subjects: documentId ? [{ kind: "document", id: documentId }] : [],
  } as Schemas["DecisionCreate"]);
  if (!id) return json(409, { detail: "No one can decide this yet: ask an owner" });
  const by = ctx.names[ctx.id] ?? "someone";
  const at = now();
  Object.assign(c, { status: "proposed", change_id: null, decided_by_name: by, decided_at: at, decision_id: id, preview: { ...(c.preview ?? {}), proposed_to: to.name } });
  const change = {
    id: crypto.randomUUID(), session_id: null, document_id: null, draft_ids: [], op: c.op, target: c.target, before: c.before, after: c.after, status: "proposed", by: ctx.id, by_name: by, at,
    decided_by: null, decided_at: null, reason: null, decision_reason: null, routed_to: [], undoes_id: null, undone: false, can_decide: false, can_undo: false,
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

/** S8's past review (./simple-meetings.ts's "Review: Usage alerts"). */
const PAST_MEETING_ID = stableUuid("simple-meeting/past-alerts");

/**
 * qa4-simple-decide-4: the past review's chat holds the lines said in it, as the API keeps a
 * meeting's thread after it ends: the approver's note (the meeting's note "keep quiet hours on
 * by default", 35 minutes in) and Oracle's reply.
 */
function seedPastChat(chat: ChatDb, m: Pick<Meeting, "presenter_id" | "attendee_ids">, ctx: ChatCtx): void {
  const key = `meeting:${PAST_MEETING_ID}`;
  if (chat.threads[key]) return;
  const by = m.attendee_ids.find((id) => ctx.roles[id] === "approver") ?? m.presenter_id;
  const at = new Date(mockNowMs() - 7 * DAY + 3 * 3_600_000 + 35 * 60_000).toISOString();
  const said = crypto.randomUUID();
  const base = { card_ids: [], choices: [], picked: null, retry: false };
  chat.threads[key] = {
    id: crypto.randomUUID(), meeting_id: PAST_MEETING_ID, owner_id: null,
    messages: [
      { ...base, id: said, author_kind: "person", author_id: by, author_name: ctx.names[by] ?? "someone", body: "note: keep quiet hours on by default", at, kind: "request", reply_to: null },
      { ...base, id: crypto.randomUUID(), author_kind: "oracle", author_id: null, author_name: "Oracle", body: "Added to the minutes: keep quiet hours on by default", at, kind: "note", reply_to: said },
    ],
  };
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
      if (found && id === PAST_MEETING_ID) seedPastChat(chat, found, ctx);
    }
  }

  if (p[2] === "walk" && !p[3] && m === "GET") return json(200, await walkOut(db, chat, ctx));

  // The walk: one Ask thread per person AND page (chat.page_of; Home without a page).
  if (p[2] === "chat" && !p[3] && m === "GET") {
    const q = new URL(req.url).searchParams;
    const own = q.get("chat") ? ownChat(chat, ctx, q.get("chat")) : null;
    if (q.get("chat") && !own) return json(404, { detail: "No such chat" });
    const key = own ?? `ask:${ctx.id}:${pageOf(q.get("page"))}`;
    resolvePending(db, chat, key, ctx, s8);
    return json(200, threadOut(db, chat, chat.threads[key] ?? null, ctx, null));
  }
  // chat-reader: Retry a failed line, pick a clarify question's choice, apply a line's open cards in order.
  if (p[2] === "chat" && p[3] === "messages" && p[4] && p[5] && m === "POST") {
    const found = findMessage(chat, ctx, p[4]);
    if (!found) return json(404, { detail: "No such message" });
    const { key, meeting, msg } = found;
    const out = () => threadOut(db, chat, chat.threads[key], ctx, meeting);
    if (p[5] === "retry") {
      if (msg.kind !== "failed" || !msg.retry || !msg.reading) return json(409, { detail: "Only a failed line is read again" });
      Object.assign(msg, { kind: "pending", body: "Reading that…", retry: false });
      return json(200, out());
    }
    if (p[5] === "choose") {
      const b = await body();
      const n = Number(b.index);
      if (!msg.choices.length) return json(409, { detail: "This line has no choices" });
      if (msg.picked != null) return json(409, { detail: "A choice is picked already" });
      if (!Number.isInteger(n) || !msg.choices[n]) return json(422, { detail: "index: one of the line's choices" });
      msg.picked = n;
      const t = chat.threads[key];
      const at = now();
      const person = line(ctx, msg.choices[n].label, at);
      t.messages.push(person);
      const id = crypto.randomUUID();
      const draft = msg.choice_drafts?.[n] ?? null;
      t.messages.push({
        id, author_kind: "oracle", author_id: null, author_name: "Oracle", at, reply_to: person.id, picked: null, retry: false, choices: [],
        kind: draft ? "cards" : "note", body: draft ? "I understood one change:" : "Say it another way.", card_ids: draft ? storeCards(db, chat, [draft], id, key, meeting) : [],
      });
      return json(200, out());
    }
    if (p[5] === "apply-all") {
      const applied: string[] = [];
      let stopped: { card_id: string; summary: string; reason: string } | null = null;
      // chat-latest-card: only the line's active cards; a newer card replaced the others.
      const active = msg.card_ids.map((id) => chat.cards[id]).filter((c) => c.status === "open" && c.op !== API_OP && !replacedBy(chat, c));
      if (!active.length) return json(409, { detail: "No open cards on this line" });
      for (const c of active) {
        const { may, why_not } = mayOf(db, chat, c, ctx);
        if (!may) {
          stopped = { card_id: c.id, summary: c.summary, reason: why_not ?? "You may not apply this change" };
          break;
        }
        const r = await applyOne(db, chat, c, ctx, null, s8);
        if (r instanceof Response) {
          const d = ((await r.json().catch(() => ({}))) as { detail?: unknown }).detail;
          const reason = typeof d === "string" ? d : d && typeof d === "object" && "message" in d ? String((d as { message: unknown }).message) : "The change engine refused it";
          stopped = { card_id: c.id, summary: c.summary, reason };
          break;
        }
        applied.push(c.id);
      }
      return json(200, { thread: out(), applied, stopped });
    }
    return null;
  }
  if (p[2] === "chat" && p[3] === "messages" && !p[4] && m === "POST") {
    const b = await body();
    const text = String(b.text ?? "").trim();
    if (!text || text.length > chatTextMax()) return json(422, textRefused(text));
    // ask-fresh: continue the caller's own chat `chat_id`; `new_chat` starts a new one about the page.
    const own = typeof b.chat_id === "string" ? ownChat(chat, ctx, b.chat_id) : null;
    if (typeof b.chat_id === "string" && !own) return json(404, { detail: "No such chat" });
    const page = own ? (chat.threads[own].page ?? "/simple") : pageOf(typeof b.page === "string" ? b.page : null);
    const key = own ?? `ask:${ctx.id}:${page}${b.new_chat === true ? `#${crypto.randomUUID()}` : ""}`;
    const started = !!chat.threads[key];
    const understood = say(db, chat, key, null, ctx, text, b.only_understood === true, s8?.documentOf(page) ?? null);
    // A new chat's first line handed to Ask: the chat exists (empty), for the panel to link its Ask chat.
    if (!understood && b.new_chat === true && !own) chat.threads[key] ??= { id: crypto.randomUUID(), meeting_id: null, owner_id: ctx.id, messages: [] };
    if (chat.threads[key]) Object.assign(chat.threads[key], { page, started_at: chat.threads[key].started_at ?? now() });
    // A chat started under "General" stays General.
    if (chat.threads[key] && !started && b.general === true) chat.threads[key].general = true;
    return json(200, { ...threadOut(db, chat, chat.threads[key] ?? null, ctx, null), understood });
  }
  // Recent chats (ask-fresh): the caller's last ten Ask chats from any page; never a meeting's.
  if (p[2] === "chats" && !p[3] && m === "GET") {
    const items = Object.entries(chat.threads)
      .filter(([key, t]) => key.startsWith(`ask:${ctx.id}:`) && (t.messages.length > 0 || t.ask_id))
      .map(([key, t]) => chatSummary(key, t, ctx))
      .sort((a, b) => b.last_at.localeCompare(a.last_at))
      .slice(0, 10);
    return json(200, { items });
  }
  if (p[2] === "chats" && p[3] && p[4] === "ask" && m === "PUT") {
    const own = ownChat(chat, ctx, p[3]);
    const askId = String((await body()).ask_id ?? "");
    if (!own || !askId || !(ctx.ownsDiscussion?.(askId) ?? true)) return json(404, { detail: "No such chat" });
    chat.threads[own].ask_id = askId;
    return json(200, chatSummary(own, chat.threads[own], ctx));
  }

  if (p[2] === "meetings" && p[3] && p[4] === "chat") {
    const meeting = chat.meetings[p[3]];
    if (!meeting) return json(404, { detail: "No such meeting" });
    if (!meeting.attendee_ids.includes(ctx.id)) return json(403, { detail: "Only the meeting's attendees read and write its chat" });
    // The meeting chat's own thread, as the API's ``meeting_chat:<id>`` key (meet-chat-own-key):
    // never the Ask panel's discussion on the meeting's page (./discussions.ts, ``screen:<path>``).
    const key = `meeting:${meeting.id}`;
    if (!p[5] && m === "GET") {
      resolvePending(db, chat, key, ctx, s8);
      return json(200, threadOut(db, chat, chat.threads[key] ?? null, ctx, meeting));
    }
    if (p[5] === "messages" && m === "POST") {
      const text = String((await body()).text ?? "").trim();
      if (!text || text.length > chatTextMax()) return json(422, textRefused(text));
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
      if (replacedBy(chat, c)) return json(409, { detail: REPLACED });
      // Those the change mode bars from applying may not discard either (the API's rule).
      const { may, why_not } = mayOf(db, chat, c, ctx);
      if (!may) return json(403, { detail: why_not ?? "You may not discard this card" });
      c.status = "discarded";
      return json(200, cardOut(db, chat, c, ctx));
    }
    if (p[5] === "undo" && c.op === API_OP) {
      if (c.status !== "applied") return json(409, { detail: `Only an applied card undoes; this one is ${c.status}` });
      const bar = undoBar(db, chat, c, ctx);
      if (bar) return json(409, { detail: bar });
      c.status = "undone";
      return json(200, cardOut(db, chat, c, ctx));
    }
    if (p[5] === "undo") {
      if (c.status !== "applied" || !c.change_id) return json(409, { detail: `Only an applied card undoes; this one is ${c.status}` });
      const bar = undoBar(db, chat, c, ctx);
      if (bar) return json(403, { detail: bar });
      const meeting = meetingOf(chat, c);
      if (c.op === "suggest_feature") {
        if (!unfileSuggestion(db, String(c.target.suggestion_id ?? ""))) return json(409, { detail: "The decider has decided this suggestion already" });
      } else if (c.op === "mark_shipped") {
        const s = db.items.find((x) => db.ids[x.key] === c.item_id);
        if (!s || !s.shipped) return json(409, { detail: "This item is not marked as shipped now" });
        s.shipped = null;
        s.status = (c.undo?.status as typeof s.status | null) ?? undefined;
      } else if (LOCAL_OPS.has(c.op)) {
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
      if (replacedBy(chat, c)) return json(409, { detail: REPLACED });
      if (!may) return json(403, { detail: why_not ?? "You may not apply this change" });
      const b = await body();
      const n = b.fix == null ? null : Number(b.fix);
      if (n != null && !c.fixes[n]) return json(422, { detail: "fix: one of the card's fixes" });
      const withDependents = b.with_dependents === true;
      if (withDependents && (c.op !== "cut" || n != null || b.values)) return json(422, { detail: "Only a cut card cuts its dependents too" });
      // roadmap-talk: Correct's values rebuild the card (summary, after) before it applies.
      if (n == null && b.values && typeof b.values === "object") {
        if (!c.correct) return json(422, { detail: "This change has nothing to correct" });
        const refused = correctCard(db, ctx, c, b.values as Record<string, unknown>);
        if (refused) return json(422, { detail: refused });
        // An item talk's one-card line ("I understood: …") says the corrected card, as the API.
        const said = chat.threads[c.thread]?.messages.find((x) => x.id === c.message_id);
        if (said && said.card_ids.length === 1 && said.body.startsWith("I understood: ")) said.body = `I understood: ${c.summary.replace(/^./, (x) => x.toLowerCase())}.`;
        c.fixes = asIf(db, c).fixes;
      }
      const out = await applyOne(db, chat, c, ctx, n, s8, withDependents && Array.isArray(b.dependents) ? b.dependents.map(String) : withDependents);
      return out instanceof Response ? out : json(200, out);
    }
  }
  return null;
}

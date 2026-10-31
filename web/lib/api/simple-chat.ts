/**
 * Simple S9: change by chat (meetings and the Ask panel) and "Walk me through it", typed here
 * from the API contract; the calls go through the same client (mock or real), by path, until
 * schema.d.ts carries the routes.
 */
import { api, unwrap, type Schemas } from "./client";

export type ChatPreview =
  | { kind: "dates"; item_id: string; start_date: string; end_date: string }
  | { kind: "horizon"; item_id: string; horizon: "now" | "next" | "later" }
  | { kind: "title"; item_id: string; title: string }
  | { kind: "milestone"; item_id: string; name: string; date: string }
  | { kind: "cut"; item_id: string }
  | null;

/**
 * Chat actions' previews (no roadmap ghost: the card says what changes): an item's owner or
 * decider, a decision, a minutes note or open question, and the meeting's agenda.
 */
export type ActionPreview =
  | { kind: "owner" | "decider"; item_id: string; person_id: string; person_name: string; before_name: string | null }
  | { kind: "decision"; text: string; decider_name: string; where: "meeting" | "page"; proposed_to?: string | null; not_to?: string | null }
  | { kind: "note" | "question"; text: string }
  | { kind: "agenda"; item_id: string; move: "next" | "skip"; item_title: string }
  | { kind: "suggestion"; goal_id: string; goal_title: string; title: string; outcome: string; looks_like: { code: string; title: string; why: string }[] };

/** A card's preview: a roadmap ghost (ChatPreview) or a chat action's description. */
export type CardPreview = ChatPreview | ActionPreview;

const ACTION_KINDS = new Set(["owner", "decider", "decision", "note", "question", "agenda", "suggestion"]);
export const isActionPreview = (p: CardPreview): p is ActionPreview => !!p && ACTION_KINDS.has(p.kind);

/** A meeting's live notes and open questions typed in its chat (SimpleMeetingOut.notes). */
export type MeetingNote = Schemas["SimpleMeetingNote"];
/** A meeting's agenda changes made in its chat (SimpleMeetingOut.agenda). */
export type MeetingAgenda = Schemas["SimpleAgenda"];

export type ChatFix = { label: string; op: string; target: Record<string, unknown>; before: Record<string, unknown>; after: Record<string, unknown> };

export type ChatCard = {
  id: string;
  message_id: string | null;
  op: string;
  target: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  summary: string;
  item_id: string | null;
  item_title: string | null;
  status: "open" | "applied" | "proposed" | "discarded" | "undone";
  may: "apply" | "propose" | null;
  why_not: string | null;
  flags: Schemas["SimpleItemFlags"][];
  fixes: ChatFix[];
  preview: CardPreview;
  flow: Schemas["SimpleFlow"] | null;
  change_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_id: string | null;
  /** roadmap-talk: the change in plain words ("Nov 16 – Nov 27" → "Nov 30 – Dec 11"); null when none. */
  change_words?: ChangeWords | null;
  /** roadmap-talk: the fields Correct opens, prefilled with Oracle's reading; null: no Correct. */
  correct?: CardCorrect | null;
  /** fix5-cut-dependents: an open cut's dependents (titles), what "Cut it and its dependents" cuts with it. */
  dependents?: string[];
  /** Their ids, sent back by the apply: a roadmap changed since is refused, nothing unseen is cut. */
  dependent_ids?: string[];
  /** Review major: what "Cut it and its dependents" does for the reader (apply only when they decide every item it cuts). */
  may_with_dependents?: "apply" | "propose" | null;
};

export type ChangeWords = { before: string; after: string };
/** The fields a card's Correct opens, in this order when present. */
export const CORRECT_FIELDS = ["title", "goal", "milestone", "start_date", "end_date", "owner"] as const;
export type CorrectField = (typeof CORRECT_FIELDS)[number];
export type CardCorrect = { fields: string[]; values: Record<string, string | null> };

export type ChatMessage = {
  id: string;
  author_kind: "person" | "oracle";
  author_id: string | null;
  author_name: string;
  body: string;
  at: string;
  /** chat-reader: "pending" (the reader's job runs: "Reading that…"), "failed" (Retry reads it again), "ask" (the Ask box: a question for Oracle's Ask). */
  kind: "request" | "cards" | "question" | "answer" | "note" | "pending" | "failed" | "ask";
  cards: ChatCard[];
  /** Oracle's line: the person's line it answers. */
  reply_to: string | null;
  /** A clarify question's choices (the last is "Neither"); [] otherwise. */
  choices: ChatChoice[];
  /** The choice already picked (the choices then close). */
  picked: number | null;
  /** A failed line: Retry reads it again. */
  retry: boolean;
  /** roadmap-talk: where Oracle's answer comes from ("From the PRD · F-06 Adaptive pacing"); null otherwise. */
  source?: string | null;
};

export type ChatChoice = { index: number; label: string };
export type ApplyAll = { thread: ChatThread; applied: string[]; stopped: { card_id: string; summary: string; reason: string } | null };

/** How often a thread with a pending line is read again. */
export const PENDING_POLL_MS = 1500;

/** Whether Oracle's reader is still reading a line of the thread (the thread then polls). */
export const hasPending = (t: { messages: ChatMessage[] } | null | undefined): boolean => !!t?.messages.some((m) => m.kind === "pending");

export type PersonRef = { id: string; name: string };
export type ChangeMode = "everyone" | "presenter" | "named";

export type ChatRules = {
  change_mode: ChangeMode;
  change_people: PersonRef[];
  presenter: PersonRef;
  is_presenter: boolean;
  may_apply: boolean;
  ask_only: boolean;
  ended: boolean;
  /** meet-chat-right-prd: when it ended and who ended it, or by itself once its time ran out. */
  ended_at?: string | null;
  ended_by?: PersonRef | null;
  ended_by_itself?: boolean;
};

/** `understood`: false when Oracle's plan reader did not know the last line (with only_understood, nothing was written). */
export type ChatThread = { id: string | null; meeting_id: string | null; messages: ChatMessage[]; rules: ChatRules | null; understood?: boolean; ask_id?: string | null };
/** ask-fresh: one of the person's Ask chats on Recent chats, named by its page. */
export type ChatSummary = Schemas["ChatSummaryOut"];
// chat-actions: null for the direct ops (minutes notes, agenda, decisions).
export type ChatApply = { card: ChatCard; result: Schemas["SimpleChangeResult"] | null };

export type WalkStep = {
  id: string;
  kind: "broken_link" | "agenda_decision" | "proposal";
  title: string;
  why: string;
  card: ChatCard | null;
  change: Schemas["SimpleChangeOut"] | null;
  decision: { id: string; title: string; url: string } | null;
};
export type Walk = { steps: WalkStep[] };

/** The chat actions' ops (restated as one change: "I understood one change:"). */
export const ACTION_OPS = ["set_owner", "set_decider", "record_decision", "minutes_note", "open_question", "agenda_next", "agenda_skip"] as const;
export type ActionOp = (typeof ACTION_OPS)[number];

/** Ops that add or change a flow or a feature: their cards show the flow (or "No flow yet"). */
export const FLOW_OPS = new Set(["add_feature_ask", "add_item_task"]);

type Init = { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown };
type Call = (path: string, init?: Init) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
const loose = api as unknown as { GET: Call; POST: Call; PUT: Call };

/** GET /v1/simple/chat?page=: the reader's own Ask thread on that Simple page (one per page; Home without one). */
export function askThread(page?: string, chat?: string | null): Promise<ChatThread> {
  const query = { ...(page ? { page } : {}), ...(chat ? { chat } : {}) };
  return unwrap(loose.GET("/v1/simple/chat", page || chat ? { params: { query } } : undefined)) as Promise<ChatThread>;
}

/** ask-fresh: which Ask chat a line goes to: `chatId` continues one; `newChat` starts one about the page. */
export type ChatTo = { chatId?: string | null; newChat?: boolean; general?: boolean };

/**
 * POST /v1/simple/chat/messages: the person's line and Oracle's reply. `onlyUnderstood` (the
 * Ask panel's one box): a line the plan reader does not know writes nothing and comes back
 * `understood: false`, for the panel to ask Oracle's Ask instead.
 */
export function askSay(text: string, page?: string, onlyUnderstood = false, to: ChatTo = {}): Promise<ChatThread> {
  return unwrap(
    loose.POST("/v1/simple/chat/messages", {
      body: {
        text,
        ...(page ? { page } : {}),
        ...(onlyUnderstood ? { only_understood: true } : {}),
        ...(to.chatId ? { chat_id: to.chatId } : to.newChat ? { new_chat: true, ...(to.general ? { general: true } : {}) } : {}),
      },
    }),
  ) as Promise<ChatThread>;
}

/** GET /v1/simple/chats (ask-fresh): Recent chats, the reader's last Ask chats from any page; never a meeting's. */
export async function recentChats(): Promise<ChatSummary[]> {
  return ((await unwrap(loose.GET("/v1/simple/chats"))) as { items: ChatSummary[] }).items;
}

/** PUT /v1/simple/chats/{chat_id}/ask: the Oracle's Ask chat the Ask chat handed a question to. */
export function linkAsk(chatId: string, askId: string): Promise<ChatSummary> {
  return unwrap(loose.PUT("/v1/simple/chats/{chat_id}/ask", { params: { path: { chat_id: chatId } }, body: { ask_id: askId } })) as Promise<ChatSummary>;
}

/** GET /v1/simple/meetings/{meeting_id}/chat. */
export function meetingThread(meetingId: string): Promise<ChatThread> {
  return unwrap(loose.GET("/v1/simple/meetings/{meeting_id}/chat", { params: { path: { meeting_id: meetingId } } })) as Promise<ChatThread>;
}

/** POST /v1/simple/meetings/{meeting_id}/chat/messages. */
export function meetingSay(meetingId: string, text: string): Promise<ChatThread> {
  return unwrap(loose.POST("/v1/simple/meetings/{meeting_id}/chat/messages", { params: { path: { meeting_id: meetingId } }, body: { text } })) as Promise<ChatThread>;
}

/** PUT /v1/simple/meetings/{meeting_id}/chat/mode (the presenter). */
export function setChatMode(meetingId: string, change_mode: ChangeMode, change_people: string[]): Promise<ChatRules> {
  return unwrap(
    loose.PUT("/v1/simple/meetings/{meeting_id}/chat/mode", { params: { path: { meeting_id: meetingId } }, body: { change_mode, change_people } }),
  ) as Promise<ChatRules>;
}

/** POST /v1/simple/chat/cards/{card_id}/apply: the card (or its fix n) through the change engine. */
export function applyCard(cardId: string, fix: number | null = null, values?: Record<string, string | null>, withDependents: string[] | false = false): Promise<ChatApply> {
  // fix5-cut-dependents: a cut card applies with its dependents as one change (with_dependents),
  // naming the dependents it listed.
  const body = withDependents ? { fix, with_dependents: true, dependents: withDependents } : values ? { fix, values } : { fix };
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/apply", { params: { path: { card_id: cardId } }, body })) as Promise<ChatApply>;
}

/** roadmap-talk: an item's own talk with Oracle (one thread per item and person). */
export const itemTalkPage = (itemId: string): string => `/simple/roadmap/items/${itemId}`;

/** roadmap-talk: an applied card's item flashes its bar on the timeline. */
export const APPLIED_EVENT = "simple:applied";
export type AppliedDetail = { item_id: string };

/** roadmap-talk: a chat card was applied, proposed, rejected or undone (the roadmap reads again). */
export const CARD_CHANGED_EVENT = "simple:card-changed";

export function sendCardChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CARD_CHANGED_EVENT));
}

export function sendApplied(itemId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AppliedDetail>(APPLIED_EVENT, { detail: { item_id: itemId } }));
}

/** POST /v1/simple/chat/cards/{card_id}/discard. */
export function discardCard(cardId: string): Promise<ChatCard> {
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/discard", { params: { path: { card_id: cardId } } })) as Promise<ChatCard>;
}

/** POST /v1/simple/chat/cards/{card_id}/undo. */
export function undoCard(cardId: string): Promise<ChatCard> {
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/undo", { params: { path: { card_id: cardId } } })) as Promise<ChatCard>;
}

/** POST /v1/simple/chat/messages/{message_id}/retry: a failed line is read again (pending). */
export function retryMessage(messageId: string): Promise<ChatThread> {
  return unwrap(loose.POST("/v1/simple/chat/messages/{message_id}/retry", { params: { path: { message_id: messageId } } })) as Promise<ChatThread>;
}

/** POST /v1/simple/chat/messages/{message_id}/choose: the choice's label as the person's line, and its card (or "Say it another way"). */
export function chooseChoice(messageId: string, index: number): Promise<ChatThread> {
  return unwrap(loose.POST("/v1/simple/chat/messages/{message_id}/choose", { params: { path: { message_id: messageId } }, body: { index } })) as Promise<ChatThread>;
}

/** POST /v1/simple/chat/messages/{message_id}/apply-all: the line's open cards in order, stopping at the first that cannot apply. */
export function applyAll(messageId: string): Promise<ApplyAll> {
  return unwrap(loose.POST("/v1/simple/chat/messages/{message_id}/apply-all", { params: { path: { message_id: messageId } } })) as Promise<ApplyAll>;
}

/** GET /v1/simple/walk. */
export function walk(): Promise<Walk> {
  return unwrap(loose.GET("/v1/simple/walk")) as Promise<Walk>;
}

/** The roadmap's ghost: Preview sends the card's preview, Discard / Apply / close send null. */
export const PREVIEW_EVENT = "simple:preview";
export type PreviewDetail = { card_id: string; preview: ChatPreview };

export function sendPreview(detail: PreviewDetail): void {
  if (typeof window === "undefined") return;
  (window as unknown as { __simplePreview?: PreviewDetail }).__simplePreview = detail;
  window.dispatchEvent(new CustomEvent<PreviewDetail>(PREVIEW_EVENT, { detail }));
}

export function lastPreview(): PreviewDetail | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __simplePreview?: PreviewDetail }).__simplePreview ?? null;
}

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
  preview: ChatPreview;
  flow: Schemas["SimpleFlow"] | null;
  change_id: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_id: string | null;
};

export type ChatMessage = {
  id: string;
  author_kind: "person" | "oracle";
  author_id: string | null;
  author_name: string;
  body: string;
  at: string;
  kind: "request" | "cards" | "question" | "answer" | "note";
  cards: ChatCard[];
};

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
};

/** `understood`: false when Oracle's plan reader did not know the last line (with only_understood, nothing was written). */
export type ChatThread = { id: string | null; meeting_id: string | null; messages: ChatMessage[]; rules: ChatRules | null; understood?: boolean };
export type ChatApply = { card: ChatCard; result: Schemas["SimpleChangeResult"] };

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

/** Ops that add or change a flow or a feature: their cards show the flow (or "No flow yet"). */
export const FLOW_OPS = new Set(["add_feature_ask", "add_item_task"]);

type Init = { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown };
type Call = (path: string, init?: Init) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
const loose = api as unknown as { GET: Call; POST: Call; PUT: Call };

/** GET /v1/simple/chat: the reader's own Ask thread. */
export function askThread(): Promise<ChatThread> {
  return unwrap(loose.GET("/v1/simple/chat")) as Promise<ChatThread>;
}

/**
 * POST /v1/simple/chat/messages: the person's line and Oracle's reply. `onlyUnderstood` (the
 * Ask panel's one box): a line the plan reader does not know writes nothing and comes back
 * `understood: false`, for the panel to ask Oracle's Ask instead.
 */
export function askSay(text: string, page?: string, onlyUnderstood = false): Promise<ChatThread> {
  return unwrap(
    loose.POST("/v1/simple/chat/messages", { body: { text, ...(page ? { page } : {}), ...(onlyUnderstood ? { only_understood: true } : {}) } }),
  ) as Promise<ChatThread>;
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
export function applyCard(cardId: string, fix: number | null = null): Promise<ChatApply> {
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/apply", { params: { path: { card_id: cardId } }, body: { fix } })) as Promise<ChatApply>;
}

/** POST /v1/simple/chat/cards/{card_id}/discard. */
export function discardCard(cardId: string): Promise<ChatCard> {
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/discard", { params: { path: { card_id: cardId } } })) as Promise<ChatCard>;
}

/** POST /v1/simple/chat/cards/{card_id}/undo. */
export function undoCard(cardId: string): Promise<ChatCard> {
  return unwrap(loose.POST("/v1/simple/chat/cards/{card_id}/undo", { params: { path: { card_id: cardId } } })) as Promise<ChatCard>;
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

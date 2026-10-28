"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Icon, InfoTip, Mark, SegmentedControl } from "@/components/ds";
import { takeAskDraft, useAskDraft } from "@/components/hop/open-state";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { askSay, askThread, linkAsk, recentChats, type ChatMessage, type ChatSummary, type ChatThread } from "@/lib/api/simple-chat";
import { dayIn, formatInZone, todayIn, addDays, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { openStream } from "@/lib/stream";
import { GENERAL, pageName, useCurrentScreenSubject, type ScreenSubject } from "@/lib/screen-subject";
import { errorMessage } from "@/lib/use-query";

import { ChatComposer, ChatLine, shownLines, useCorrections, usePendingPoll, type Typed } from "./ChatThread";

type AskMessage = Schemas["DiscussionMessageOut"];

/** The chat the panel shows: Oracle's plan reader's thread (`id`) and the Oracle's Ask chat it handed its questions to (`askId`). */
type Chat = { id: string | null; askId: string | null; page: string; general: boolean };

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** "Today, 7:42 PM", "Yesterday, 6:58 PM", else "Oct 26, 6:58 PM": in the company's time zone. */
export function chatWhen(iso: string, zone: string, now: number = Date.now()): string {
  const day = dayIn(iso, zone);
  const today = todayIn(zone, now);
  // The owner's words, "Today, 7:42 PM": the company's time with no zone after it.
  const time = formatInZone(iso, zone, { hour: "numeric", minute: "2-digit" }).replace(/([AP]M)\s.*$/, "$1");
  const on = day === today ? "Today" : day === addDays(today, -1) ? "Yesterday" : formatInZone(iso, zone, { month: "short", day: "numeric" });
  return `${on}, ${time}`;
}

/** Starts the person's private Oracle's Ask chat on the subject with the line; Oracle's reply streams in it. */
async function startAsk(subject: ScreenSubject, text: string): Promise<string> {
  const d = await unwrap(api.POST("/v1/discussions", { body: { subject_kind: subject.kind, subject: subject.subject, origin: "panel", visibility: "private" } }));
  await postAsk(d.id, text);
  return d.id;
}

async function postAsk(id: string, text: string): Promise<void> {
  await unwrap(api.POST("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: id } }, body: { body: text.trim(), mention_oracle: false } }));
}

async function askLines(id: string): Promise<AskMessage[]> {
  const page = await unwrap(api.GET("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: id }, query: { limit: 200 } } }));
  return page.items.filter((m) => !m.deleted && m.author_kind !== "system");
}

/**
 * Simple's Ask panel (ask-fresh, the owner's pick C "Always a clean slate", 2026-10-28):
 * every time it opens it is a new, empty chat about the page it was opened on. The header's
 * New chat clears it; Recent chats lists the person's last chats from any page, named by
 * their page and time, and reopens one to continue it (meeting chats stay in their meeting).
 * Each line goes to Oracle's plan reader first (its answers, restatements and cards with
 * their actions); a question it hands on goes to Oracle's Ask, whose answer shows in the
 * same chat. None of Detailed's discussion screen shows here.
 */
export function SimpleAskPanel({ onClose, closeLabel = "Close Ask Oracle", showHeader = true }: { onClose?: () => void; closeLabel?: string; showHeader?: boolean }) {
  const pathname = usePathname() ?? "/simple";
  const screen = useCurrentScreenSubject();
  const { can } = useMe();
  const [chat, setChat] = useState<Chat>({ id: null, askId: null, page: pathname, general: false });
  const [recent, setRecent] = useState<ChatSummary[] | null>(null);
  // Words typed in from outside (Suggest from the chat, a PRD question's Ask Oracle) bring back the chat from Recent chats.
  const asked = useAskDraft();
  const [seenAsk, setSeenAsk] = useState(asked);
  if (asked !== seenAsk) {
    setSeenAsk(asked);
    if (asked && recent !== null) setRecent(null);
  }
  // Each chat opened (new, from Recent, or switched to General) is its own view; a chat getting its id stays the same one.
  const [session, setSession] = useState(0);
  // An empty chat is about the page shown; a chat started stays about its own page.
  const fresh = !chat.id && !chat.askId;
  if (fresh && chat.page !== pathname) setChat({ ...chat, page: pathname });
  const name = chat.general ? "General" : chat.page === pathname && screen.label && !screen.label.startsWith("/") ? screen.label : pageName(chat.page);
  const startNew = () => {
    setChat({ id: null, askId: null, page: pathname, general: false });
    setSession((n) => n + 1);
    setRecent(null);
  };
  const openRecent = async () => {
    setRecent([]);
    try {
      setRecent(await recentChats());
    } catch {
      setRecent([]);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface text-text" data-testid="hop-panel">
      {showHeader && (
        <div className="flex min-h-14 flex-none items-center gap-2 border-b border-line px-4">
          <Mark size={22} tone="current" className="flex-none text-accent-ink" />
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold tracking-heading">Ask Oracle</h2>
          {onClose && (
            <button type="button" aria-label={closeLabel} onClick={onClose} className="flex size-9 items-center justify-center rounded-lg text-text hover:bg-surface2">
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-none flex-col gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="ask-new-chat" className="simple-button" onClick={startNew}>
            <Icon name="plus" size={20} />
            New chat
          </button>
          <button
            type="button"
            data-testid="ask-recent"
            aria-expanded={recent !== null}
            className="simple-button"
            onClick={() => (recent === null ? void openRecent() : setRecent(null))}
          >
            <Icon name="clock" size={20} />
            Recent chats
          </button>
        </div>
        {recent === null && (
          <>
            <p className="simple-small font-semibold text-accent-ink" data-testid="ask-about">
              {fresh ? `New chat about ${name}` : `Chat about ${name}`}
            </p>
            {fresh && (
              <SegmentedControl
                label="About"
                size="sm"
                value={chat.general ? "general" : "page"}
                onChange={(v) => {
                  setChat({ ...chat, general: v === "general" });
                  setSession((n) => n + 1);
                }}
                items={[
                  { value: "page", label: "This page" },
                  { value: "general", label: "General" },
                ]}
              />
            )}
          </>
        )}
        <p className="simple-small flex items-center gap-1 text-text" data-testid="hop-visibility">
          <Icon name="lock" size={16} />
          Just you and Oracle
          <InfoTip label="Just you and Oracle" align="start" side="bottom">
            Only you can read this chat.
          </InfoTip>
        </p>
      </div>

      {/* On a phone the sheet sits under the tab bar: room below so the box and Send are never covered. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3 max-[600px]:pb-[calc(var(--phone-tab-bar)+12px)]">
        {recent !== null ? (
          <RecentChats
            items={recent}
            onOpen={(c) => {
              setChat({ id: c.id, askId: c.ask_id ?? null, page: c.page, general: c.general });
              setSession((n) => n + 1);
              setRecent(null);
            }}
          />
        ) : (
          <ChatView
            key={session}
            chat={chat}
            name={name}
            subject={chat.general ? GENERAL : chat.page === pathname ? screen : { kind: "screen", subject: { path: chat.page }, label: name }}
            asks={can("create_discussion")}
            changes={can("create_simple_change")}
            onChat={(c) => setChat((was) => ({ ...was, ...c }))}
          />
        )}
      </div>
    </div>
  );
}

function RecentChats({ items, onOpen }: { items: ChatSummary[]; onOpen: (c: ChatSummary) => void }) {
  const zone = useCompanyZone();
  return (
    <section aria-label="Recent chats" data-testid="ask-recent-list" className="flex flex-col gap-2">
      <h3 className="simple-small font-semibold text-text2">Recent chats</h3>
      {items.length === 0 ? (
        <p className="simple-small text-text2">No chats yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="ask-recent-row"
                onClick={() => onOpen(c)}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-text hover:bg-surface2"
              >
                <Icon name="comment" size={20} />
                <span className="min-w-0 flex-1">
                  {c.page_name} · {chatWhen(c.last_at, zone)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="simple-small text-text2" data-testid="ask-recent-meetings">
        Meeting chats stay in their meeting.
      </p>
    </section>
  );
}

/** One line of the chat, in time order: the plan reader's (with its cards) or Oracle's Ask's. */
type Line = { at: string; plan?: ChatMessage; ask?: AskMessage };

function ChatView({
  chat,
  name,
  subject,
  asks,
  changes,
  onChat,
}: {
  chat: Chat;
  name: string;
  subject: ScreenSubject;
  asks: boolean;
  changes: boolean;
  onChat: (c: Partial<Chat>) => void;
}) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [ask, setAsk] = useState<AskMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The Ask lines (kind "ask") of this chat already handed to Oracle's Ask.
  const handed = useRef(new Set<string>());
  const ids = useRef({ id: chat.id, askId: chat.askId });
  useEffect(() => {
    ids.current = { id: chat.id ?? thread?.id ?? ids.current.id, askId: chat.askId ?? ids.current.askId };
  });
  const page = chat.page;

  const load = useCallback(async () => {
    const id = ids.current.id;
    if (!id) return;
    try {
      setThread(await askThread(page, id));
    } catch (e) {
      setError(detail(e));
    }
  }, [page]);
  const loadAsk = useCallback(async () => {
    const id = ids.current.askId;
    if (!id) return;
    try {
      setAsk(await askLines(id));
    } catch (e) {
      setError(detail(e));
    }
  }, []);
  // A chat reopened from Recent: its lines; a new chat has none. Lines already read as Ask's were handed then.
  useEffect(() => {
    if (!chat.id) return;
    let live = true;
    askThread(page, chat.id)
      .then((t) => {
        if (!live) return;
        for (const m of t.messages) if (m.kind === "ask") handed.current.add(m.id);
        setThread(t);
      })
      .catch((e) => live && setError(detail(e)));
    return () => {
      live = false;
    };
    // Only when the chat opens: later reads come from its lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void loadAsk();
  }, [chat.askId, loadAsk]);
  usePendingPoll(thread, load);

  /** A question for Oracle's Ask: into the chat's Ask chat (started, and linked to the chat, at the first). */
  const handOn = useCallback(
    async (text: string, chatId: string | null) => {
      const askId = ids.current.askId;
      if (askId) {
        await postAsk(askId, text);
      } else {
        const id = await startAsk(subject, text);
        ids.current.askId = id;
        if (chatId) await linkAsk(chatId, id);
        onChat({ askId: id, ...(chatId ? { id: chatId } : {}) });
      }
      await loadAsk();
    },
    [subject, onChat, loadAsk],
  );
  // chat-reader: a line the reader reads as a question for Oracle's Ask goes there, once.
  useEffect(() => {
    if (!asks || !thread) return;
    for (const m of thread.messages) {
      if (m.kind !== "ask" || handed.current.has(m.id)) continue;
      handed.current.add(m.id);
      const line = thread.messages.find((x) => x.id === m.reply_to);
      if (line) void handOn(line.body, thread.id).catch((e) => setError(detail(e)));
    }
  }, [thread, asks, handOn]);

  const send = async (text: string) => {
    setError(null);
    const id = ids.current.id;
    const t = await askSay(text, page, asks, id ? { chatId: id } : { newChat: true, general: chat.general });
    setThread(t);
    if (t.id && t.id !== id) {
      ids.current.id = t.id;
      onChat({ id: t.id });
    }
    if (t.understood === false && asks) await handOn(text, t.id);
  };

  const lines: Line[] = [
    ...shownLines(thread?.messages ?? []).map((m) => ({ at: m.at, plan: m })),
    ...ask.map((m) => ({ at: m.created_at, ask: m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lines.length]);
  // roadmap-talk: the chat's open Correct forms, for Apply all.
  const corrected = useCorrections();
  // "Suggest from the chat": the words a goal's drawer typed in, taken once by the box a person sees.
  const waiting = useAskDraft();
  const [typed, setTyped] = useState<Typed>({ text: "", n: 0 });
  const here = useRef<HTMLElement>(null);
  useEffect(() => {
    // Only the box a person sees takes them (the dock's panel is hidden on a phone): a DOM check.
    if (!waiting || !here.current?.getClientRects().length) return;
    const text = takeAskDraft();
    setTyped((t) => ({ text, n: t.n + 1 }));
  }, [waiting]);

  return (
    <section ref={here} aria-label="Ask or change the plan" data-testid="ask-chat" className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      <ol className="flex flex-col gap-3" aria-label="Messages" data-testid="ask-chat-thread">
        {lines.map((l) =>
          l.plan ? (
            <ChatLine key={l.plan.id} message={l.plan} onCardChanged={() => void load()} onThread={setThread} corrected={corrected} />
          ) : (
            <AskLine key={l.ask!.id} message={l.ask!} askId={chat.askId!} onEnded={() => void loadAsk()} />
          ),
        )}
      </ol>
      {lines.length === 0 && (
        <p className="simple-small text-text2" data-testid="hop-empty">
          Ask why something is ranked, what to cut, or what is missing.
        </p>
      )}
      <div ref={end} />
      <ChatComposer
        send={send}
        placeholder={changes ? `Ask about ${name}, or ask for a change…` : `Ask about ${name}…`}
        hint={changes ? undefined : "You can ask questions; changes need a commenter or above."}
        typed={typed}
      />
    </section>
  );
}

/** A line of the chat's Oracle's Ask chat: the person's question or Oracle's answer, read as it streams. */
function AskLine({ message: m, askId, onEnded }: { message: AskMessage; askId: string; onEnded: () => void }) {
  const live = m.author_kind === "oracle" && (m.status === "pending" || m.status === "streaming");
  const [text, setText] = useState(m.body);
  const [failed, setFailed] = useState(m.status === "failed" ? (m.error ?? "Oracle can't reply right now.") : null);
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });
  useEffect(() => {
    if (!live) return;
    const abort = new AbortController();
    let first = true;
    void openStream(`/v1/discussions/${askId}/messages/${m.id}/stream`, {
      signal: abort.signal,
      onReset: () => {
        first = true;
      },
      onDelta: (t) => {
        const reset = first;
        first = false;
        setText((x) => (reset ? "" : x) + t);
      },
      onDone: (out) => {
        setText((out as AskMessage).body);
        ended.current();
      },
      onError: (e) => {
        if (!abort.signal.aborted) setFailed(e.message || "Oracle can't reply right now.");
      },
    }).catch(() => undefined);
    return () => abort.abort();
  }, [live, askId, m.id]);
  const person = m.author_kind === "person";
  return (
    <li data-testid="chat-message" data-kind={person ? "request" : "answer"} data-author={person ? "person" : "oracle"} className={`flex flex-col gap-2 ${person ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[95%] rounded-xl px-3 py-2 ${person ? "bg-accent-soft text-accent-ink" : "bg-surface2 text-text"}`}
        {...(person ? {} : { "data-testid": "ask-answer", "data-status": live && !text ? "pending" : m.status })}
      >
        <p className="simple-small font-semibold">{person ? (m.author?.name ?? "You") : "Oracle"}</p>
        {failed ? (
          <p role="alert" className="text-crit">
            {failed}
          </p>
        ) : (
          <p className="whitespace-pre-wrap" data-testid="chat-message-body">
            {text || (live ? "Thinking…" : "")}
          </p>
        )}
      </div>
    </li>
  );
}

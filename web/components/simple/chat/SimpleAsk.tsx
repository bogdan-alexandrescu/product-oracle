"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as KeyEvent, type ReactNode, type RefObject } from "react";

import { Icon, Mark } from "@/components/ds";
import { SIMPLE_ASK_PANEL_ID } from "@/components/simple/SimpleShell";
import { takeAskDraft, useAskDraft } from "@/components/hop/open-state";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { askSay, askThread, linkAsk, recentChats, type ChatMessage, type ChatSummary, type ChatThread } from "@/lib/api/simple-chat";
import { dayIn, formatInZone, todayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { openStream } from "@/lib/stream";
import { GENERAL, pageName, useCurrentScreenSubject, type ScreenSubject } from "@/lib/screen-subject";
import { errorMessage } from "@/lib/use-query";

import { AnswerSources, AnswerText, Who, chatTime, type AnswerCite } from "./AskAnswer";
import { ChatComposer, ChatLine, shownLines, useCorrections, usePendingPoll, type Typed } from "./ChatThread";

type AskMessage = Schemas["DiscussionMessageOut"];

/**
 * The chat the panel shows: Oracle's plan reader's thread (`id`) and the Oracle's Ask chat it
 * handed its questions to (`askId`); `reopened`: chosen from Recent chats.
 */
type Chat = { id: string | null; askId: string | null; page: string; general: boolean; reopened?: boolean };

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** "Today, 7:42 PM" for today's chats, else "Oct 26": in the company's time zone (the pick's Recent menu). */
/** fix4 qa-simple-roadmap-50: a chat titled by its first question reads as a title: trimmed,
 * one line, its first letter capitalised, its quotes curly (“ ” and ‘ ’) like the chat's cards. */
export function tidyTitle(q: string): string {
  const t = q
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s(\[])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s(\[])'/g, "$1‘")
    .replace(/'/g, "’");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function chatWhen(iso: string, zone: string, now: number = Date.now()): string {
  if (dayIn(iso, zone) === todayIn(zone, now)) return `Today, ${chatTime(iso, zone)}`;
  return formatInZone(iso, zone, { month: "short", day: "numeric" });
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

/** What the empty chat invites: "Ask about the roadmap, or ask for a change." */
function aboutWords(name: string): string {
  const the: Record<string, string> = { Roadmap: "the roadmap", Priorities: "the priorities", Decisions: "the decisions", Meetings: "the meetings", "One-pagers": "the one-pagers", General: "anything" };
  return the[name] ?? name;
}

/**
 * qa-simple-home-22: a one-pager's chat is about its document ("Ask about Checkout redesign"):
 * the shown page's heading names it (the page says no subject of its own). Null elsewhere.
 */
function useShownHeading(on: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const main = document.querySelector("main");
    if (!on || !main) return;
    const update = () => {
      // Next keeps recently visited routes mounted but hidden: the shown page's H1.
      const h1s = [...main.querySelectorAll("h1")];
      const h1 = h1s.find((h) => h.checkVisibility?.() !== false && h.getClientRects().length > 0) ?? h1s.find((h) => h.closest("[hidden]") === null);
      const t = h1?.textContent?.trim() || null;
      setText(t && t !== "One-pager" ? t : null);
    };
    update();
    const watch = new MutationObserver(update);
    watch.observe(main, { subtree: true, childList: true, characterData: true });
    return () => {
      watch.disconnect();
      setText(null);
    };
  }, [on]);
  return on ? text : null;
}

/** The pick's history mark beside "Recent chats" (a clock with its arrow back). */
function History() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4M12 8v4l3 2" />
    </svg>
  );
}

/**
 * Simple's Ask panel (ask-fresh, the owner's pick C "Always a clean slate", 2026-10-28, drawn
 * as its mock-up): every time it opens it is a new, empty chat about the page it was opened
 * on. The header has New chat and the close button; under it the This page | General switch
 * and "Just you and Oracle"; then "New chat about Home" with the Recent chats menu, which
 * opens over the chat and lists the person's last chats by their question, page and time
 * (meeting chats stay in their meeting); the conversation; and the message box with Send
 * pinned to the bottom. Each line goes to Oracle's plan reader first (its answers,
 * restatements and cards with their actions); a question it hands on goes to Oracle's Ask,
 * whose answer shows in the same chat with its sections and sources. `mark`: the header's
 * Oracle mark (the phone's sheet has none).
 */
export function SimpleAskPanel({ onClose, closeLabel = "Close Ask Oracle", showHeader = true, mark = true }: { onClose?: () => void; closeLabel?: string; showHeader?: boolean; mark?: boolean }) {
  const pathname = usePathname() ?? "/simple";
  const screen = useCurrentScreenSubject();
  const { can } = useMe();
  const [chat, setChat] = useState<Chat>({ id: null, askId: null, page: pathname, general: false });
  const [recent, setRecent] = useState<ChatSummary[] | null>(null);
  // Words typed in from outside (Suggest from the chat, a PRD question's Ask Oracle) close Recent chats over the chat.
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
  const onePager = !chat.general && chat.page === pathname && pageName(pathname) === "One-pager" && screen.kind === "screen";
  const heading = useShownHeading(onePager);
  const name = chat.general ? "General" : heading ?? (chat.page === pathname && screen.label && !screen.label.startsWith("/") ? screen.label : pageName(chat.page));
  const begin = (general: boolean) => {
    setChat({ id: null, askId: null, page: pathname, general });
    setSession((n) => n + 1);
    setRecent(null);
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const openRecent = async () => {
    setRecent([]);
    try {
      setRecent(await recentChats());
    } catch {
      setRecent([]);
    }
  };
  const changes = can("create_simple_change");
  // qa-simple-home-20: closed, the panel gives focus back to what opened it (Ask Oracle, a decision's Ask Oracle).
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const at = document.activeElement;
    const opener = at instanceof HTMLElement && at !== document.body && !root.current?.contains(at) ? at : null;
    return () => {
      if (!opener) return;
      window.setTimeout(() => {
        const now = document.activeElement;
        if (opener.isConnected && (!now || now === document.body)) opener.focus();
      }, 0);
    };
  }, []);
  // qa-simple-home-19: a chat from another page says that page on the switch, not "This page".
  const herePage = !chat.general && chat.page !== pathname ? pageName(chat.page) : "This page";

  return (
    <div
      ref={root}
      // qa-simple-home-24: the docked panel (with its header and mark) is what the rail's Ask Oracle controls.
      id={showHeader && mark ? SIMPLE_ASK_PANEL_ID : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface text-[15px] leading-[22px] text-text"
      data-testid="hop-panel"
    >
      {showHeader && (
        <div className="flex min-h-14 flex-none items-center gap-2 border-b border-line pr-3 pl-4">
          {mark && <Mark size={22} tone="current" className="flex-none text-accent" />}
          <h2 className="min-w-0 flex-1 font-display text-lg leading-6 font-bold tracking-[-0.01em]">Ask Oracle</h2>
          <button
            type="button"
            data-testid="ask-new-chat"
            onClick={() => begin(chat.general)}
            className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm leading-none font-semibold whitespace-nowrap text-text hover:bg-surface2"
          >
            <Icon name="plus" size={16} stroke={2} />
            New chat
          </button>
          {onClose && (
            <button type="button" aria-label={closeLabel} onClick={onClose} className="grid size-9 flex-none place-items-center rounded-lg text-text hover:bg-surface2">
              <Icon name="x" size={20} stroke={1.7} />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-none items-center gap-2.5 border-b border-line px-4 py-2.5">
        <div role="group" aria-label="About" className="inline-flex flex-none gap-0.5 rounded-[10px] bg-surface2 p-[3px]">
          {(
            [
              [false, herePage],
              [true, "General"],
            ] as const
          ).map(([general, label]) => {
            const on = chat.general === general;
            return (
              <button
                key={String(general)}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  if (on) return;
                  // An empty chat changes what it is about; a chat already started stays as it is (in Recent) and a new one begins.
                  if (fresh) {
                    setChat({ ...chat, general });
                    setSession((n) => n + 1);
                  } else begin(general);
                }}
                className={`grid h-[30px] place-items-center rounded-lg px-3 text-sm leading-none whitespace-nowrap ${on ? "bg-surface font-semibold text-text shadow-[var(--seg-on-shadow)]" : "font-medium text-text2 hover:text-text"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="ml-auto flex min-w-0 items-center gap-1.5 text-sm text-text2" data-testid="hop-visibility">
          <Icon name="lock" size={16} stroke={1.7} className="size-3.5" />
          Just you and Oracle
        </p>
      </div>

      <ChatView
        key={session}
        chat={chat}
        name={name}
        draftKey={chat.general ? "general" : chat.page}
        subject={chat.general ? GENERAL : chat.page === pathname ? screen : { kind: "screen", subject: { path: chat.page }, label: name }}
        asks={can("create_discussion")}
        changes={changes}
        onChat={(c) => setChat((was) => ({ ...was, ...c }))}
        top={(question) => (
          <p className="mb-3 flex items-center gap-2 text-sm text-text2">
            <span className="min-w-0 truncate" data-testid="ask-about" title={question ? tidyTitle(question) : undefined}>
              {/* qa-simple-home-23: "New general chat", not "New chat about General". */}
              {question
                ? tidyTitle(question)
                : chat.general
                  ? chat.reopened
                    ? "General chat"
                    : "New general chat"
                  : chat.reopened
                    ? `Chat about ${name}`
                    : `New chat about ${name}`}
            </span>
            <button
              ref={trigger}
              type="button"
              data-testid="ask-recent"
              aria-expanded={recent !== null}
              aria-haspopup="true"
              onClick={() => (recent === null ? void openRecent() : setRecent(null))}
              // qa-simple-home-25: a 24 px tap target (44 px on a phone), the same text link.
              className="ml-auto inline-flex min-h-6 flex-none items-center gap-0.5 rounded font-semibold whitespace-nowrap text-accent-ink hover:underline max-[600px]:min-h-11"
            >
              <History />
              Recent chats
              <Icon name="chevron-down" size={16} stroke={2} className="size-3.5" />
            </button>
          </p>
        )}
        overlay={
          recent !== null && (
            <RecentMenu
              items={recent}
              trigger={trigger}
              onClose={() => setRecent(null)}
              onOpen={(c) => {
                setChat({ id: c.id, askId: c.ask_id ?? null, page: c.page, general: c.general, reopened: true });
                setSession((n) => n + 1);
                setRecent(null);
              }}
            />
          )
        }
      />
    </div>
  );
}

/**
 * Recent chats, the small menu over the chat (pick C): "YOUR RECENT CHATS", each chat's
 * question with its page and time, and "Meeting chats stay in their meeting." Escape, a
 * click outside it or the trigger closes it; arrow keys move through the chats.
 */
function RecentMenu({
  items,
  trigger,
  onOpen,
  onClose,
}: {
  items: ChatSummary[];
  trigger: RefObject<HTMLButtonElement | null>;
  onOpen: (c: ChatSummary) => void;
  onClose: () => void;
}) {
  const zone = useCompanyZone();
  const menu = useRef<HTMLElement>(null);
  const shut = useRef(onClose);
  useEffect(() => {
    shut.current = onClose;
  });
  useEffect(() => {
    // Escape closes the menu only (not the panel or the phone's sheet): first, on the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      shut.current();
      trigger.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || trigger.current?.contains(t)) return;
      shut.current();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [trigger]);
  // The first chat is under the pointer's way in: focused, as the pick shows it.
  const count = items.length;
  useEffect(() => {
    if (count) menu.current?.querySelector<HTMLElement>("[data-testid=ask-recent-row]")?.focus({ preventScroll: true });
  }, [count]);
  const move = (e: KeyEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-testid=ask-recent-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  return (
    <section
      ref={menu}
      aria-label="Recent chats"
      data-testid="ask-recent-list"
      onKeyDown={move}
      className="absolute top-[37px] right-3 z-10 flex max-h-[calc(100%-50px)] w-[340px] max-w-[calc(100%-24px)] flex-col overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-tip"
    >
      <h3 className="px-2 py-1.5 text-xs leading-4 font-semibold tracking-[.06em] text-text2 uppercase">Your recent chats</h3>
      {items.length === 0 ? (
        <p className="px-2 py-2 text-[13px] leading-[18px] text-text2">No chats yet.</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="ask-recent-row"
                onClick={() => onOpen(c)}
                className="flex w-full flex-col rounded-lg p-2 text-left outline-none hover:bg-surface2 focus:bg-surface2 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,var(--accent))]"
              >
                <b className="text-[15px] leading-[21px] font-semibold text-text [overflow-wrap:anywhere]" data-testid="ask-recent-question">
                  {(c.question && tidyTitle(c.question)) || `Chat about ${c.page_name}`}
                </b>
                <span className="text-[13px] leading-[18px] text-text2" data-testid="ask-recent-when">
                  {c.page_name} · {chatWhen(c.last_at, zone)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 border-t border-line p-2 text-[13px] leading-[18px] text-text2" data-testid="ask-recent-meetings">
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
  draftKey,
  subject,
  asks,
  changes,
  onChat,
  top,
  overlay,
}: {
  chat: Chat;
  name: string;
  /** qa-simple-home-22: whose words the box holds (the page's chat, or General): an unsent draft stays with its chat. */
  draftKey: string;
  subject: ScreenSubject;
  asks: boolean;
  changes: boolean;
  onChat: (c: Partial<Chat>) => void;
  /** "New chat about Home" (or the chat's first question) and the Recent chats trigger, over the lines. */
  top: (question: string | null) => ReactNode;
  /** The Recent chats menu, over the lines. */
  overlay: ReactNode;
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
  // qa-simple-home-22: one wording for the box and the empty chat ("Ask about the roadmap").
  const about = aboutWords(name);

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
  // qa-simple-home-16: once asked, the chat is titled by its first question.
  const firstAsked = lines.find((l) => (l.plan ? l.plan.author_kind === "person" : l.ask?.author_kind === "person"));
  const question = (firstAsked?.plan?.body ?? firstAsked?.ask?.body ?? "").trim() || null;
  // The newest question at the top of the conversation, its answer reading down from it (the
  // panel's own scroll; the page never moves). The first question leaves the chat at its top.
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const ol = list.current;
    if (!box || !ol) return;
    const asked = [...ol.querySelectorAll<HTMLElement>(':scope > [data-author="person"]')].at(-1);
    if (asked) box.scrollTop = asked.offsetTop - ol.offsetTop;
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
    <section ref={here} aria-label="Ask or change the plan" data-testid="ask-chat" className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="relative h-full overflow-x-hidden overflow-y-auto px-4 py-3">
          {top(question)}
          {error && (
            <p role="alert" className="mb-3 text-sm text-crit">
              {error}
            </p>
          )}
          <ol ref={list} className="flex flex-col gap-3" aria-label="Messages" data-testid="ask-chat-thread">
            {lines.map((l) =>
              l.plan ? (
                <ChatLine key={l.plan.id} message={l.plan} onCardChanged={() => void load()} onThread={setThread} corrected={corrected} ask />
              ) : (
                <AskLine key={l.ask!.id} message={l.ask!} askId={chat.askId!} onEnded={() => void loadAsk()} />
              ),
            )}
          </ol>
          {lines.length === 0 && (
            <p className="px-2 pt-7 pb-3 text-center text-text2" data-testid="hop-empty">
              <b className="mb-1 block text-[17px] leading-6 font-[650] text-text">Nothing yet</b>
              {changes ? `Ask about ${about}, or ask for a change.` : `Ask about ${about}.`}
            </p>
          )}
        </div>
        {/* A phone's sheet fades the conversation into the box under it. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-7 bg-linear-to-b from-transparent to-surface max-[600px]:block" />
        {overlay}
      </div>
      <div className="flex-none border-t border-line px-4 pt-2.5 pb-3.5">
        <ChatComposer
          row
          send={send}
          placeholder={changes ? `Ask about ${about}, or ask for a change…` : `Ask about ${about}…`}
          hint={changes ? undefined : "You can ask questions. To suggest a change, ask an owner for comment access."}
          typed={typed}
          draftKey={draftKey}
        />
      </div>
    </section>
  );
}

/** A line of the chat's Oracle's Ask chat: the person's question or Oracle's answer (its sections and sources), read as it streams. */
function AskLine({ message: m, askId, onEnded }: { message: AskMessage; askId: string; onEnded: () => void }) {
  const zone = useCompanyZone();
  const live = m.author_kind === "oracle" && (m.status === "pending" || m.status === "streaming");
  const [text, setText] = useState(m.body);
  const [cites, setCites] = useState<AnswerCite[]>((m.citations ?? []) as AnswerCite[]);
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
      onCitations: (c) => setCites(c as AnswerCite[]),
      onDone: (out) => {
        setText((out as AskMessage).body);
        setCites(((out as AskMessage).citations ?? []) as AnswerCite[]);
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
        className={`min-w-0 max-w-[94%] rounded-[14px] px-3 py-2 ${person ? "bg-accent-soft text-accent-ink" : "bg-surface2 text-text"}`}
        {...(person ? {} : { "data-testid": "ask-answer", "data-status": live && !text ? "pending" : m.status })}
      >
        <Who name={person ? "You" : "Oracle"} at={m.created_at} zone={zone} mine={person} />
        {failed ? (
          <p role="alert" className="text-crit">
            {failed}
          </p>
        ) : person ? (
          <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="chat-message-body">
            {text}
          </p>
        ) : text ? (
          <>
            <AnswerText text={text} live={live} />
            <AnswerSources cites={cites} />
          </>
        ) : (
          <p className="text-text2" data-testid="chat-message-body">
            {live ? "Thinking…" : ""}
          </p>
        )}
      </div>
    </li>
  );
}

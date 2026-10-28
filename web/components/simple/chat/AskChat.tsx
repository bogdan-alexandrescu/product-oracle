"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { takeAskDraft, useAskDraft } from "@/components/hop/open-state";
import { askSay, askThread, hasPending, PENDING_POLL_MS, type ChatMessage, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatMessages, ChatThreadView, usePendingPoll } from "./ChatThread";

/**
 * The Ask panel's one box on Simple's pages (S9, direction A; the production walk): a line
 * Oracle's plan reader understands (a change request, who owns / who decides / when is) gets
 * its cards or answer here, in the reader's own thread, whose cards apply or propose under the
 * reader's own rights; any other line goes to `ask` (Oracle's Ask about the page, the panel's
 * old box). Without `ask` (no right to start a chat) such a line gets the reader's own reply.
 */
export function AskChat({ about, ask }: { about: string; ask?: (text: string) => Promise<void> }) {
  const page = usePathname();
  const { can } = useMe();
  // A thread read for another page never shows here.
  const [held, setHeld] = useState<{ page: string | null; thread: ChatThread } | null>(null);
  const thread = held && held.page === page ? held.thread : null;
  const setThread = useCallback((t: ChatThread) => setHeld({ page, thread: t }), [page]);
  const [error, setError] = useState<string | null>(null);
  // The walk: the thread belongs to the page the panel was opened from (a new page starts empty).
  const load = useCallback(async () => {
    try {
      setThread(await askThread(page ?? undefined));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [page, setThread]);
  useEffect(() => {
    let live = true;
    askThread(page ?? undefined)
      .then((t) => {
        if (!live) return;
        // Lines read as Ask's before this panel opened were handed then: never again.
        for (const m of t.messages) if (m.kind === "ask") HANDED.add(m.id);
        setThread(t);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [page, setThread]);
  usePendingPoll(thread, load);
  // chat-reader: a line the reader reads as a question for Oracle's Ask goes there, once.
  useEffect(() => {
    if (!ask || !thread) return;
    for (const m of thread.messages) {
      if (m.kind !== "ask" || HANDED.has(m.id)) continue;
      HANDED.add(m.id);
      const line = thread.messages.find((x) => x.id === m.reply_to);
      if (line) void ask(line.body).catch((e) => setError(errorMessage(e)));
    }
  }, [thread, ask]);
  const changes = can("create_simple_change");
  // "Suggest from the chat": the words a goal's drawer typed in, taken once.
  const waiting = useAskDraft();
  const [typed, setTyped] = useState("");
  const here = useRef<HTMLElement>(null);
  useEffect(() => {
    // Only the box a person sees takes them (the dock's panel is hidden on a phone): a DOM check.
    if (waiting && here.current?.getClientRects().length) setTyped(takeAskDraft());
  }, [waiting]);
  const send = async (text: string) => {
    const t = await askSay(text, page ?? undefined, !!ask);
    if (t.understood === false && ask) return ask(text);
    setThread(t);
  };
  return (
    <section ref={here} aria-label="Ask or change the plan" data-testid="ask-chat" className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      <ChatThreadView
        testId="ask-chat-thread"
        thread={thread}
        placeholder={changes ? `Ask about ${about}, or ask for a change…` : `Ask about ${about}…`}
        hint={changes ? undefined : "You can ask questions; changes need a commenter or above."}
        send={send}
        onCardChanged={() => void load()}
        onThread={setThread}
        typed={typed}
      />
    </section>
  );
}

/** The Ask lines (kind "ask") already handed to Oracle's Ask in this page's life. */
const HANDED = new Set<string>();

const MAX_WAIT_POLLS = 20;

/**
 * The same one box inside an Ask chat already started (Simple's pages): `text` goes to
 * Oracle's plan reader first; a line it understands shows its line, answer or cards here
 * (kept in the reader's own thread), else null and the chat posts the line to Ask. A line the
 * reader is still reading is waited for (polled) first: read as a question, it goes to Ask too.
 */
export async function askInChat(text: string, page: string | undefined, handOff?: (text: string) => Promise<void>): Promise<ReactNode | null> {
  let t = await askSay(text, page, true);
  if (t.understood === false) return null;
  const from = t.messages.findLastIndex((m) => m.author_kind === "person");
  const mine = new Set(t.messages.slice(Math.max(from, 0)).map((m) => m.id));
  const lines = () => t.messages.filter((m) => mine.has(m.id));
  for (let n = 0; hasPending({ messages: lines() }) && n < MAX_WAIT_POLLS; n++) {
    await new Promise((r) => window.setTimeout(r, PENDING_POLL_MS));
    t = await askThread(page);
  }
  const asked = lines().find((m) => m.kind === "ask");
  if (asked) {
    HANDED.add(asked.id);
    return null;
  }
  return <AskLines lines={lines()} page={page} handOff={handOff} />;
}

/** S9's lines shown in an Ask chat (and the lines after them: a choice's, a retry's); a card applied or discarded reloads them from the reader's thread. */
function AskLines({ lines, page, handOff }: { lines: ChatMessage[]; page: string | undefined; handOff?: (text: string) => Promise<void> }) {
  const [shown, setShown] = useState(lines);
  // A line still being read when askInChat stopped waiting: read as Ask's, it goes to Ask now, once.
  useEffect(() => {
    if (!handOff) return;
    for (const m of shown) {
      if (m.kind !== "ask" || HANDED.has(m.id)) continue;
      HANDED.add(m.id);
      const line = shown.find((x) => x.id === m.reply_to);
      if (line) void handOff(line.body);
    }
  }, [shown, handOff]);
  // A choice picked here adds its lines (they follow the last one shown); a reload keeps those shown.
  const take = (t: ChatThread, grow: boolean) =>
    setShown((was) => {
      const ids = new Set(was.map((m) => m.id));
      const last = t.messages.findIndex((m) => m.id === was[was.length - 1]?.id);
      return t.messages.filter((m, n) => ids.has(m.id) || (grow && last >= 0 && n > last));
    });
  const reload = async () => take(await askThread(page), false);
  usePendingPoll({ messages: shown }, reload);
  return (
    <div data-testid="ask-chat-lines">
      <ChatMessages messages={shown} onCardChanged={() => void reload()} onThread={(t) => take(t, true)} />
    </div>
  );
}

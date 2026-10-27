"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { askSay, askThread, type ChatMessage, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatMessages, ChatThreadView } from "./ChatThread";

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
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setThread(await askThread());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    let live = true;
    askThread()
      .then((t) => live && setThread(t))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);
  const changes = can("create_simple_change");
  const send = async (text: string) => {
    const t = await askSay(text, page ?? undefined, !!ask);
    if (t.understood === false && ask) return ask(text);
    setThread(t);
  };
  return (
    <section aria-label="Ask or change the plan" data-testid="ask-chat" className="flex flex-col gap-2">
      {error && !thread && (
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
      />
    </section>
  );
}

/**
 * The same one box inside an Ask chat already started (Simple's pages): `text` goes to
 * Oracle's plan reader first; a line it understands shows its line, answer or cards here
 * (kept in the reader's own thread), else null and the chat posts the line to Ask.
 */
export async function askInChat(text: string, page: string | undefined): Promise<ReactNode | null> {
  const t = await askSay(text, page, true);
  if (t.understood === false) return null;
  const from = t.messages.findLastIndex((m) => m.author_kind === "person");
  return <AskLines lines={t.messages.slice(Math.max(from, 0))} />;
}

/** S9's lines shown in an Ask chat; a card applied or discarded reloads them from the reader's thread. */
function AskLines({ lines }: { lines: ChatMessage[] }) {
  const [shown, setShown] = useState(lines);
  const reload = async () => {
    const ids = new Set(lines.map((m) => m.id));
    const t = await askThread();
    setShown(t.messages.filter((m) => ids.has(m.id)));
  };
  return (
    <div data-testid="ask-chat-lines">
      <ChatMessages messages={shown} onCardChanged={() => void reload()} />
    </div>
  );
}

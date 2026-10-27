"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { askSay, askThread, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatThreadView } from "./ChatThread";

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

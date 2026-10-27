"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { askSay, askThread, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatThreadView } from "./ChatThread";

/**
 * The Ask panel's change-by-chat thread on Simple's pages (S9, direction A): the reader's own
 * thread with Oracle, whose change cards apply or propose under the reader's own rights.
 */
export function AskChat() {
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
  return (
    <section aria-label="Change the plan" data-testid="ask-chat" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold tracking-wide text-text2 uppercase">Ask or change the plan</h3>
      {error && !thread && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      <ChatThreadView
        testId="ask-chat-thread"
        thread={thread}
        placeholder={changes ? "Ask a question or ask for a change…" : "Ask a question about the plan…"}
        hint={changes ? undefined : "You can ask questions; changes need a commenter or above."}
        send={async (text) => setThread(await askSay(text, page ?? undefined))}
        onCardChanged={() => void load()}
      />
    </section>
  );
}

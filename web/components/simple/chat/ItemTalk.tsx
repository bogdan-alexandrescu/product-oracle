"use client";

import { useCallback, useEffect, useState } from "react";

import { askSay, askThread, itemTalkPage, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatThreadView, usePendingPoll } from "./ChatThread";

/**
 * roadmap-talk: the item card's talk with Oracle, on the Ask chat's endpoints with the item's
 * own page (`/simple/roadmap/items/<id>`): one thread per item and person, where "it" means the
 * item. Questions get Oracle's answer with its source; changes get action cards.
 */
export function ItemTalk({ itemId, about, onHide, hideLabel = "Hide the talk" }: { itemId: string; about: string; onHide: () => void; hideLabel?: string }) {
  const page = itemTalkPage(itemId);
  const { can } = useMe();
  const [held, setHeld] = useState<{ page: string; thread: ChatThread } | null>(null);
  const thread = held && held.page === page ? held.thread : null;
  const setThread = useCallback((t: ChatThread) => setHeld({ page, thread: t }), [page]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setThread(await askThread(page));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [page, setThread]);
  useEffect(() => {
    let live = true;
    askThread(page)
      .then((t) => live && setThread(t))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [page, setThread]);
  usePendingPoll(thread, load);
  const changes = can("create_simple_change");
  return (
    <section aria-label={`Talk about ${about}`} data-testid="item-talk" className="flex min-w-0 flex-col gap-3 simple-mode">
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="min-w-0 flex-1 text-lg leading-snug font-semibold [overflow-wrap:anywhere]" data-testid="item-talk-title">
          Talk about {about}
        </h3>
        <button type="button" className="simple-button" onClick={onHide}>
          {hideLabel}
        </button>
      </div>
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      <ChatThreadView
        testId="item-talk-thread"
        thread={thread}
        placeholder={changes ? "Ask about it, or ask for a change…" : "Ask about it…"}
        hint={changes ? undefined : "You can ask questions; changes need a commenter or above."}
        note="Just you and Oracle · kept with this item"
        send={async (text) => setThread(await askSay(text, page))}
        onCardChanged={() => void load()}
        onThread={setThread}
      />
    </section>
  );
}

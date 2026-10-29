"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon, ICONS } from "@/components/simple/FlowViews";
import { askSay, askThread, itemTalkPage, type ChatThread } from "@/lib/api/simple-chat";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { ChatComposer, ChatMessages, usePendingPoll } from "./ChatThread";

/**
 * roadmap-talk, drawn to the owner's pick C ("Wider card, talk beside the details",
 * simple-v3/talk/card-ask.html): the item card's talk with Oracle, on the Ask chat's endpoints
 * with the item's own page (`/simple/roadmap/items/<id>`): one thread per item and person, where
 * "it" means the item. "TALK ABOUT F-06" as a rule over the lines (a desktop's column), the lines
 * oldest first, and the message box pinned to the foot with "Just you and Oracle · kept with this
 * item" under it. Questions get Oracle's answer with its source; changes get action cards.
 */
export function ItemTalk({ itemId, about, code, phone = false }: { itemId: string; about: string; code?: string | null; phone?: boolean }) {
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
  // The newest line in view: the talk scrolls to its end as lines arrive (only the talk, never the page).
  const scroller = useRef<HTMLDivElement>(null);
  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  const changes = can("create_simple_change");
  const short = code || "it";
  return (
    <section aria-label={`Talk about ${about}`} data-testid="item-talk" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!phone && (
        <h3 data-testid="item-talk-title" className="mx-4 mt-3.5 flex flex-none items-center gap-2 text-[12px] leading-4 font-semibold tracking-[.06em] text-text2 uppercase before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
          Talk about {code || about}
        </h3>
      )}
      <div ref={scroller} data-testid="item-talk-thread" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && (
          <p role="alert" className="mb-2 text-[14px] text-crit">
            {error}
          </p>
        )}
        <ChatMessages messages={thread?.messages ?? []} onCardChanged={() => void load()} onThread={setThread} />
      </div>
      {/* Pick C's message box: the box and Send on one row (the chat's composer, laid out here). */}
      <div className="flex flex-none flex-col gap-1.5 border-t border-line px-4 pt-2.5 pb-3 [&>form]:flex-row [&>form]:flex-wrap [&>form]:items-end [&>form>p]:basis-full [&>form>textarea]:h-11 [&>form>textarea]:min-h-11 [&>form>textarea]:min-w-0 [&>form>textarea]:flex-1 [&>form>textarea]:basis-0 [&>form>textarea]:resize-none [&>form>textarea]:rounded-[10px] [&>form>textarea]:py-2.5 [&>form>textarea]:text-[15px] [&>form>textarea]:leading-[22px] [&>form>textarea]:placeholder:text-text-faint">
        <ChatComposer
          send={async (text) => setThread(await askSay(text, page))}
          placeholder={changes ? `Ask about ${short}, or ask for a change…` : `Ask about ${short}…`}
          hint={changes ? undefined : "You can ask questions; changes need a commenter or above."}
        />
        <p className="flex items-center gap-1.5 text-[14px] leading-5 text-text2" data-testid="chat-note">
          <Icon d={ICONS.lock} size={14} width={1.7} />
          Just you and Oracle · kept with this item
        </p>
      </div>
    </section>
  );
}

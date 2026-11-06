"use client";

import { api, unwrap } from "@/lib/api/client";
import { CARD_CHANGED_EVENT } from "@/lib/api/simple-chat";
import { invalidateWaiting as invalidateInbox, onWaitingChanged, waitingChanged } from "@/lib/waiting";

/**
 * home-waiting-one-list: everything waiting on me as one list (`items`: run stops, questions,
 * broken links, dates, drafts, proposals, goal suggestions), with the decisions' count; Home,
 * Decisions and the rail share it. Shared like lib/waiting's reads: a result this fresh is
 * shared rather than fetched again, a failure never.
 */
const FRESH_MS = 2000;
let hit: { at: number; promise: ReturnType<typeof fetchWaiting> } | null = null;

const fetchWaiting = () => unwrap(api.GET("/v1/simple/decisions/waiting"));

export function loadWaiting() {
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = fetchWaiting();
  hit = { at: Date.now(), promise };
  promise.catch(() => {
    if (hit?.promise === promise) hit = null;
  });
  return promise;
}

/** Forget what is cached (the Inbox's reads and the one list) without telling anyone: the next read fetches. */
export function invalidateWaiting() {
  hit = null;
  invalidateInbox();
}

export { onWaitingChanged, waitingChanged };

// Any page that tells the rail what waits changed (through lib/waiting) drops the one list too,
// before the rail and Home read it again.
if (typeof window !== "undefined") onWaitingChanged(() => (hit = null));
// A change said to the whole page (sendCardChanged: the feature panel, a chat card) drops it as
// well, before the queries that read it again (lib/use-query) fetch.
if (typeof window !== "undefined") window.addEventListener(CARD_CHANGED_EVENT, () => invalidateWaiting());

/**
 * After an action that changed what waits on me: the page's own `reload` and the rail's counts
 * read again at once (roadmap-decide).
 */
export async function reloadWaiting(reload: () => Promise<unknown>): Promise<void> {
  invalidateWaiting();
  const reloaded = reload();
  waitingChanged();
  await reloaded;
}

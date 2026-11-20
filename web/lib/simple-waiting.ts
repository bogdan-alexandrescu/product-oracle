'use client';

import { api, unwrap } from '@/lib/api/client';
import { STALE_OK } from '@/lib/api/shared-reads';
import { CARD_CHANGED_EVENT } from '@/lib/api/simple-chat';
import {
  invalidateWaiting as invalidateInbox,
  onWaitingChanged,
  waitingChanged,
} from '@/lib/waiting';

/**
 * home-waiting-one-list: everything waiting on me as one list (`items`: run stops, questions,
 * broken links, dates, drafts, proposals, goal suggestions), with the decisions' count; Home,
 * Decisions and the rail share it. Shared like lib/waiting's reads: a result this fresh is
 * shared rather than fetched again, a failure never.
 */
const FRESH_MS = 2000;
// `at`: when the read answered; null while it is on its way.
let hit: { at: number | null; promise: ReturnType<typeof fetchWaiting> } | null = null;

const fetchWaiting = () => unwrap(api.GET('/v1/simple/decisions/waiting'));

/** The one list's URL, as lib/api/shared-reads' onReadChanged names it. */
export const WAITING_URL = '/v1/simple/decisions/waiting';

/**
 * staleOk (simple-call-budget): a part of a page that the rail's count already covers (the Inbox's
 * broken links) takes the rail's answer as the rail does, so moving there never reads it again.
 */
export function loadWaiting(staleOk = false) {
  // QA: a read still on its way is shared however long it takes (the rail's, then the page's
  // once its own list arrives), so a slow answer is never asked for twice; fresh is counted from
  // when it answered.
  if (hit && (hit.at === null || Date.now() - hit.at < FRESH_MS)) return hit.promise;
  if (staleOk) return unwrap(api.GET(WAITING_URL, { headers: { [STALE_OK]: '1' } }));
  const promise = fetchWaiting();
  const mine: NonNullable<typeof hit> = { at: null, promise };
  hit = mine;
  promise.then(
    () => (mine.at = Date.now()),
    () => {
      if (hit === mine) hit = null;
    },
  );
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
if (typeof window !== 'undefined') onWaitingChanged(() => (hit = null));
// A change said to the whole page (sendCardChanged: the feature panel, a chat card) drops it as
// well, before the queries that read it again (lib/use-query) fetch.
if (typeof window !== 'undefined')
  window.addEventListener(CARD_CHANGED_EVENT, () => invalidateWaiting());

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

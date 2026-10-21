"use client";

import { api, unwrap } from "@/lib/api/client";

/**
 * What waits on the signed-in person: the Inbox's rows and the questions asked of them
 * (I3). The rail badge, Home and /inbox read both through here, so they count the same and
 * a page and the rail opening together share one call each.
 */

/** A result this fresh is shared rather than fetched again. */
const FRESH_MS = 2000;
const cache = new Map<string, { at: number; promise: Promise<unknown> }>();

function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise as Promise<T>;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  // A failure is never shared: the next caller tries again.
  promise.catch(() => cache.get(key)?.promise === promise && cache.delete(key));
  return promise;
}

export const loadInbox = () => shared("inbox", () => unwrap(api.GET("/v1/inbox")));

type Inbox = Awaited<ReturnType<typeof loadInbox>>;

/**
 * What waits on me, as the rail badge, Home and /inbox count it: each new or open item
 * (owner, 2026-10-20), so the Inbox's New + Open tabs. The API's total counts checkpoints,
 * cost approvals, overruns, stuck runs, couldn't-import and new or open feedback items
 * (staged, declined and done never); the questions asked of me are added here.
 */
export function waitingCount(inbox: Inbox, questions: readonly unknown[]): number {
  return inbox.total + questions.length;
}

/** Records this Inbox visit as my last one (C1e: what "new" is measured from next time). */
export const markInboxSeen = () => unwrap(api.GET("/v1/inbox", { params: { query: { mark_seen: true } } }));

/**
 * Questions still open and asked of me (asked, or delegated to me: C2), each with who asks,
 * its subject and its answer paths; the API filters, so none is cut off by a page size.
 */
export const loadMyQuestions = () => shared("my-questions", () => unwrap(api.GET("/v1/inbox/questions")));

const EVENT = "po:waiting-changed";

/**
 * After an action, once the page has started its own reloads: tells the rail to read its
 * count again (sharing those reloads). Call `invalidateWaiting` before the reloads.
 */
export function waitingChanged() {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `fn` whenever an action changed what is waiting; returns the unsubscribe. */
export function onWaitingChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** Forget what is cached without telling anyone: the next read fetches. */
export function invalidateWaiting() {
  cache.clear();
}

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
 * (staged, declined and done never), and never access requests (A5: no Inbox screen shows
 * them yet); the questions asked of me are added here.
 */
export function waitingCount(inbox: Inbox, questions: readonly unknown[]): number {
  return inbox.total + questions.length;
}

/**
 * Of what the rail counts (`waitingCount`), the Inbox rows Home draws itself from the one waiting
 * list: run stops, the questions asked of me, decision-log calls to decide, drafts for my approval,
 * proposals, dates, goal suggestions and the Plan › Outcomes, launch, ritual, metric and request
 * rows. Home shows the rest (feedback, cost approvals, discussions, reports, ...) as one row,
 * "N more in your Inbox", so its count is the rail's.
 */
export function drawnOnHome(inbox: Inbox, questions: readonly unknown[]): number {
  return (
    inbox.checkpoints.length +
    questions.length +
    (inbox.decisions ?? []).filter((d) => d.counts && d.reason === "needs_decision").length +
    inbox.simple_approvals.length +
    inbox.simple_proposals.length +
    inbox.simple_date_suggestions.length +
    inbox.simple_goal_suggestions.length +
    (inbox.outcomes ?? []).filter((o) => o.counts).length +
    (inbox.launches ?? []).filter((r) => r.counted).length +
    (inbox.rituals ?? []).filter((r) => r.counts && (r.state === "new" || r.state === "open")).length +
    (inbox.metrics ?? []).filter((m) => m.counts).length +
    (inbox.requests ?? []).filter((r) => r.counts).length
  );
}

/**
 * Records this Inbox visit as my last one (C1e: what "new" is measured from next time). A
 * shared read from before the mark is dropped, so coming back within FRESH_MS (Home and back,
 * qa-company-17) measures "new" from this visit, not the one before.
 */
export const markInboxSeen = () =>
  unwrap(api.GET("/v1/inbox", { params: { query: { mark_seen: true } } })).then((d) => {
    cache.delete("inbox");
    return d;
  });

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

/**
 * After an action that changed what waits on me: the page's own `reload` and the rail's and
 * More's counts read again at once, sharing one Inbox call.
 */
export async function reloadWaiting(reload: () => Promise<unknown>): Promise<void> {
  invalidateWaiting();
  const reloaded = reload();
  waitingChanged();
  await reloaded;
}

/**
 * QA pass D-2: the kinds Home's Needs you counts by, each a set of the Inbox's groups (NeedGroup,
 * app/inbox/_needs). Every counted row falls in one kind (Other holds the rest), so the chips add
 * up to the total; `/inbox?kind=<id>` shows that kind only.
 */
export const NEED_KINDS = [
  { id: "approvals", label: "Approvals", groups: ["checkpoints", "approvals", "roadmap-approvals", "overruns"] },
  { id: "runs", label: "Runs", groups: ["lookups", "imports", "tracks", "deliveries", "revising", "searches"] },
  { id: "access", label: "Access", groups: ["revoke-failures", "access-failures", "access-requests", "share-revocations"] },
  { id: "reviews", label: "Reviews", groups: ["feedback", "discussions"] },
  { id: "decisions", label: "Decisions", groups: ["decisions"] },
  { id: "questions", label: "Questions", groups: ["questions"] },
  // Proposals on my items, Oracle's dates and goal suggestions (a roadmap version waiting for my
  // approval is an approval).
  { id: "proposals", label: "Proposals", groups: ["proposals"] },
  { id: "other", label: "Other", groups: [] as string[] },
] as const;

export type NeedKind = (typeof NEED_KINDS)[number]["id"];

/** The kind a row of this Inbox group is counted under. */
export function needKind(group: string): NeedKind {
  return NEED_KINDS.find((k) => (k.groups as readonly string[]).includes(group))?.id ?? "other";
}

/** A `?kind=` value, if it names a kind. */
export const asNeedKind = (v: string | null | undefined): NeedKind | null => NEED_KINDS.find((k) => k.id === v)?.id ?? null;

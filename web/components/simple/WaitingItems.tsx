"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, loadWaiting, onWaitingChanged, waitingChanged } from "@/lib/waiting";

export type WaitingItem = Schemas["SimpleWaitingItem"];
type Waiting = Schemas["SimpleDecisionsWaitingOut"];

/**
 * home-waiting-one-list: everything that waits on me (GET /v1/simple/decisions/waiting `items`),
 * the one list Home's waiting cards, the Decisions page's "Waiting for you" and the rail read.
 * Read again whenever an action anywhere changed what waits (waitingChanged), so what I act on
 * leaves every page at once. undefined: not read yet.
 */
export function useWaitingList(): { data: Waiting | undefined; error: unknown } {
  const [data, setData] = useState<Waiting | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => onWaitingChanged(() => setChanges((c) => c + 1)), []);
  useEffect(() => {
    let alive = true;
    loadWaiting()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [changes]);
  return { data, error };
}

/** The actions an item takes in place; a run stop and a broken link open where they are done. */
function actionsOf(i: WaitingItem): { label: string; run: () => Promise<unknown>; done: string; primary?: boolean }[] {
  const change = { params: { path: { change_id: i.ref_id } } };
  const suggestion = { params: { path: { suggestion_id: i.ref_id } } };
  if (i.kind === "proposal" || (i.kind === "date" && i.op)) {
    return [
      { label: "Accept", primary: true, done: "Accepted", run: () => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", change)) },
      { label: "Decline", done: "Declined", run: () => unwrap(api.POST("/v1/simple/changes/{change_id}/decline", change)) },
    ];
  }
  if (i.kind === "date") {
    return [
      { label: "Confirm", primary: true, done: "Dates confirmed", run: () => unwrap(api.POST("/v1/simple/roadmap/date-suggestions/{suggestion_id}/accept", suggestion)) },
      { label: "Not this", done: "Dismissed", run: () => unwrap(api.POST("/v1/simple/roadmap/date-suggestions/{suggestion_id}/dismiss", suggestion)) },
    ];
  }
  if (i.kind === "goal_suggestion") {
    return [
      { label: "Confirm", primary: true, done: "Added to the roadmap", run: () => unwrap(api.POST("/v1/simple/goal-suggestions/{suggestion_id}/accept", { ...suggestion, body: {} })) },
      { label: "Not this", done: "Set aside", run: () => unwrap(api.POST("/v1/simple/goal-suggestions/{suggestion_id}/reject", { ...suggestion, body: { reason: null } })) },
    ];
  }
  if (i.kind === "draft") {
    return [{ label: "Approve", primary: true, done: "Approved", run: () => unwrap(api.POST("/v1/simple/drafts/{draft_id}/approve", { params: { path: { draft_id: i.ref_id } } })) }];
  }
  return [];
}

/** What kind of thing waits, in plain words. */
const KIND: Record<WaitingItem["kind"], string> = {
  run_stop: "Run stop",
  question: "Decision",
  broken_link: "Broken link",
  date: "Dates to confirm",
  draft: "Roadmap draft",
  proposal: "Proposal on your item",
  goal_suggestion: "Goal suggestion",
};

/**
 * One thing waiting on me, with its action in place (Accept / Decline, Confirm / Not this,
 * Approve) or, for a run stop or a broken link, a link to where it is done. Acting tells every
 * page and the rail, which read the list again, so the row leaves everywhere at once.
 */
export function WaitingRow({ item }: { item: WaitingItem }) {
  const [busy, setBusy] = useState(false);
  const acts = actionsOf(item);
  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await run();
      invalidateWaiting();
      waitingChanged();
      toast({ message: done });
    } catch (e) {
      toast({ message: errorMessage(e) });
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0" data-testid="waiting-item" data-kind={item.kind} aria-label={`${KIND[item.kind]}: ${item.title}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words">
          <span className="text-text2">{KIND[item.kind]} · </span>
          {item.title}
        </span>
        {item.detail && <span className="simple-small break-words">{item.detail}</span>}
      </div>
      <div className="flex flex-wrap gap-2 max-[600px]:w-full">
        {acts.length ? (
          acts.map((a) => (
            <button key={a.label} type="button" disabled={busy} className={`simple-button${a.primary ? " simple-button-primary" : ""}`} onClick={() => void act(a.run, a.done)}>
              {a.label}
            </button>
          ))
        ) : (
          <Link href={item.href} className="simple-button simple-button-primary">
            {item.action}
          </Link>
        )}
      </div>
    </li>
  );
}

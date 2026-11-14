"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { InfoTip } from "@/components/ds/InfoTip";
import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { NotInGt } from "@/components/simple/FeatureName";
import { fixChange, OP_WORDS, type BrokenLink, type FixOp } from "@/lib/simple-home";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, loadWaiting, onWaitingChanged, waitingChanged } from "@/lib/simple-waiting";

export type WaitingItem = Schemas["SimpleWaitingItem"];
type Waiting = Schemas["SimpleDecisionsWaitingOut"];

/**
 * home-waiting-one-list: everything that waits on me (GET /v1/simple/decisions/waiting `items`),
 * the one list Home's waiting cards, the Decisions page's "Waiting for you" and the rail read.
 * Read again whenever an action anywhere changed what waits (waitingChanged), so what I act on
 * leaves every page at once. undefined: not read yet.
 */
export function useWaitingList(): { data: Waiting | undefined; error: unknown; reload: () => void } {
  const [data, setData] = useState<Waiting | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => onWaitingChanged(() => setChanges((c) => c + 1)), []);
  // QA: a read begun before a change still lands while no later one has (never "Loading…" for
  // as long as the later read takes); an older answer never lands over a newer one.
  const shown = useRef(-1);
  useEffect(() => {
    let alive = true;
    const n = changes;
    const land = (apply: () => void) => {
      if (shown.current > n) return;
      shown.current = n;
      apply();
    };
    loadWaiting()
      // Review: a read begun before an action never lands after it (the action's own read does).
      .then((d) => alive && land(() => (setData(d), setError(null))))
      // counts-failed-part: a failed read drops what the last one read, so no out-of-date number
      // shows beside Could not load; a failure after a later change is left to the later read.
      .catch((e) => alive && land(() => (setData(undefined), setError(e))));
    return () => {
      alive = false;
    };
  }, [changes]);
  // counts-wait review: Try again on a failed read reads the list again.
  return { data, error, reload: () => setChanges((c) => c + 1) };
}

/**
 * simple-home-qa-nov12 #4: each roadmap item's code (F-06), by the item's id and by its open date
 * suggestion's id, from the roadmap read; shared by every row and read again when what waits changed.
 */
let codesHit: Promise<Map<string, string | null>> | null = null;
if (typeof window !== "undefined") onWaitingChanged(() => (codesHit = null));

function loadItemCodes(): Promise<Map<string, string | null>> {
  codesHit ??= unwrap(api.GET("/v1/simple/roadmap", {})).then((rm) => {
    // An item with no code is kept too (null): it is not in the Ground Truth.
    const codes = new Map<string, string | null>();
    for (const i of rm.items) {
      codes.set(i.id, i.code || null);
      if (i.suggestion) codes.set(i.suggestion.id, i.code || null);
    }
    return codes;
  });
  codesHit.catch(() => (codesHit = null));
  return codesHit;
}

/** A roadmap item's code by its id (or its date suggestion's id); null when it has none or is not read yet. */
export function useItemCode(id: string | null | undefined): string | null {
  return useItemCodeRead(id) ?? null;
}

/** A roadmap item's code; null when the roadmap has it with no code (not in the Ground Truth), undefined when unknown or not read yet. */
function useItemCodeRead(id: string | null | undefined): string | null | undefined {
  const [code, setCode] = useState<{ id: string; code: string | null | undefined } | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadItemCodes()
      .then((codes) => alive && setCode({ id, code: codes.get(id) }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return id && code?.id === id ? code.code : undefined;
}

/** The roadmap item a waiting row is about: a broken link's or a date's item (from its link). */
function itemOf(i: WaitingItem): string | null {
  if (i.kind === "broken_link") return i.ref_id;
  if (i.kind !== "date" && i.kind !== "proposal") return null;
  const q = i.href.indexOf("?");
  return q < 0 ? null : new URLSearchParams(i.href.slice(q + 1)).get("item");
}

type Act = { label: string; run: () => Promise<unknown>; done: string; primary?: boolean };

/** A decision-log call's Decide: its proposed option, then each other option. */
function decideActs(d: Schemas["DecisionOut"]): Act[] {
  if (d.can_decide === false || d.options.length < 2) return [];
  const proposed = d.options.find((o) => o.recommended) ?? d.options[0]!;
  return [proposed, ...d.options.filter((o) => o.key !== proposed.key)].map((o, n) => ({
    label: n === 0 ? `Decide: ${o.label}` : o.label,
    primary: n === 0,
    done: `Decided: ${o.label}`,
    run: () =>
      unwrap(
        api.POST("/v1/decisions/{decision}/decide", {
          params: { path: { decision: String(d.number) } },
          body: { option_key: o.key, rationale: `Decided in Simple: ${o.label}`, expected_outcome: o.summary || o.label, lock_version: d.lock_version },
        }),
      ),
  }));
}

/** The actions an item takes in place; a run stop and a broken link open where they are done. */
function actionsOf(i: WaitingItem): Act[] {
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
  if (i.kind === "goal") {
    const entity = { params: { path: { entity_id: i.ref_id } } };
    return [
      { label: "Confirm", primary: true, done: `${i.title} confirmed`, run: () => unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", entity)) },
      { label: "Not this", done: `${i.title} set aside`, run: () => unwrap(api.POST("/v1/baseline/entities/{entity_id}/reject", entity)) },
    ];
  }
  // A ritual that failed to prepare is prepared again in place, as the Inbox's row does.
  if (i.kind === "inbox" && i.key.startsWith("ritual:failed:")) {
    return [{ label: "Retry", primary: true, done: "Preparing it again", run: () => unwrap(api.POST("/v1/rituals/{ritual_id}/prepare", { params: { path: { ritual_id: i.ref_id } } })) }];
  }
  if (i.kind === "draft") {
    return [{ label: "Approve", primary: true, done: "Approved", run: () => unwrap(api.POST("/v1/simple/drafts/{draft_id}/approve", { params: { path: { draft_id: i.ref_id } } })) }];
  }
  return [];
}

/** What kind of thing waits, in plain words (Home's proposed goals read the same). */
export const WAITING_KIND: Record<WaitingItem["kind"], string> = {
  run_stop: "Run stop",
  question: "Decision",
  decision: "Decision",
  broken_link: "Broken link",
  date: "Dates to confirm",
  draft: "Roadmap draft",
  proposal: "Proposal on your item",
  goal_suggestion: "Goal suggestion",
  goal: "Proposed goal",
  inbox: "Inbox",
};

/**
 * simple-home-qa-nov12 #3: the list as rows, an item's broken links folded into one row (its
 * first link's place), as Home's broken-links card groups them; every other item is its own row.
 */
export function foldWaiting(items: WaitingItem[]): { key: string; item: WaitingItem; links?: WaitingItem[] }[] {
  const links = new Map<string, WaitingItem[]>();
  for (const i of items) if (i.kind === "broken_link") links.set(i.ref_id, [...(links.get(i.ref_id) ?? []), i]);
  return items.flatMap((i) => {
    if (i.kind !== "broken_link") return [{ key: i.key, item: i }];
    const all = links.get(i.ref_id)!;
    return all[0] === i ? [{ key: `broken_link:${i.ref_id}`, item: i, links: all }] : [];
  });
}

/**
 * One thing waiting on me, with its action in place (Accept / Decline, Confirm / Not this,
 * Approve, a decision-log call's Decide) or, for a run stop or a broken link, a link to where it
 * is done. Acting takes the row away at once and tells every page and the rail, which read the
 * list again, so it leaves everywhere at once.
 */
export function WaitingRow({ item, links }: { item: WaitingItem; links?: WaitingItem[] }) {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  // A broken-link row's breaks (one item's, folded); one fixed leaves the row with the others.
  const [fixed, setFixed] = useState<ReadonlySet<string>>(new Set());
  const breaks = item.kind === "broken_link" ? (links ?? [item]).filter((b) => !fixed.has(b.key)) : [];
  // A decision-log call decides in place with its options (GET /v1/decisions/{number}).
  const [call, setCall] = useState<Schemas["DecisionOut"] | null>(null);
  useEffect(() => {
    if (item.kind !== "decision") return;
    let alive = true;
    unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: item.ref_id } } }))
      .then((d) => alive && setCall(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item.kind, item.ref_id]);
  // A broken link fixes in place too, as Home's broken-links card does: "Fix the link" opens its
  // fixes (the item and its dependency read from the roadmap, as the change engine needs them).
  const [fixing, setFixing] = useState(false);
  const code = useItemCodeRead(itemOf(item));
  const acts = item.kind === "decision" ? (call ? decideActs(call) : []) : actionsOf(item);
  const act = async (run: () => Promise<unknown>, done: string, key?: string) => {
    setBusy(true);
    try {
      await run();
      if (key && breaks.length > 1) {
        setFixed((f) => new Set(f).add(key));
        setBusy(false);
      } else setGone(true);
      invalidateWaiting();
      waitingChanged();
      toast({ message: done });
    } catch (e) {
      toast({ message: errorMessage(e) });
      setBusy(false);
    }
  };
  if (gone) return null;
  // A broken link names its flags too; one item's broken links are one row that names each.
  const details = item.kind === "broken_link" ? breaks.map((b) => b.detail).filter(Boolean) : [];
  const name = `${WAITING_KIND[item.kind]}: ${item.title}${details.length ? `, ${details.join("; ")}` : ""}`;
  const detail = item.kind === "broken_link" ? details.join(" · ") : item.detail;
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0" data-testid="waiting-item" data-kind={item.kind} data-breaks={item.kind === "broken_link" ? breaks.length : undefined} aria-label={name}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words">
          <span className="text-text2">{WAITING_KIND[item.kind]} · </span>
          {code && <><code className="simple-code">{code}</code>{" "}</>}
          {item.title}
          {code === null && <NotInGt />}
          {/* port-AN 5: the row's why sits in its (i), so the one list stays one line a row. */}
          {detail && (
            <>
              {" "}
              <InfoTip label={item.title} testId="waiting-detail" align="start">
                {detail}
              </InfoTip>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 max-[600px]:w-full">
        {item.kind === "broken_link" ? (
          <button type="button" className="simple-button simple-button-primary" aria-expanded={fixing} onClick={() => setFixing((f) => !f)}>
            {item.action}
          </button>
        ) : acts.length ? (
          <>
            {acts.map((a) => (
              <button key={a.label} type="button" disabled={busy} className={`simple-button${a.primary ? " simple-button-primary" : ""}`} onClick={() => void act(a.run, a.done)}>
                {a.label}
              </button>
            ))}
            {/* An Inbox row acted on in place still opens where it lives (a failed ritual: Company › Rituals). */}
            {item.kind === "inbox" && (
              <Link href={item.href} className="simple-button">
                Open
              </Link>
            )}
          </>
        ) : (
          <Link href={item.href} className="simple-button simple-button-primary">
            {item.action}
          </Link>
        )}
      </div>
      {fixing &&
        breaks.map((b) => (
          // Each break with its own fixes; with two, each says which it is (its start or its end).
          <BrokenFixes key={b.key} item={b} named={breaks.length > 1} busy={busy} onFix={(run, done) => void act(run, done, b.key)} />
        ))}
    </li>
  );
}

const FIX_WORDS: Record<FixOp, string> = { shift_dependents: OP_WORDS.shift_dependents, move_dependency: OP_WORDS.move_dependency, accept_risk: "Accept as risk" };
const FIX_DONE: Record<FixOp, string> = { shift_dependents: "Dependents moved", move_dependency: "Dependency moved", accept_risk: "Risk accepted" };

/**
 * A broken-link row's fixes in place: Move the dependents, Move the dependency, Accept as risk
 * (with why, in one line), each a change through the engine, applied for its decider and
 * proposed ("Propose: …") for the others; and where it is on the Roadmap.
 */
function BrokenFixes({ item, named, busy, onFix }: { item: WaitingItem; named: boolean; busy: boolean; onFix: (run: () => Promise<unknown>, done: string) => void }) {
  const [link, setLink] = useState<BrokenLink | null | undefined>(undefined);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    // The row's key: broken_link:<item>:<flag kind>:<subject>.
    const [, itemId, kind, ...rest] = item.key.split(":");
    const subject = rest.join(":") || null;
    let alive = true;
    unwrap(api.GET("/v1/simple/roadmap", {}))
      .then((rm) => {
        const it = rm.items.find((i) => i.id === itemId);
        const flag = it?.flags.find((f) => f.kind === kind && (f.subject ?? null) === subject && f.state === "red");
        if (alive) setLink(it && flag ? { item: it, flag, dependency: subject ? rm.items.find((i) => i.id === subject) : undefined } : null);
      })
      .catch(() => alive && setLink(null));
    return () => {
      alive = false;
    };
  }, [item.key]);
  if (link === undefined) return <p className="simple-small basis-full">Loading its fixes…</p>;
  const roadmapLink = (
    <Link href={item.href} className="simple-button simple-button-quiet">
      Open it on the Roadmap
    </Link>
  );
  if (!link) return <div className="flex basis-full flex-wrap gap-2">{roadmapLink}</div>;
  const decides = link.item.can_decide;
  const label = (op: FixOp) => (decides ? FIX_WORDS[op] : `Propose: ${FIX_WORDS[op].charAt(0).toLowerCase()}${FIX_WORDS[op].slice(1)}`);
  const run = (op: FixOp, why = "") =>
    onFix(
      () => unwrap(api.POST("/v1/simple/changes", { body: fixChange(link, op, why) })),
      decides ? `${FIX_DONE[op]} in your working draft` : `${FIX_WORDS[op]} proposed`,
    );
  return (
    <div className="flex basis-full flex-col gap-2" data-testid="waiting-fixes">
      {named && item.detail && <span className="simple-small">{item.detail}</span>}
      <span className="flex flex-wrap items-center gap-2">
        {link.flag.fixes.includes("shift_dependents") && (
          <button type="button" className="simple-button" disabled={busy} onClick={() => run("shift_dependents")}>
            {label("shift_dependents")}
          </button>
        )}
        {link.flag.fixes.includes("move_dependency") && (
          <button type="button" className="simple-button" disabled={busy} onClick={() => run("move_dependency")}>
            {label("move_dependency")}
          </button>
        )}
        {link.flag.fixes.includes("accept_risk") && !noting && (
          <button type="button" className="simple-button" disabled={busy} onClick={() => setNoting(true)}>
            {label("accept_risk")}
          </button>
        )}
        {roadmapLink}
      </span>
      {noting && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) run("accept_risk", note.trim());
          }}
        >
          <input
            aria-label="Why the risk is acceptable"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it is acceptable, in one line"
            className="h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-text"
          />
          <button type="submit" className="simple-button simple-button-primary" disabled={busy || !note.trim()}>
            {label("accept_risk")}
          </button>
          <button type="button" className="simple-button simple-button-quiet" onClick={() => setNoting(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

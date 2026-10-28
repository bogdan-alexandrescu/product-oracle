"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/ds/Toast";
import { ChatCard } from "@/components/simple/chat/ChatCard";
import { api, unwrap } from "@/lib/api/client";
import { askSay, askThread, PENDING_POLL_MS, undoCard, walk, type ChatCard as Card, type ChatMessage, type WalkStep } from "@/lib/api/simple-chat";
import { beforeAfter, OP_WORDS } from "@/lib/simple-home";
import { errorMessage } from "@/lib/use-query";

/** What a step did, for Undo: an applied card or accepted proposal is undone; anything else goes back a step. */
type Done = { step: number; card?: string; change?: string };

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/**
 * "Walk me through it" (Simple S9): Home becomes a guided pass, one step at a time, over what
 * waits on the reader (GET /v1/simple/walk: broken links, the next meeting's agenda decisions,
 * proposals), answered by a click or by typing to Oracle; Undo, Skip and Done.
 */
export function Walk({ onDone }: { onDone: () => void }) {
  const [steps, setSteps] = useState<WalkStep[] | null>(null);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setSteps((await walk()).steps);
      setError(null);
    } catch (e) {
      setError(detail(e));
    }
  }, []);
  useEffect(() => {
    let live = true;
    walk()
      .then((w) => live && setSteps(w.steps))
      .catch((e) => live && setError(detail(e)));
    return () => {
      live = false;
    };
  }, []);

  const next = (d: Done) => {
    setDone((xs) => [...xs, d]);
    setAt((n) => n + 1);
  };

  async function undo() {
    const last = done[done.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      if (last.card) {
        await undoCard(last.card);
        toast({ message: "Undone" });
      } else if (last.change) {
        await unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: last.change } } }));
        toast({ message: "Undone" });
      }
      if (last.card || last.change) await load();
    } catch (e) {
      toast({ message: detail(e) });
    } finally {
      setDone((xs) => xs.slice(0, -1));
      setAt(last.step);
      setBusy(false);
    }
  }

  async function decide(step: WalkStep, action: "accept" | "decline") {
    setBusy(true);
    try {
      await unwrap(api.POST(`/v1/simple/changes/{change_id}/${action}`, { params: { path: { change_id: step.change!.id } }, body: {} }));
      toast({ message: action === "accept" ? "Accepted" : "Declined" });
      next({ step: at, change: action === "accept" ? step.change!.id : undefined });
    } catch (e) {
      toast({ message: detail(e) });
    } finally {
      setBusy(false);
    }
  }

  const step = steps?.[at];
  const total = steps?.length ?? 0;
  return (
    <section aria-label="Walk me through it" data-testid="walk" className="simple-card flex flex-col gap-4 max-[600px]:mb-[76px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="simple-h2">Walk me through it</h2>
        {steps && total > 0 && (
          <span className="simple-small tnum" data-testid="walk-progress">
            {Math.min(at + 1, total)} of {total}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        <button type="button" className="simple-button" disabled={busy || done.length === 0} onClick={() => void undo()}>
          Undo
        </button>
        {step && (
          <button type="button" className="simple-button" disabled={busy} onClick={() => next({ step: at })}>
            Skip
          </button>
        )}
        <button type="button" className="simple-button simple-button-primary ml-auto" onClick={onDone}>
          Done
        </button>
      </div>
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      {!steps && !error && <p className="simple-small">Loading what waits for you…</p>}
      {steps && total === 0 && (
        <p className="simple-small" data-testid="walk-empty">
          Nothing waits for you. You are up to date.
        </p>
      )}
      {steps && total > 0 && !step && (
        <p data-testid="walk-finished">That is everything for now.</p>
      )}
      {step && (
        <div key={`${step.id}-${at}`} data-testid="walk-step" data-kind={step.kind} className="flex flex-col gap-3">
          <p className="simple-small text-text2">{{ broken_link: "Broken link", agenda_decision: "On the next meeting's agenda", proposal: "Proposal waiting for you" }[step.kind]}</p>
          <p className="font-semibold" data-testid="walk-step-title">
            {step.title}
          </p>
          <p className="simple-small">{step.why}</p>
          {step.kind === "broken_link" && step.card && (
            <ChatCard
              card={step.card}
              onChanged={(c: Card) => {
                if (c.status === "applied" || c.status === "proposed") {
                  toast({ message: c.status === "applied" ? `Applied: ${c.summary}` : `Proposed: ${c.summary}` });
                  next({ step: at, card: c.status === "applied" ? c.id : undefined });
                }
              }}
            />
          )}
          {step.kind === "agenda_decision" && step.decision && (
            <div className="flex flex-wrap gap-2">
              <Link href={step.decision.url} className="simple-button">
                Open the decision
              </Link>
              <button type="button" className="simple-button simple-button-primary" onClick={() => next({ step: at })}>
                Next
              </button>
            </div>
          )}
          {step.kind === "proposal" && step.change && (
            <div className="flex flex-col gap-2">
              <p className="simple-small">
                {OP_WORDS[step.change.op] ?? "A change"}
                {(() => {
                  const ba = beforeAfter(step.change);
                  return ba ? `: ${ba.before} → ${ba.after}` : "";
                })()}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="simple-button simple-button-primary" disabled={busy} onClick={() => void decide(step, "accept")}>
                  Accept
                </button>
                <button type="button" className="simple-button" disabled={busy} onClick={() => void decide(step, "decline")}>
                  Decline
                </button>
              </div>
            </div>
          )}
          <TypeInstead />
        </div>
      )}
    </section>
  );
}

/** Answer by typing: the line goes to Oracle (the Ask thread); its reply and cards show here. */
function TypeInstead() {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await askSay(t, "/simple");
      let last = [...thread.messages].reverse().find((m) => m.author_kind === "oracle") ?? null;
      setReply(last);
      setText("");
      // chat-reader: a line Oracle's reader is still reading shows "Reading that…" until it is read.
      for (let n = 0; last?.kind === "pending" && n < 40; n++) {
        await new Promise((r) => window.setTimeout(r, PENDING_POLL_MS));
        const id = last.id;
        last = (await askThread()).messages.find((m) => m.id === id) ?? null;
        setReply(last);
      }
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="walk-type">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          aria-label="Or type what to do"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or type it: “move Weekly alert digest to Q2”"
          className="h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-text"
        />
        <button type="submit" className="simple-button" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      {reply && (
        <div className="flex flex-col gap-2" data-testid="walk-reply">
          <p className="simple-small">{reply.body}</p>
          {reply.cards.map((c) => (
            <ChatCard key={c.id} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}

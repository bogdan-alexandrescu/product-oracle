"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/ds/Toast";
import { ChatCard } from "@/components/simple/chat/ChatCard";
import { recommendsLine, type Question } from "@/components/simple/questions/Questions";
import { api, unwrap } from "@/lib/api/client";
import { askSay, askThread, PENDING_POLL_MS, undoCard, walk, type ChatCard as Card, type ChatMessage, type WalkStep } from "@/lib/api/simple-chat";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { beforeAfter, OP_WORDS } from "@/lib/simple-home";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, waitingChanged } from "@/lib/waiting";

/** What a step did, for Undo: an applied card or accepted proposal is undone; anything else goes back a step. `skipped`: Skip moved on. */
type Done = { step: number; card?: string; change?: string; skipped?: boolean };

/** A decision waiting for the reader (GET /v1/simple/decisions/waiting): a PRD's question, or another judgement call. */
type DecisionStep = { id: string; kind: "decision"; title: string; why: string; question: Question | null; url: string };
type Step = WalkStep | DecisionStep;

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

const KIND_WORDS: Record<Step["kind"], string> = {
  broken_link: "Broken link",
  decision: "Decision waiting for you",
  agenda_decision: "On a meeting's agenda",
  proposal: "Proposal waiting for you",
};

/** qa-simple-home-8: the type box's hint, short enough for a phone, as the step asks. */
const TYPE_HINT: Record<Step["kind"], string> = {
  broken_link: "Or type the fix",
  decision: "Or type your answer",
  agenda_decision: "Or type a note",
  proposal: "Or type what to do",
};

/** Home's "Next review meeting" (GET /v1/simple/meetings: Upcoming's first row). */
type NextMeeting = { ritual_title: string; due_at: string };

/** "1 decision", "5 broken links". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "a, b and c". */
const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * The walk's steps: the broken links (GET /v1/simple/walk), then the decisions waiting for the
 * reader, as Home counts them (GET /v1/simple/decisions/waiting: the PRDs' questions, late
 * first, then the other judgement calls), then the next meeting's agenda and the proposals.
 * A decision on the agenda is one step, the agenda's.
 */
/** A read's answer, or undefined when it failed. */
const settle = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

async function loadSteps(): Promise<{ steps: Step[]; meeting: NextMeeting | null }> {
  // The walk's own steps are the pass; a decisions read that fails leaves its steps out, never the whole walk.
  const [w, waitingR, inboxR, meetingsR] = await Promise.all([
    walk(),
    settle(unwrap(api.GET("/v1/simple/decisions/waiting"))),
    settle(loadInbox()),
    settle(unwrap(api.GET("/v1/simple/meetings"))),
  ]);
  const waiting = waitingR ?? { questions: [] as Question[] };
  const inbox = inboxR ?? { decisions: [] as Awaited<ReturnType<typeof loadInbox>>["decisions"] };
  const agenda = new Set(w.steps.flatMap((s) => (s.kind === "agenda_decision" && s.decision ? [s.decision.id] : [])));
  const questions = [...waiting.questions.filter((q) => q.late), ...waiting.questions.filter((q) => !q.late)].filter((q) => !agenda.has(q.id));
  const asked = new Set(waiting.questions.map((q) => q.id));
  const rows = inbox.decisions.filter((d) => d.counts && d.reason === "needs_decision" && !agenda.has(d.id) && !asked.has(d.id));
  // As Home's card: Oracle's run approvals are never product decisions, nor a PRD's question read twice.
  const others = (await Promise.all(rows.map((d) => settle(unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: String(d.number) } } }))))))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .filter((d) => d.class !== "checkpoint" && d.origin !== "checkpoint" && (d.origin as string) !== "prd");
  const decisions: DecisionStep[] = [
    ...questions.map((q) => ({
      id: `decision:${q.id}`,
      kind: "decision" as const,
      title: `${q.code} ${q.title}`,
      why: [q.due_label, q.blocks?.label, recommendsLine(q)].filter(Boolean).join(" · ") || `From ${q.prd.title}`,
      question: q,
      url: "/simple/decisions",
    })),
    ...others.map((d) => ({
      id: `decision:${d.id}`,
      kind: "decision" as const,
      title: d.title,
      why: d.question || "It waits for your decision.",
      question: null,
      // Where it can be decided, as Home's card for it opens: Simple's Decisions page only lists
      // a judgement call that is not a PRD's question (no Decide there).
      url: `/company/decisions?d=${d.number}`,
    })),
  ];
  const broken = w.steps.filter((s) => s.kind === "broken_link");
  return { steps: [...broken, ...decisions, ...w.steps.filter((s) => s.kind !== "broken_link")], meeting: meetingsR?.upcoming[0] ?? null };
}

/**
 * "Walk me through it" (Simple S9): Home becomes a guided pass, one step at a time, over what
 * waits on the reader (the broken links, the decisions waiting for them, the next meeting's
 * agenda, the proposals: loadSteps), answered by a click or by typing to Oracle; Undo (once a
 * step was answered or skipped), Skip and Done. Each step names its item once, says its
 * problem once, and its card holds just the actions.
 */
export function Walk({ onDone }: { onDone: () => void }) {
  const zone = useCompanyZone();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [meeting, setMeeting] = useState<NextMeeting | null>(null);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await loadSteps();
      setSteps(r.steps);
      setMeeting(r.meeting);
      setError(null);
    } catch (e) {
      setError(detail(e));
    }
  }, []);
  useEffect(() => {
    let live = true;
    loadSteps()
      .then((r) => {
        if (!live) return;
        setSteps(r.steps);
        setMeeting(r.meeting);
      })
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
      if (last.card || last.change) {
        invalidateWaiting();
        waitingChanged();
        await load();
      }
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

  /** A PRD's question decided as recommended (decide_question): applied with Undo, or proposed to its decider. */
  async function answer(q: Question) {
    setBusy(true);
    try {
      const r = await unwrap(
        api.POST("/v1/simple/changes", { body: { op: "decide_question", target: { decision_id: q.id }, before: { status: "proposed" }, after: { option: "recommended" } } }),
      );
      const c = r.change;
      toast({ message: c.status === "proposed" ? `Sent to ${q.decider?.name ?? "the owners"} to decide` : `Decided ${q.code}: ${q.recommendation}` });
      invalidateWaiting();
      waitingChanged();
      next({ step: at, change: c.status === "applied" && c.can_undo ? c.id : undefined });
    } catch (e) {
      toast({ message: detail(e) });
    } finally {
      setBusy(false);
    }
  }

  /** qa-simple-home-7: start again over what is left (the walk read afresh: what was decided is gone). */
  async function again() {
    setBusy(true);
    await load();
    setDone([]);
    setAt(0);
    setBusy(false);
  }

  const step = steps?.[at];
  const total = steps?.length ?? 0;
  // The steps whose last answer was Skip (Undo takes an answer back).
  const lastOf = new Map<number, Done>();
  for (const d of done) lastOf.set(d.step, d);
  const skipped = [...lastOf.values()].filter((d) => d.skipped).map((d) => steps?.[d.step]).filter((s): s is Step => !!s);
  const left = joinAnd(
    [
      count(skipped.filter((s) => s.kind === "decision" || s.kind === "agenda_decision").length, "decision", "decisions"),
      count(skipped.filter((s) => s.kind === "broken_link").length, "broken link", "broken links"),
      count(skipped.filter((s) => s.kind === "proposal").length, "proposal", "proposals"),
    ].filter((x) => !x.startsWith("0 ")),
  );
  // qa-simple-home-5: an agenda step names Home's "Next review meeting" (the same read, with its date) only when it is that meeting's.
  const agendaWords = (s: Step) =>
    meeting && s.why.includes(meeting.ritual_title)
      ? `On the agenda of the next review meeting, ${meeting.ritual_title}, ${formatInZone(meeting.due_at, zone, { weekday: "short", month: "short", day: "numeric" })}`
      : KIND_WORDS[s.kind];
  // Nothing to undo before a step was answered or skipped (the walk's first step).
  const canUndo = !busy && done.length > 0;
  return (
    <section aria-label="Walk me through it" data-testid="walk" className="simple-card flex flex-col gap-4 max-[600px]:mb-[76px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="simple-h2">Walk me through it</h2>
        {step && (
          <span className="simple-small tnum" data-testid="walk-progress">
            {Math.min(at + 1, total)} of {total}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-b border-line pb-3">
        <button type="button" className="simple-button disabled:cursor-not-allowed disabled:opacity-50" disabled={!canUndo} onClick={() => void undo()}>
          Undo
        </button>
        {step && (
          <button type="button" className="simple-button disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => next({ step: at, skipped: true })}>
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
        <div data-testid="walk-finished" className="flex flex-col gap-3">
          {skipped.length === 0 ? (
            <p>That is everything for now.</p>
          ) : (
            <>
              <p data-testid="walk-left">
                You skipped {skipped.length}. {left} still {skipped.length === 1 ? "waits" : "wait"}.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="simple-button" disabled={busy} onClick={() => void again()}>
                  Start again from the first skipped
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {step && (
        <div key={`${step.id}-${at}`} data-testid="walk-step" data-kind={step.kind} className="flex flex-col gap-3">
          <p className="simple-small text-text2" data-testid="walk-step-kind">
            {step.kind === "agenda_decision" ? agendaWords(step) : KIND_WORDS[step.kind]}
          </p>
          <p className="font-semibold" data-testid="walk-step-title">
            {step.title}
          </p>
          <p className="simple-small" data-testid="walk-step-why">
            {step.why}
          </p>
          {step.kind === "broken_link" && step.card && (
            <ChatCard
              card={step.card}
              actionsOnly
              onChanged={(c: Card) => {
                if (c.status === "applied" || c.status === "proposed") {
                  toast({ message: `${c.status === "applied" ? "Applied" : "Proposed"}: ${step.title}` });
                  next({ step: at, card: c.status === "applied" ? c.id : undefined });
                }
              }}
            />
          )}
          {step.kind === "decision" && (
            <div className="flex flex-wrap gap-2">
              {step.question?.recommendation && (step.question.can.decide || step.question.can.propose) && (
                <button type="button" className="simple-button simple-button-primary" disabled={busy} onClick={() => void answer(step.question!)}>
                  {step.question.can.decide ? "Decide" : "Propose"}: {step.question.recommendation}
                </button>
              )}
              <Link href={step.url} className="simple-button">
                Open the decision
              </Link>
            </div>
          )}
          {step.kind === "agenda_decision" && step.decision && (
            <div className="flex flex-wrap gap-2">
              <Link href={step.decision.url} className="simple-button">
                Open the decision
              </Link>
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
          <TypeInstead hint={TYPE_HINT[step.kind]} />
        </div>
      )}
    </section>
  );
}

/** Answer by typing: the line goes to Oracle (the Ask thread); its reply and cards show here. */
function TypeInstead({ hint }: { hint: string }) {
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
          placeholder={hint}
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

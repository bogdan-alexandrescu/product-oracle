"use client";

import { useState } from "react";

import { askOracle } from "@/components/hop/open-state";
import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

export type Question = Schemas["SimpleQuestion"];

/** What a decision on a question says: the PRD's recommendation, one of its alternatives, or the person's own words. */
export type Answer = { option: string } | { answer: string };

/**
 * prd-questions: a PRD's open questions read in as decisions, as Simple shows them on
 * Decisions (List and Board), Home and a review meeting's "Decisions due". Every write goes
 * through the change engine (decide_question, name_decider) under the person's own rights,
 * which the question's `can` says: decide (applies, with Undo), propose (sent to the decider),
 * neither (read only).
 */
export function useQuestionActions(onDone: () => unknown, sessionId?: string | null) {
  const [busy, setBusy] = useState(false);
  const done = () => {
    invalidateWaiting();
    void onDone();
    waitingChanged();
  };
  const run = async (body: Schemas["SimpleChangeIn"], applied: string, proposedTo: string) => {
    setBusy(true);
    try {
      const r = await unwrap(api.POST("/v1/simple/changes", { body: sessionId ? { ...body, session_id: sessionId } : body }));
      const c = r.change;
      if (c.status === "proposed") toast({ message: `Sent to ${proposedTo} to decide` });
      else
        toast(
          c.can_undo
            ? {
                message: applied,
                action: {
                  label: "Undo",
                  onClick: () =>
                    void unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: c.id } } }))
                      .then(() => toast({ message: "Undone" }))
                      .catch((e) => toast({ message: errorMessage(e) }))
                      .finally(done),
                },
              }
            : { message: applied },
        );
    } catch (e) {
      toast({ message: errorMessage(e) });
    } finally {
      setBusy(false);
      done();
    }
  };
  const decide = (q: Question, a: Answer) => {
    const words = "option" in a ? (a.option === "recommended" ? q.recommendation : q.alternatives.find((o) => o.key === a.option)?.label) : a.answer;
    return run(
      { op: "decide_question", target: { decision_id: q.id }, before: { status: "proposed" }, after: a },
      `Decided ${q.code}: ${words ?? "your answer"}`,
      q.decider?.name ?? "the owners",
    );
  };
  const nameDecider = (q: Question, person: { id: string; name: string }) =>
    run(
      { op: "name_decider", target: { decision_id: q.id }, before: { decider_id: q.decider?.id ?? null }, after: { decider_id: person.id } },
      `${person.name} decides ${q.code}`,
      q.decider?.name ?? "the owners",
    );
  return { busy, decide, nameDecider };
}

/** "Ask Oracle" on a question: Simple's Ask panel opens with the question in its box. */
export function askAbout(q: Question) {
  askOracle(`${q.code} ${q.title} in ${q.prd.title}: what should we decide?${q.recommendation ? ` The PRD recommends: ${q.recommendation}.` : ""}`);
}

/** "Late · due Fri 6 Nov" in the late tone, "Due Fri 27 Nov" plain. */
export function DueLabel({ q }: { q: Question }) {
  if (!q.due_label) return null;
  return (
    <span data-testid="question-due" data-late={q.late ? "true" : undefined} className={q.late ? "simple-status simple-status-risk" : "simple-small tnum"}>
      {q.due_label}
    </span>
  );
}

/** The question's alternatives and "Something else..." (a text field and Decide). */
export function AnotherAnswer({ q, busy, onPick }: { q: Question; busy: boolean; onPick: (a: Answer) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const verb = q.can.decide ? "Decide" : "Propose";
  return (
    <div role="group" aria-label={`Answers for ${q.code}`} data-testid="question-answers" className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {q.alternatives.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={false} disabled={busy} className="simple-button" onClick={() => onPick({ option: o.key })}>
            {o.label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={other} disabled={busy} className="simple-button" onClick={() => setOther(true)}>
          Something else...
        </button>
      </div>
      {other && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onPick({ answer: text.trim() });
          }}
        >
          <input
            aria-label={`Your answer to ${q.code}`}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer, in one line"
            className="h-11 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-text"
          />
          <button type="submit" className="simple-button simple-button-primary" disabled={busy || !text.trim()}>
            {verb}
          </button>
        </form>
      )}
    </div>
  );
}

/** Pick a person (the members Simple's meetings list) to name as the question's decider. */
export function PersonPicker({
  q,
  busy,
  onPick,
  onClose,
  verb = "decides",
}: {
  q: Question;
  busy: boolean;
  onPick: (p: { id: string; name: string }) => void;
  onClose: () => void;
  /** "answers": the person named gives the answer the PRD does not recommend yet (and decides it). */
  verb?: "decides" | "answers";
}) {
  const members = useQuery("simple-question-members", () => unwrap(api.GET("/v1/simple/meetings/options")).then((o) => o.members));
  return (
    <div role="group" aria-label={`Who ${verb} ${q.code}`} data-testid="question-people" className="mt-2 flex flex-col gap-2">
      <span className="simple-small">
        Who {verb} {q.code}?
      </span>
      {members.error && <span className="simple-small text-crit">{members.error}</span>}
      {!members.data && !members.error && <span className="simple-small">Loading people…</span>}
      <div className="flex flex-wrap gap-2">
        {(members.data ?? []).map((m) => (
          <button key={m.id} type="button" disabled={busy} className="simple-button" onClick={() => onPick(m)}>
            {m.name}
          </button>
        ))}
        <button type="button" className="simple-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Mode = "list" | "needs_input" | "recommended" | "decided" | "due";

/**
 * One question as a row: "<code> <title>", the due label, what it blocks, what the PRD
 * recommends, and the buttons the person's rights allow for where it is shown (`mode`):
 * the List's Decide as recommended / Another answer / Ask Oracle, the Board's column actions,
 * a meeting's Decide as recommended.
 */
export function QuestionRow({
  q,
  mode,
  actions,
  as: Tag = "li",
}: {
  q: Question;
  mode: Mode;
  actions: ReturnType<typeof useQuestionActions>;
  as?: "li" | "div";
}) {
  const [open, setOpen] = useState<"answers" | "people" | "answerer" | null>(null);
  const { busy, decide, nameDecider } = actions;
  const writes = q.can.decide || q.can.propose;
  const verb = q.can.decide ? "Decide" : "Propose";
  const toggle = (what: "answers" | "people" | "answerer") => setOpen((o) => (o === what ? null : what));
  const recommended = !!q.recommendation && writes && q.column !== "decided";
  return (
    <Tag data-testid="question-row" data-code={q.code} aria-label={`${q.code} ${q.title}`} className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-semibold break-words">
          <span className="simple-code">{q.code}</span> {q.title}
        </span>
        {mode === "decided" || q.column === "decided" ? (
          <span className="simple-small">{q.decided_label}</span>
        ) : (
          <DueLabel q={q} />
        )}
      </div>
      {q.blocks && <span className="simple-small">{q.blocks.label}</span>}
      {q.column === "decided" ? (
        q.chosen && <span>Decided: {q.chosen}</span>
      ) : q.recommendation ? (
        <span>PRD recommends: {q.recommendation}</span>
      ) : (
        <span className="simple-small">No recommendation in the PRD yet.</span>
      )}
      {q.column !== "decided" && (
        <span className="simple-small">{q.decider ? `${q.decider.name} decides` : "No decider yet"}</span>
      )}
      {q.pending && (
        <span className="simple-small" data-testid="question-pending">
          {q.pending.by.name} proposed: {q.pending.answer}
        </span>
      )}
      {q.column !== "decided" && (
        <div className="simple-actions mt-1 flex flex-wrap gap-2">
          {mode === "list" && (
            <>
              {recommended && (
                <button type="button" disabled={busy} className="simple-button simple-button-primary" onClick={() => void decide(q, { option: "recommended" })}>
                  {verb} as recommended
                </button>
              )}
              {writes && (
                <button type="button" aria-expanded={open === "answers"} className="simple-button" onClick={() => toggle("answers")}>
                  Another answer
                </button>
              )}
              <AskButton q={q} />
            </>
          )}
          {mode === "due" && recommended && (
            <button type="button" disabled={busy} className="simple-button simple-button-primary" onClick={() => void decide(q, { option: "recommended" })}>
              {verb} as recommended
            </button>
          )}
          {mode === "recommended" && writes && (
            <>
              <button type="button" disabled={busy} className="simple-button simple-button-primary" onClick={() => void decide(q, { option: "recommended" })}>
                {q.can.decide ? "Accept" : "Propose"}
              </button>
              <button type="button" aria-expanded={open === "answers"} className="simple-button" onClick={() => toggle("answers")}>
                Change
              </button>
            </>
          )}
          {mode === "needs_input" && (
            <>
              {q.missing === "decider" && q.can.name_decider && (
                <button type="button" aria-expanded={open === "people"} className="simple-button simple-button-primary" onClick={() => toggle("people")}>
                  Name a decider
                </button>
              )}
              {q.missing === "recommendation" && writes && (
                <button type="button" aria-expanded={open === "answerer"} className="simple-button simple-button-primary" onClick={() => toggle("answerer")}>
                  Name a person
                </button>
              )}
              <AskButton q={q} />
            </>
          )}
        </div>
      )}
      {open === "answers" && (
        <AnotherAnswer
          q={q}
          busy={busy}
          onPick={(a) => {
            setOpen(null);
            void decide(q, a);
          }}
        />
      )}
      {(open === "people" || open === "answerer") && (
        <PersonPicker
          q={q}
          busy={busy}
          verb={open === "answerer" ? "answers" : "decides"}
          onClose={() => setOpen(null)}
          onPick={(p) => {
            setOpen(null);
            void nameDecider(q, p);
          }}
        />
      )}
    </Tag>
  );
}

function AskButton({ q }: { q: Question }) {
  return (
    <button type="button" className="simple-button" onClick={() => askAbout(q)}>
      Ask Oracle
    </button>
  );
}

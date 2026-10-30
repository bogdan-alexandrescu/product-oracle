"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/ds/Icon";
import { askWith } from "@/components/hop/open-state";
import { toast } from "@/components/ds/Toast";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
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
  /** A meeting's agenda: Undo on a question decided in it (its change, while the meeting runs). */
  const undo = async (changeId: string) => {
    setBusy(true);
    try {
      await unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: changeId } } }));
      toast({ message: "Undone" });
    } catch (e) {
      toast({ message: errorMessage(e) });
    } finally {
      setBusy(false);
      done();
    }
  };
  return { busy, decide, nameDecider, undo };
}

/** "Ask Oracle" on a question: Simple's Ask panel opens with the question in its box. */
export function askAbout(q: Question) {
  askWith(`${q.code} ${q.title} in ${q.prd.title}: what should we decide?${q.recommendation ? ` The PRD recommends: ${q.recommendation}.` : ""}`);
}

/** "Late · due Fri Oct 23" in the late tone, "Due Fri Nov 13" quiet: a chip, as the mock-up draws it. */
export function DueLabel({ q }: { q: Question }) {
  if (!q.due_label) return null;
  return (
    <span data-testid="question-due" data-late={q.late ? "true" : undefined} className={`simple-status tnum ${q.late ? "simple-status-risk" : "simple-status-quiet"}`}>
      {q.due_label}
    </span>
  );
}

/** "Guided setup draft 3": the PRD version the questions were read from ("3 PRDs" when several). */
export function sourceName(questions: Question[]): string | null {
  if (questions.length === 0) return null;
  const prds = new Set(questions.map((q) => q.prd.id));
  if (prds.size > 1) return `${prds.size} PRDs`;
  const versions = new Set(questions.map((q) => q.source?.version ?? null));
  const v = versions.size === 1 ? questions[0]!.source?.version : null;
  return `${questions[0]!.prd.title}${v ? ` draft ${v}` : ""}`;
}

/** qa-simple-decide-18: "Questions from the Guided setup PRD (draft 3), checked Oct 22": where and when the questions shown were read. */
export function useSourceLine(questions: Question[]): string | null {
  const zone = useCompanyZone();
  if (questions.length === 0) return null;
  const prds = new Set(questions.map((q) => q.prd.id));
  const versions = new Set(questions.map((q) => q.source?.version ?? null));
  const v = versions.size === 1 ? questions[0]!.source?.version : null;
  const name = prds.size > 1 ? `${prds.size} PRDs` : `the ${questions[0]!.prd.title} PRD${v ? ` (draft ${v})` : ""}`;
  const reads = questions.map((q) => q.source?.read_at).filter((x): x is string => !!x).sort();
  const last = reads.at(-1);
  return `Questions from ${name}${last ? `, checked ${formatInZone(last, zone, { month: "short", day: "numeric" })}` : ""}`;
}

/** The question's alternatives as chips and "Something else…" (a text field and Decide). */
export function AnotherAnswer({ q, busy, onPick }: { q: Question; busy: boolean; onPick: (a: Answer) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const verb = q.can.decide ? "Decide" : "Propose";
  return (
    <div data-testid="question-answers" className="mt-1.5 flex flex-col">
      <span className="simple-meta">Another answer:</span>
      <div role="group" aria-label={`Answers for ${q.code}`} className="simple-chips">
        {q.alternatives.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={false} disabled={busy} className="simple-chip" onClick={() => onPick({ option: o.key })}>
            {o.label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={other} disabled={busy} className="simple-chip simple-chip-dashed" onClick={() => setOther(true)}>
          Something else…
        </button>
      </div>
      {other && (
        <form
          className="mt-2 flex flex-wrap gap-2"
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
            className="h-10 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-bg px-3 text-[16px] text-text"
          />
          <button type="submit" className="simple-button simple-button-primary" disabled={busy || !text.trim()}>
            {verb}
          </button>
        </form>
      )}
    </div>
  );
}

/** GET /v1/people's page size for the decider picker. */
const DECIDERS_PAGE = 200;

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
  // qa-simple-decide-9: the API lists the people who may decide, page by page, however many the company has.
  const members = useQuery("simple-question-deciders", async () => {
    const out: { id: string; name: string }[] = [];
    for (;;) {
      const rows = await unwrap(api.GET("/v1/people", { params: { query: { decides: true, limit: DECIDERS_PAGE, offset: out.length } } }));
      out.push(...rows.map((p) => ({ id: p.user_id, name: p.name })));
      if (rows.length < DECIDERS_PAGE) return out;
    }
  });
  // The picker replaces the button that opened it (qa-simple-decide-30): the focus moves into it.
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => group.current?.focus(), []);
  return (
    <div ref={group} tabIndex={-1} role="group" aria-label={`Who ${verb} ${q.code}`} data-testid="question-people" className="mt-1.5 flex flex-col outline-none">
      <span className="simple-meta">
        Who {verb} {q.code}? Only the people who may decide are listed.
      </span>
      {members.error && <span className="simple-meta text-crit">{members.error}</span>}
      {!members.data && !members.error && <span className="simple-meta">Loading people…</span>}
      <div className="simple-chips">
        {/* qa-simple-decide-16: the current decider is marked and cannot be picked again. */}
        {(members.data ?? []).map((m) =>
          m.id === q.decider?.id ? (
            <button key={m.id} type="button" disabled className="simple-chip" data-testid="question-people-current">
              Already {m.name}
            </button>
          ) : (
            <button key={m.id} type="button" disabled={busy} className="simple-chip" onClick={() => onPick(m)}>
              {m.name}
            </button>
          ),
        )}
        <button type="button" className="simple-chip simple-chip-dashed" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Mode = "list" | "needs_input" | "recommended" | "decided" | "due";

/**
 * One question as the mock-up's row (option A): the round flag icon; "<code> <title>"; the
 * due chip and what it blocks; "PRD recommends" and its words; then, in a right-hand column
 * (under the row on a phone or in a Board column), the buttons the person's rights allow where
 * it is shown (`mode`): List, Home and a meeting's agenda ("due") have Decide as recommended,
 * Another answer (the alternatives as chips under the row) and Ask Oracle; the Board's columns
 * their own. A question decided in a meeting stays on its agenda, with Undo for who decided it.
 */
export function QuestionRow({
  q,
  mode,
  actions,
  as: Tag = "li",
  testId = "question-row",
  forOthers = false,
}: {
  q: Question;
  mode: Mode;
  actions: ReturnType<typeof useQuestionActions>;
  as?: "li" | "div";
  testId?: string;
  /** Listed under "Waiting for others": an owner's Decide is an override for the decider. */
  forOthers?: boolean;
}) {
  const zone = useCompanyZone();
  const { me } = useMe();
  const [open, setOpen] = useState<"answers" | "people" | "answerer" | null>(null);
  const { busy, decide, nameDecider, undo } = actions;
  const writes = q.can.decide || q.can.propose;
  const verb = q.can.decide ? "Decide" : "Propose";
  const toggle = (what: "answers" | "people" | "answerer") => setOpen((o) => (o === what ? null : what));
  // Cancel in a picker gives the focus back to the button it replaced.
  const nameRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"people" | "answerer" | null>(null);
  useEffect(() => {
    if (!refocus.current || open) return;
    (refocus.current === "people" ? nameRef : askRef).current?.focus();
    refocus.current = null;
  }, [open]);
  const done = q.column === "decided" || mode === "decided";
  const recommended = !!q.recommendation && writes && !done;
  const at = q.decided_at ? formatInZone(q.decided_at, zone, { hour: "numeric", minute: "2-digit" }) : null;
  // qa-simple-decide-44: the answer itself, not "as recommended".
  const here = [`Decided in this meeting${q.chosen ? `: ${q.chosen}` : ""}`, q.decided_by?.name, at].filter(Boolean).join(" · ");
  const another = (label: string) => (
    <button type="button" aria-pressed={open === "answers"} aria-expanded={open === "answers"} className="simple-button" onClick={() => toggle("answers")}>
      {label}
    </button>
  );
  // qa-simple-decide-8: the same verbs and the same actions for a question in every view
  // (List, Board, Home, a meeting's agenda); one primary button per row (qa-simple-decide-24).
  let buttons: ReactNode = null;
  if (done) {
    if (mode === "due" && q.undo_id)
      buttons = (
        <button type="button" disabled={busy} className="simple-button" onClick={() => void undo(q.undo_id!)}>
          Undo
        </button>
      );
  } else {
    const nameIt = q.missing === "decider" && q.can.name_decider;
    const askSomeone = q.missing === "recommendation" && writes;
    // qa-simple-decide-14: someone else's call (an owner may still decide it): secondary, and it says for whom.
    const forOther = forOthers && q.can.decide && !!q.decider && q.decider.id !== me?.user_id;
    // qa-simple-decide-17: your proposal is sent: no second one.
    const proposed = !q.can.decide && !!q.pending && q.pending.by.id === me?.user_id;
    const primary = recommended && open !== "answers" && !proposed;
    buttons = (
      <>
        {proposed && (
          <button type="button" disabled className="simple-button" data-testid="question-proposed">
            Proposed · waiting for {q.decider?.name ?? "the decider"}
          </button>
        )}
        {primary && (
          <button type="button" disabled={busy} className={`simple-button ${forOther ? "" : "simple-button-primary"}`} onClick={() => void decide(q, { option: "recommended" })}>
            {forOther ? `Decide for ${q.decider!.name}` : `${verb} as recommended`}
          </button>
        )}
        {/* qa-simple-decide-15: the primary action on top, then Another answer. */}
        {writes && !proposed && !(!primary && (nameIt || askSomeone)) && another("Another answer")}
        {nameIt && open !== "people" && (
          <button type="button" ref={nameRef} className={`simple-button ${primary || open === "answers" ? "" : "simple-button-primary"}`} onClick={() => toggle("people")}>
            Name a decider
          </button>
        )}
        {askSomeone && open !== "answerer" && (
          <button type="button" ref={askRef} className={`simple-button ${primary || open === "answers" ? "" : "simple-button-primary"}`} onClick={() => toggle("answerer")}>
            Ask someone to answer
          </button>
        )}
        {writes && !proposed && !primary && (nameIt || askSomeone) && another("Another answer")}
        <AskButton q={q} />
      </>
    );
  }
  return (
    <Tag data-testid={testId} data-code={q.code} aria-label={`${q.code} ${q.title}`} className="simple-row">
      <span aria-hidden className={`simple-ico ${done ? "simple-ico-done" : ""}`}>
        <Icon name={done ? "check" : "flag"} size={20} stroke={1.7} />
      </span>
      <div className="simple-rb">
        <span className="break-words">
          <span className="simple-code">{q.code}</span> <b className="font-[650]">{q.title}</b>
        </span>
        {done ? (
          <span className="simple-meta" data-testid="question-decided">
            {mode === "due" ? here : q.decided_label}
          </span>
        ) : (
          (q.due_label || q.blocks) && (
            <span className="simple-meta">
              <DueLabel q={q} />
              {q.due_label && q.blocks ? " · " : ""}
              {q.blocks?.label}
            </span>
          )
        )}
        {done ? (
          mode !== "due" &&
          q.chosen && (
            <span className="simple-rec">
              <span className="simple-rec-label">Decided</span>{" "}
              {q.chosen}
            </span>
          )
        ) : q.recommendation ? (
          <span className="simple-rec">
            <span className="simple-rec-label">PRD recommends</span>{" "}
            {q.recommendation}
          </span>
        ) : (
          <span className="simple-meta">No recommendation in the PRD yet.</span>
        )}
        {!done && !q.waiting_for_me && <span className="simple-meta">{q.decider ? `${q.decider.name} decides` : "No decider yet"}</span>}
        {q.pending && (
          <span className="simple-meta" data-testid="question-pending">
            {q.pending.by.name} proposed: {q.pending.answer}
          </span>
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
            onClose={() => {
              refocus.current = open === "answerer" ? "answerer" : "people";
              setOpen(null);
            }}
            onPick={(p) => {
              setOpen(null);
              void nameDecider(q, p);
            }}
          />
        )}
      </div>
      {/* qa-simple-decide-15: the same column width on every List and agenda row. */}
      {buttons && <div className={`simple-actions ${mode === "list" || mode === "due" ? "min-[601px]:w-[232px]" : ""}`}>{buttons}</div>}
    </Tag>
  );
}

/** Ask Oracle on a question: the quiet button with the ask icon; Simple's Ask panel opens with it in its box. */
function AskButton({ q }: { q: Question }) {
  return (
    <button type="button" className="simple-button simple-button-quiet" onClick={() => askAbout(q)}>
      <Icon name="ask" size={18} stroke={1.7} />
      Ask Oracle
    </button>
  );
}

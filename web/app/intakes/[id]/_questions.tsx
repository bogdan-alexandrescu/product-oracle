"use client";

import { useEffect, useState } from "react";

import { AnswerQuestion, type InboxQuestion } from "@/components/AnswerQuestion";
import { Avatar, Button, Chip, Empty, InfoTip, Mark, Panel, SegmentedControl } from "@/components/ds";
import { PersonPicker, findPeople, peopleByIds, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, SELECT, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe, type Role } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";

import { DecideForm, mayReview } from "./_inspector";
import { CATEGORY_LABEL, NON_ANSWER, dayMonth, knowledgeLabel, when, type Batch, type Card, type Summary } from "./_lib";

type Me = { id: string | null; role: Role | null };
type People = ReadonlyMap<string, Person>;
type Message = Schemas["InterviewMessageOut"];
type Turn = (questionId: string, body: string | null, skip: boolean) => Promise<boolean>;

/** C3 team follow-ups: "Oracle follows up" is on unless this person turned it off. */
const FOLLOW_UP_KEY = "po-interview-follow-up";
/** Oracle's note when it records an answer: the answer bubble already shows it. */
const RECORDED = "Answer recorded.";

/** This question's messages since Oracle last recorded an answer to it. */
function openRound(messages: Message[]): Message[] {
  return messages.slice(messages.map((m) => m.kind).lastIndexOf("closing") + 1);
}

/** One of Oracle's interview messages: a follow-up, or the note that it could not follow up. */
function OracleBubble({ message, testId }: { message: Message; testId: string }) {
  return (
    <div data-testid={testId} className="ml-10 flex min-w-0 gap-2.5 max-[600px]:ml-4">
      <span aria-hidden className="grid size-8 flex-none place-items-center rounded-full bg-hero text-hero-text">
        <Mark size={16} />
      </span>
      <p className="min-w-0 flex-1 rounded-panel rounded-tl-sm border border-line bg-surface px-3 py-2 text-[15px] leading-[22px] break-words text-text">
        {message.body}
      </p>
    </div>
  );
}

/** What the person wrote before Oracle's follow-up, not recorded yet. */
function PendingBubble({ message }: { message: Message }) {
  return (
    <div data-testid="pending-answer" className="ml-10 flex min-w-0 gap-2.5 max-[600px]:ml-4">
      <Avatar name="You" tone="me" />
      <p className="min-w-0 flex-1 rounded-panel rounded-tl-sm border border-line bg-accent-soft/40 px-3 py-2 text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">
        {message.body}
      </p>
    </div>
  );
}

/** Reply to Oracle's follow-up, or record the answer as written. */
function FollowUpReply({ onTurn }: { onTurn: (body: string | null, skip: boolean) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go(skip: boolean) {
    if (!skip && !body.trim()) {
      setError("Write your reply first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onTurn(skip ? null : body.trim(), skip);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-panel border border-line bg-surface p-3">
      <label className={FIELD_LABEL}>
        Your reply
        <textarea rows={2} maxLength={4000} value={body} autoFocus onChange={(e) => setBody(e.target.value)} className={TEXTAREA} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="solid" disabled={busy} onClick={() => go(false)}>
          Reply
        </Button>
        <Button disabled={busy} onClick={() => go(true)}>
          Skip, record my answer
        </Button>
      </div>
    </div>
  );
}

/** A person's name, "you" for the reader. */
function nameOf(people: People, me: Me, id: string | null | undefined): string {
  if (!id) return "someone";
  if (id === me.id) return "you";
  return people.get(id)?.name ?? "someone";
}

/** The question as the shared answer form reads it (C2): Oracle asks, about this brief. */
function asInbox(card: Card, s: Summary): InboxQuestion {
  return {
    question: card.question,
    asked_by: { kind: "oracle" },
    subject: { kind: "intake", title: `Before drafting · ${s.intake.title}`, href: null },
    gap: card.gap,
    answer_paths: card.question.gap_id ? card.answer_paths : card.answer_paths.filter((p) => p !== "research"),
  };
}

/** An answer as a bubble from its author: when, and what it is worth (a decision, a fact, a guess). */
function AnswerBubble({ answer, people, me }: { answer: Card["answers"][number]; people: People; me: Me }) {
  const mine = answer.answered_by === me.id;
  const who = mine ? "You" : (people.get(answer.answered_by ?? "")?.name ?? "Someone");
  const kind = answer.kind === "answer" && answer.knowledge_state !== "unknown" ? (answer.knowledge_state === "user_decision" ? "pass" : "acc") : "na";
  return (
    <div data-testid="answer" className="ml-10 flex min-w-0 gap-2.5 max-[600px]:ml-4">
      <Avatar name={who} tone={mine ? "me" : "default"} />
      <div className="min-w-0 flex-1 rounded-panel rounded-tl-sm border border-line bg-accent-soft/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text2">
          <span className="font-semibold text-text">{who}</span>
          <time dateTime={answer.created_at}>{when(answer.created_at)}</time>
          <Chip kind={kind}>{knowledgeLabel(answer, mine, who)}</Chip>
        </div>
        <p className="mt-1 text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">
          {answer.kind === "answer"
            ? answer.body
            : answer.kind === "delegate"
              ? `Asked ${people.get(answer.delegated_to ?? "")?.name ?? "someone else"} instead`
              : NON_ANSWER[answer.kind]}
        </p>
      </div>
    </div>
  );
}

/** One of Oracle's questions in the thread, with what can be done about it now. */
function QuestionBubble({
  card,
  summary: s,
  people,
  me,
  onChanged,
  transcript,
  onTurn,
  focus,
}: {
  card: Card;
  summary: Summary;
  people: People;
  me: Me;
  onChanged: () => void;
  /** This question's messages in my team interview (C3). */
  transcript: Message[];
  /** Send answer goes through my team interview's turn ("Oracle follows up" on). */
  onTurn?: Turn;
  /** Oracle moved here after recording the previous answer: open the answer form. */
  focus: boolean;
}) {
  const q = card.question;
  const gap = card.gap;
  const [mode, setMode] = useState<"answer" | "review" | "reassign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [focused, setFocused] = useState(false);
  if (focus !== focused) {
    setFocused(focus);
    if (focus) setMode("answer");
  }
  const round = openRound(transcript);
  const waiting = round.some((m) => m.kind === "follow_up");

  async function turn(body: string | null, skip: boolean): Promise<boolean> {
    if (!onTurn) return false;
    setThinking(true);
    try {
      const recorded = await onTurn(q.id, body, skip);
      setMode(null);
      return recorded;
    } finally {
      setThinking(false);
    }
  }
  const open = q.status === "asked" || q.status === "delegated";
  const mine = q.asked_to === me.id;
  const { can } = useMe();
  // #370: who asked and the intake's author may move a question; at the handler's role
  // (approver), anyone may, and may answer a question asked of someone else.
  const mayMove = can("update_question", q.asked_by === me.id || s.intake.author_id === me.id);
  const mayAnswer = can("answer_question", mine || can("update_question"));
  const waitingReview = gap?.status === "answered_pending_review";

  async function reassign(p: Person) {
    setError(null);
    try {
      await unwrap(api.PATCH("/v1/questions/{question_id}", { params: { path: { question_id: q.id } }, body: { asked_to: p.user_id } }));
      setMode(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flex min-w-0 flex-col gap-2" data-testid="question">
      <div className="flex min-w-0 gap-2.5">
        <span aria-hidden className="grid size-8 flex-none place-items-center rounded-full bg-hero text-hero-text">
          <Mark size={16} />
        </span>
        <article aria-label={q.prompt} className="min-w-0 flex-1 rounded-panel rounded-tl-sm border border-line bg-surface px-3 py-2.5 shadow-panel">
          <p className="text-[15px] leading-[22px] font-semibold break-words text-text">{q.prompt}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-text2">
            <Chip kind="line">{q.category === "general" ? "Question" : CATEGORY_LABEL[q.category]}</Chip>
            {gap?.importance === "critical" && <Chip kind="crit">Critical</Chip>}
            {q.rationale && (
              <span className="inline-flex items-center gap-1">
                Why Oracle asks
                <InfoTip label="why Oracle asks" align="start">
                  {q.rationale}
                </InfoTip>
              </span>
            )}
            <span data-testid="asked-to">{mine ? "Asked you" : `Asked ${nameOf(people, me, q.asked_to)}`}</span>
            {q.status === "deferred" && <Chip kind="na">Deferred</Chip>}
            {q.status === "researching" && <Chip kind="acc">Being researched</Chip>}
            {q.status === "retired" && <Chip kind="na">Retired</Chip>}
          </div>
        </article>
      </div>
      {transcript.map((m) =>
        m.kind === "follow_up" ? (
          <OracleBubble key={m.id} message={m} testId="follow-up" />
        ) : m.kind === "closing" && m.body !== RECORDED ? (
          <OracleBubble key={m.id} message={m} testId="oracle-note" />
        ) : waiting && m.kind === "answer" && round.includes(m) ? (
          <PendingBubble key={m.id} message={m} />
        ) : null,
      )}
      {card.answers.map((a) => (
        <AnswerBubble key={a.id} answer={a} people={people} me={me} />
      ))}
      {thinking && (
        <p data-testid="oracle-typing" role="status" className="ml-10 text-sm text-text2 max-[600px]:ml-4">
          Oracle is thinking…
        </p>
      )}
      <div className="ml-10 flex min-w-0 flex-col gap-2 max-[600px]:ml-4">
        {waitingReview && gap && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip kind="warn" dot>
              Waiting for review
            </Chip>
            {mayReview(can, gap) && mode !== "review" && <Button onClick={() => setMode("review")}>Review</Button>}
          </div>
        )}
        {mode === "review" && gap && (
          <DecideForm
            gap={gap}
            choices={[{ value: "validate", label: "Validate" }]}
            submit="Validate"
            onCancel={() => setMode(null)}
            onDone={() => {
              setMode(null);
              onChanged();
            }}
          />
        )}
        {open && waiting && onTurn && !thinking && <FollowUpReply onTurn={turn} />}
        {open && !waiting && (
          <div className="flex flex-wrap items-center gap-2">
            {!mine && <span className="text-sm text-text2">Waiting on {nameOf(people, me, q.asked_to)}</span>}
            {mayAnswer && mode !== "answer" && (
              <Button variant={mine ? "solid" : "secondary"} onClick={() => setMode("answer")}>
                Answer
              </Button>
            )}
            {!mine && mayMove && mode !== "reassign" && <Button onClick={() => setMode("reassign")}>Ask someone else</Button>}
          </div>
        )}
        {open && !waiting && mode === "answer" && (
          <div className="rounded-panel border border-line bg-surface p-3">
            <AnswerQuestion
              question={asInbox(card, s)}
              sendAnswer={onTurn && mine ? (body) => turn(body, false) : undefined}
              onCancel={() => setMode(null)}
              onSettled={() => {
                setMode(null);
                onChanged();
              }}
            />
          </div>
        )}
        {open && mode === "reassign" && (
          <div className="rounded-button border border-line bg-surface p-2" role="group" aria-label="Ask someone else">
            <PersonPicker autoFocus exclude={q.asked_to ? [q.asked_to] : []} onPick={reassign} />
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </li>
  );
}

/** When a batch was asked: its questions' earliest change (a question changes when it is asked). */
function askedOn(b: Batch): string | null {
  const stamps = b.questions.map((c) => c.question.updated_at).sort();
  return stamps.length ? dayMonth(stamps[0]) : null;
}

const SIZES = ["3", "5", "10"] as const;

/**
 * Next questions (the author or an approver): Oracle's next batch exactly as Ask these asks
 * it (GET .../next-batch), each with a person picker (the gap's owner, else the author).
 */
function NextQuestions({ intakeId, me, version, onAsked }: { intakeId: string; me: Me; version: number; onAsked: () => void }) {
  const [size, setSize] = useState<(typeof SIZES)[number]>("5");
  const [preview, setPreview] = useState<{ cards: Card[]; remaining: number } | null>(null);
  const [writers, setWriters] = useState<Person[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    unwrap(api.GET("/v1/intakes/{intake_id}/next-batch", { params: { path: { intake_id: intakeId }, query: { size: Number(size) } } }))
      .then(async (out) => {
        const defaults = await peopleByIds(out.questions.map((c) => c.question.asked_to));
        const first = await findPeople("");
        if (!live) return;
        const all = new Map(first.filter((p) => p.can_write).map((p) => [p.user_id, p]));
        for (const p of defaults.values()) all.set(p.user_id, p);
        setWriters([...all.values()].sort((a, b) => a.name.localeCompare(b.name)));
        setPreview({ cards: out.questions, remaining: out.remaining });
        setChosen({});
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [intakeId, size, version]);

  async function ask() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const assign = Object.fromEntries(Object.entries(chosen).filter(([qid, uid]) => preview.cards.find((c) => c.question.id === qid)?.question.asked_to !== uid));
    try {
      await unwrap(api.POST("/v1/intakes/{intake_id}/question-batches", { params: { path: { intake_id: intakeId } }, body: { size: Number(size), assign } }));
      onAsked();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const n = preview?.remaining ?? 0;
  return (
    <Panel title="Next questions" testId="next-questions" tools={<SegmentedControl label="Batch size" size="sm" items={SIZES.map((v) => ({ value: v, label: v }))} value={size} onChange={setSize} />}>
      <div className="flex flex-col gap-3 p-4 max-[600px]:p-3">
        {!preview && !error && <p className="text-sm text-text2">Reading Oracle&apos;s next questions…</p>}
        {preview && (
          <p className="text-[15px] font-semibold text-text">
            {n === 0 ? "Oracle has no more questions." : `Oracle has ${n} more question${n === 1 ? "" : "s"}`}
          </p>
        )}
        {preview && preview.cards.length > 0 && (
          <>
            <ol className="flex flex-col divide-y divide-line">
              {preview.cards.map((c) => (
                <li key={c.question.id} data-testid="next-question" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                  <span data-testid="next-prompt" className="min-w-0 flex-[1_1_16rem] text-sm break-words text-text">
                    {c.question.prompt}
                  </span>
                  {c.gap?.importance === "critical" && <Chip kind="crit">Critical</Chip>}
                  <select
                    aria-label={`Who answers: ${c.question.prompt}`}
                    className={`${SELECT} max-w-full`}
                    value={chosen[c.question.id] ?? c.question.asked_to ?? ""}
                    onChange={(e) => setChosen((m) => ({ ...m, [c.question.id]: e.target.value }))}
                  >
                    {writers.map((p) => (
                      <option key={p.user_id} value={p.user_id}>
                        {p.user_id === me.id ? `${p.name} (you)` : p.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ol>
            <div>
              <Button variant="solid" icon="ask" disabled={busy} onClick={ask}>
                {busy ? "Asking…" : "Ask these"}
              </Button>
            </div>
          </>
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Panel>
  );
}

/**
 * The Questions tab: the interview thread, one group per batch ("Batch 1 · 5 questions ·
 * asked 20 Oct"), each question an Oracle bubble with its answers under it; then Next
 * questions for the author or an approver.
 */
export function QuestionsTab({
  summary: s,
  batches,
  me,
  version,
  onChanged,
}: {
  summary: Summary;
  batches: Batch[];
  me: Me;
  version: number;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<People>(new Map());
  const ids = batches.flatMap((b) => b.questions.flatMap((c) => [c.question.asked_to, ...c.answers.flatMap((a) => [a.answered_by, a.delegated_to])]));
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  useEffect(() => {
    let live = true;
    peopleByIds(key ? key.split(",") : [])
      .then((m) => live && setPeople(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  const { can } = useMe();
  const asker = can("ask_next_question_batch", s.intake.author_id === me.id);
  // C3 team follow-ups: my team interview on this brief holds Oracle's follow-ups and my replies
  // (#370: shown to a role that can answer in it).
  const member = can("open_team_interview");
  const [followUp, setFollowUp] = useState(() => typeof window === "undefined" || localStorage.getItem(FOLLOW_UP_KEY) !== "off");
  const [interview, setInterview] = useState<{ id: string; messages: Message[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!member) return;
    let live = true;
    unwrap(api.POST("/v1/intakes/{intake_id}/interview", { params: { path: { intake_id: s.intake.id } } }))
      .then((iv) => live && setInterview({ id: iv.id, messages: iv.messages }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [member, s.intake.id]);
  function toggle(on: boolean) {
    setFollowUp(on);
    localStorage.setItem(FOLLOW_UP_KEY, on ? "on" : "off");
  }
  const turn: Turn = async (questionId, body, skip) => {
    if (!interview) throw new Error("Your interview is still loading; try again.");
    const out = await unwrap(
      api.POST("/v1/interviews/{interview_id}/turns", {
        params: { path: { interview_id: interview.id } },
        body: { question_id: questionId, body, skip_follow_up: skip },
      }),
    );
    setInterview((iv) => (iv ? { ...iv, messages: [...iv.messages, ...out.messages] } : iv));
    if (!out.recorded) return false;
    setFocus(out.next_question_id ?? null);
    onChanged();
    return true;
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {member && (
        <div className="flex justify-end">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-text">
            <input
              type="checkbox"
              role="switch"
              aria-label="Oracle follows up"
              className="size-4 accent-[var(--accent)]"
              checked={followUp}
              onChange={(e) => toggle(e.target.checked)}
            />
            Oracle follows up
            <InfoTip label="what Oracle follows up does" align="end">
              When your answer does not settle the question yet, Oracle asks you one follow-up before it records your answer.
            </InfoTip>
          </label>
        </div>
      )}
      <div data-testid="intake-thread" className="flex min-w-0 flex-col gap-5">
        {batches.length === 0 && <Empty>No questions asked yet</Empty>}
        {batches.map((b) => (
          <section key={b.batch} data-testid="batch" aria-label={`Batch ${b.batch}`} className="flex min-w-0 flex-col gap-3">
            <h2 className="text-[13px] font-semibold tracking-[0.02em] text-text2">
              Batch {b.batch} · {b.questions.length} question{b.questions.length === 1 ? "" : "s"}
              {askedOn(b) ? ` · asked ${askedOn(b)}` : ""}
            </h2>
            <ul className="flex min-w-0 flex-col gap-4">
              {b.questions.map((c) => (
                <QuestionBubble
                  key={c.question.id}
                  card={c}
                  summary={s}
                  people={people}
                  me={me}
                  onChanged={onChanged}
                  transcript={interview?.messages.filter((m) => m.question_id === c.question.id) ?? []}
                  onTurn={followUp && interview ? turn : undefined}
                  focus={focus === c.question.id}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {asker && s.intake.status !== "archived" && <NextQuestions intakeId={s.intake.id} me={me} version={version} onAsked={onChanged} />}
    </div>
  );
}

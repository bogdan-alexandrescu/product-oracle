"use client";

import { useState } from "react";

import { Button, Chip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatAge, formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type Question = Schemas["AgentQuestionOut"];
type Out = Schemas["AgentQuestionsOut"];

/**
 * AQ1 Cards atop the review: the questions the run's agents asked at this stop, above the
 * feature table. Open ones as cards in two columns (one on a phone) with their options as
 * buttons and the agent's pick marked; then an Answered row with who and when. An answer goes
 * to the next step with the stop's decision; one nobody gives goes with the agent's pick.
 */
export function AgentQuestions({ runId, cpId, features }: { runId: string; cpId: string; features: { key: string; title: string }[] }) {
  const path = { params: { path: { run_id: runId, checkpoint_id: cpId } } };
  const q = useQuery(`agent-questions|${runId}|${cpId}`, () => unwrap(api.GET("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/agent-questions", path)));
  const [opened, setOpened] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Answered questions being answered again ("Change"): shown open until saved.
  const [changing, setChanging] = useState<string[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = q.data;
  if (!data || data.questions.length === 0) return null;

  const next = data.next_step ?? null;
  const about = (x: Question) => (x.feature ? (features.find((f) => f.key === x.feature)?.title ?? "a feature left out of the set") : "the whole set");
  const isOpen = (x: Question) => !x.answer || changing.includes(x.id);
  const open = data.questions.filter(isOpen);
  const done = data.questions.filter((x) => !isOpen(x));

  const pick = (id: string, option: string) => {
    setPicked((m) => ({ ...m, [id]: option }));
    setOpened(id);
  };
  const save = async (x: Question) => {
    setSaving(x.id);
    setError(null);
    try {
      const out: Out = await unwrap(
        api.PUT("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/agent-questions/{question_id}/answer", {
          params: { path: { run_id: runId, checkpoint_id: cpId, question_id: x.id } },
          body: { option: picked[x.id] ?? x.recommended ?? "", note: notes[x.id]?.trim() || null },
        }),
      );
      q.setData(() => out);
      setChanging((c) => c.filter((id) => id !== x.id));
      setOpened(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };
  const change = (x: Question) => {
    setPicked((m) => ({ ...m, [x.id]: x.answer?.option ?? "" }));
    setNotes((m) => ({ ...m, [x.id]: x.answer?.note ?? "" }));
    setChanging((c) => [...c, x.id]);
    setOpened(x.id);
  };

  return (
    <section className="mb-4 rounded-panel border border-line bg-surface2 p-3" aria-label="Questions from the agents" data-testid="agent-questions">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Questions from the agents</h2>
        <span className="tnum text-sm text-text2" data-testid="agent-questions-count">
          {open.length} open · {done.length} answered
        </span>
        <span className="text-[13px] text-text2">Answer here before you decide; each answer goes to {next ?? "the next step"} with the decision.</span>
      </div>
      {error && (
        <p className="mb-2 text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      {open.length > 0 && (
        <div className="grid grid-cols-2 items-start gap-2 max-[900px]:grid-cols-1">
          {open.map((x) => (
            <OpenCard
              key={x.id}
              q={x}
              about={about(x)}
              next={next}
              open={opened === x.id}
              chosen={picked[x.id] || undefined}
              note={notes[x.id] ?? ""}
              canAnswer={data.can_answer}
              saving={saving === x.id}
              onPick={(o) => pick(x.id, o)}
              onNote={(t) => setNotes((m) => ({ ...m, [x.id]: t }))}
              onOpen={(on) => setOpened(on ? x.id : null)}
              onSave={() => void save(x)}
            />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <>
          <h3 className="mt-3 mb-1 text-sm font-semibold text-text2">Answered</h3>
          <div className="grid grid-cols-2 items-start gap-2 max-[900px]:grid-cols-1">
            {done.map((x) => (
              <AnsweredCard key={x.id} q={x} about={about(x)} next={next} canChange={data.can_answer && !!x.answer?.mine} onChange={() => change(x)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const roleWord = (q: Question) => `${q.role.charAt(0).toUpperCase()}${q.role.slice(1)}`;
const optionLabel = (q: Question, key: string) => q.options.find((o) => o.key === key)?.label ?? key;
const when = (iso: string) => (formatAge(iso) === "now" ? "just now" : formatDateTime(iso));

/** Where an answer goes, said once per answered card. */
function Reaches({ next, mine }: { next: string | null; mine: boolean }) {
  return (
    <p className="text-[13px] text-text2" data-testid="agent-question-reaches">
      Goes to {next ? <b className="font-semibold text-text">{next}</b> : "the next step"}
      {next ? ", the next step," : ""} with this stop&apos;s decision. Its agent reads it as settled.
      {mine && " You can change it until you decide the stop."}
    </p>
  );
}

function AnsweredCard({ q, about, next, canChange, onChange }: { q: Question; about: string; next: string | null; canChange: boolean; onChange: () => void }) {
  const a = q.answer!;
  return (
    <div className="flex flex-col gap-1 rounded-button border border-line bg-surface px-3 py-2" data-testid="agent-question" data-state="answered">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text2">
        <Chip kind="pass">Answered</Chip>
        <span>
          {roleWord(q)} asked · About {about}
        </span>
      </div>
      <p className="text-sm text-text">{q.question}</p>
      <p className="text-sm">
        <span aria-hidden className="text-pass">
          ✓{" "}
        </span>
        <b className="font-semibold">{optionLabel(q, a.option)}</b>
        {a.option === q.recommended && <span className="text-text2"> (the agent&apos;s pick)</span>}
        {a.note && <span className="text-text2"> · “{a.note}”</span>}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] text-text2" data-testid="agent-question-who">
          Answered by {a.mine ? "you" : (a.by?.name ?? "someone")} · {when(a.at)}
        </span>
        {canChange && (
          <button type="button" className="text-[13px] font-semibold text-accent-ink underline" onClick={onChange}>
            Change
          </button>
        )}
      </div>
      <Reaches next={next} mine={a.mine ?? false} />
    </div>
  );
}

function OpenCard({
  q,
  about,
  next,
  open,
  chosen,
  note,
  canAnswer,
  saving,
  onPick,
  onNote,
  onOpen,
  onSave,
}: {
  q: Question;
  about: string;
  next: string | null;
  open: boolean;
  chosen: string | undefined;
  note: string;
  canAnswer: boolean;
  saving: boolean;
  onPick: (option: string) => void;
  onNote: (text: string) => void;
  onOpen: (on: boolean) => void;
  onSave: () => void;
}) {
  const nextWord = next ?? "The next step";
  return (
    <div
      className={`flex flex-col gap-2 rounded-button border bg-surface px-3 py-3 ${open ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line"}`}
      data-testid="agent-question"
      data-state={open ? "open" : "unanswered"}
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-text2">
        <Chip kind="warn" dot>
          Needs an answer
        </Chip>
        <span>
          {roleWord(q)} asks · About {about}
        </span>
      </div>
      <p className="text-[15px] font-semibold text-text">{q.question}</p>
      {open && q.why && <p className="text-sm text-text2">Why: {q.why}</p>}
      <div role="radiogroup" aria-label={q.question} className={`flex gap-2 ${open ? "flex-col" : "flex-wrap"}`}>
        {q.options.map((o) => {
          const on = chosen === o.key;
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canAnswer}
              onClick={() => onPick(o.key)}
              className={`flex min-h-10 flex-col items-start rounded-button border px-3 py-1.5 text-left text-sm enabled:hover:border-accent disabled:cursor-default ${on ? "border-accent bg-accent-soft" : "border-line-strong bg-surface"}`}
            >
              <span className="flex flex-wrap items-center gap-2 font-medium">
                <span aria-hidden className={`inline-block size-3.5 rounded-full border-2 ${on ? "border-accent bg-accent" : "border-line-strong"}`} />
                {o.label}
                {o.key === q.recommended && <Chip kind="acc">Agent&apos;s pick</Chip>}
              </span>
              {open && o.detail && <span className="pl-5.5 text-[13px] text-text2">{o.detail}</span>}
            </button>
          );
        })}
      </div>
      {chosen ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[13px] text-text2">
            Note for the next agent (optional)
            <input className="h-9 rounded-button border border-line-strong bg-surface px-2 text-sm text-text" value={note} maxLength={1000} onChange={(e) => onNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="solid" disabled={saving} onClick={onSave}>
              Save answer
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => onPick("")}>
              Clear
            </Button>
            <span className="text-[13px] text-text2">Goes to {next ?? "the next step"} with this stop&apos;s decision.</span>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-text2">
          Not answered by the time you decide: {nextWord} goes with the agent&apos;s pick.{" "}
          <button type="button" className="font-semibold text-accent-ink underline" onClick={() => onOpen(!open)}>
            {open ? "Hide why" : "Why they ask"}
          </button>
        </p>
      )}
    </div>
  );
}

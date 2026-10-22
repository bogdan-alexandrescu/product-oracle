"use client";

import { useState } from "react";

import { Button, InfoTip } from "@/components/ds";
import { PersonPicker, peopleByIds, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

export type InboxQuestion = Schemas["InboxQuestion"];
type Kind = Schemas["AnswerIn"]["kind"];

/** The longest answer the API takes. */
const MAX_ANSWER = 4000;

/** Who asks, as the Inbox names them: "Oracle asks", "<name> asks" or, for a company API
 * token, "<token name> asks" ("An API token asks" once it is gone). */
export function askerName(q: InboxQuestion): string {
  return q.asked_by.kind === "oracle" ? "Oracle" : q.asked_by.name;
}

/** What a settled question shows in place of its actions. */
export function settledLabel(kind: Kind, delegate?: Person | null): string {
  if (kind === "answer") return "Answered ✓";
  if (kind === "dont_know") return "I don't know ✓";
  if (kind === "defer") return "Deferred ✓";
  if (kind === "research") return "Research proposed ✓";
  return `Asked ${delegate?.name ?? "someone"} ✓`;
}

/** 403: the question was asked of someone else (moved since this loaded), by name. */
async function askedOfMessage(questionId: string): Promise<string> {
  try {
    const q = await unwrap(api.GET("/v1/questions/{item_id}", { params: { path: { item_id: questionId } } }));
    const name = (await peopleByIds([q.asked_to])).get(q.asked_to ?? "")?.name;
    return name ? `This was asked of ${name}` : "This was asked of someone else";
  } catch {
    return "This was asked of someone else";
  }
}

/**
 * The expanded answer form of a question (C2): the prompt in full, why it is asked, "Your
 * answer", and the answer paths the question offers: Send answer, I don't know, Defer, Ask
 * someone (the member picker) and, on an intake's question, Research this. The Inbox row,
 * Home's Needs you and the phone sheet draw it; `onSettled` gets the path taken.
 */
export function AnswerQuestion({
  question: q,
  onSettled,
  onCancel,
  sendAnswer,
}: {
  question: InboxQuestion;
  onSettled: (kind: Kind, label: string) => void;
  onCancel?: () => void;
  /** Send answer goes here instead (C3 team follow-ups); false while Oracle waits for a reply. */
  sendAnswer?: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const paths = new Set(q.answer_paths);
  const prompt = q.question.prompt;

  async function send(kind: Kind, delegate?: Person) {
    if (kind === "answer" && !body.trim()) {
      setError("Write your answer first");
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      if (kind === "answer" && sendAnswer) {
        if (await sendAnswer(body.trim())) onSettled(kind, settledLabel(kind));
        return;
      }
      await unwrap(
        api.POST("/v1/questions/{question_id}/answers", {
          params: { path: { question_id: q.question.id } },
          body: { kind, body: kind === "answer" ? body.trim() : null, delegated_to: delegate?.user_id ?? null, evidence_ids: [] },
        }),
      );
      onSettled(kind, settledLabel(kind, delegate));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? await askedOfMessage(q.question.id) : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5 whitespace-normal" data-testid="answer-question">
      <p className="text-[15px] leading-[22px] font-semibold break-words text-text" data-testid="answer-prompt">
        {prompt}
      </p>
      {q.question.rationale && (
        <p className="flex items-center gap-1 text-sm text-text2">
          Why {askerName(q)} asks
          <InfoTip label={`why ${askerName(q)} asks`} align="start">
            {q.question.rationale}
          </InfoTip>
        </p>
      )}
      <label className={FIELD_LABEL}>
        Your answer
        <textarea
          rows={3}
          maxLength={MAX_ANSWER}
          value={body}
          autoFocus
          data-autofocus
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send("answer");
            if (e.key === "Escape") onCancel?.();
          }}
          className={TEXTAREA}
        />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="solid" icon="check" disabled={busy !== null} onClick={() => send("answer")}>
          {busy === "answer" ? "Sending…" : "Send answer"}
        </Button>
        {paths.has("dont_know") && (
          <Button disabled={busy !== null} onClick={() => send("dont_know")}>
            I don&apos;t know
          </Button>
        )}
        {paths.has("defer") && (
          <Button disabled={busy !== null} onClick={() => send("defer")}>
            Defer
          </Button>
        )}
        {paths.has("delegate") && (
          <Button disabled={busy !== null} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
            Ask someone ▾
          </Button>
        )}
        {paths.has("research") && (
          <Button disabled={busy !== null} onClick={() => send("research")}>
            Research this
          </Button>
        )}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {picking && (
        <div className="rounded-button border border-line bg-surface p-2" role="group" aria-label="Ask someone">
          <PersonPicker autoFocus exclude={q.question.asked_to ? [q.question.asked_to] : []} onPick={(p) => send("delegate", p)} />
        </div>
      )}
    </div>
  );
}

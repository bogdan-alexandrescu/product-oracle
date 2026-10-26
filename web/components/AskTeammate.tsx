"use client";

import { useState, type FormEvent } from "react";

import { Button, Chip } from "@/components/ds";
import { PersonPicker, type Person } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

export const QUESTIONS_CHANGED = "po:questions-changed";

/** Tells every open list of questions (a section's Feedback tab) to read again. */
export function questionsChanged() {
  window.dispatchEvent(new Event(QUESTIONS_CHANGED));
}

/**
 * Ask a teammate (C2): a person (commenter and above, from the member directory), the
 * question (at most 1000) and an optional why (at most 500). It lands in their Inbox as
 * "<your name> asks"; the answer shows where it was asked (a section's Feedback tab).
 */
export function AskTeammate({
  subject,
  context,
  person: suggested = null,
  onClose,
}: {
  subject: Schemas["QuestionCreate"]["subject"];
  /** What the question is about, in the form's title ("6. Success metrics"). */
  context: string;
  /** Who the form starts with (a Plan alert's one engineering lead); the asker may change it. */
  person?: Person | null;
  onClose: () => void;
}) {
  const [person, setPerson] = useState<Person | null>(suggested);
  const [prompt, setPrompt] = useState("");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<Person | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!person) return setError("Pick the person to ask");
    if (!prompt.trim()) return setError("Write the question");
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/questions", {
          body: { prompt: prompt.trim(), asked_to: person.user_id, rationale: why.trim() || null, subject },
        }),
      );
      setAsked(person);
      questionsChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mt-3 rounded-button border border-line bg-surface2 px-3 py-2.5"
      aria-label={`Ask a teammate about ${context}`}
      data-testid="ask-teammate"
    >
      <p className="mb-2 min-w-0 truncate font-semibold text-text">Ask a teammate about “{context}”</p>
      {asked ? (
        <div className="flex flex-wrap items-center gap-2">
          <Chip kind="pass">Asked {asked.name}</Chip>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <div className={FIELD_LABEL}>
            Person
            {person ? (
              <span className="flex items-center gap-2 text-[15px] font-medium tracking-normal text-text">
                {person.name}
                <span className="text-sm text-text2">{person.email}</span>
                <Button variant="ghost" onClick={() => setPerson(null)}>
                  Change
                </Button>
              </span>
            ) : (
              <PersonPicker autoFocus onPick={setPerson} />
            )}
          </div>
          <label className={FIELD_LABEL}>
            Question
            <textarea rows={2} maxLength={1000} value={prompt} onChange={(e) => setPrompt(e.target.value)} className={TEXTAREA} />
          </label>
          <label className={FIELD_LABEL}>
            Why (optional)
            <textarea rows={2} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} className={TEXTAREA} />
          </label>
          {error && <InlineError>{error}</InlineError>}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="solid" icon="ask" disabled={busy}>
              {busy ? "Asking…" : "Ask"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

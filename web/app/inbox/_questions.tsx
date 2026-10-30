"use client";

import { useState } from "react";

import { AnswerQuestion, askerName, type InboxQuestion } from "@/components/AnswerQuestion";
import { Button, Chip, LinkButton, Sheet } from "@/components/ds";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { CODE_LIKE, discussionHref, type Need } from "./_needs";

/** A question answered here: shown in place, with its outcome, until the tab changes; then under Done. */
type Settled = { q: InboxQuestion; label: string; moved: boolean };

/** Phone width: Answer opens a bottom sheet instead of the row (DataTable's phone layout). */
const PHONE = "(max-width: 600px)";

/**
 * The questions asked of me (C2), one row each: "Oracle asks" or "<name> asks", the prompt,
 * the subject, Answer (the row expands in place; a sheet on a phone) and Open (the subject).
 * Inbox and Home draw the same rows. `reload` re-reads the questions after an answer.
 */
export function useQuestionRows(questions: InboxQuestion[], reload: () => Promise<unknown>) {
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [settled, setSettled] = useState<ReadonlyMap<string, Settled>>(new Map());

  function settle(q: InboxQuestion, label: string) {
    setSettled((m) => new Map(m).set(q.question.id, { q, label, moved: false }));
    setOpen(null);
    setSheet(null);
    // The rail badge re-reads with the reload, as after any Inbox action.
    invalidateWaiting();
    void reload();
    waitingChanged();
  }

  /** The tab or filter changed: what was settled here moves to Done. */
  function moveSettled() {
    setSettled((m) => new Map([...m].map(([k, v]) => [k, { ...v, moved: true }])));
    setOpen(null);
  }

  function answer(id: string) {
    if (window.matchMedia(PHONE).matches) setSheet(id);
    else setOpen((o) => (o === id ? null : id));
  }

  const live = questions.filter((q) => !settled.has(q.question.id));
  // Oldest first, as the API lists them: a settled row keeps its place.
  const all = [...live, ...[...settled.values()].map((s) => s.q)].sort((a, b) => a.question.created_at.localeCompare(b.question.created_at));
  const rows: Need[] = all.map((q) => {
    const done = settled.get(q.question.id);
    const prompt = q.question.prompt;
    const href = q.subject.href;
    // G6: a question asked from a discussion names it, and opens it.
    const from = q.question.discussion_id && q.question.discussion_title ? q.question.discussion_title : null;
    const context = from ? `From discussion ${from}` : q.subject.title;
    const opened = open === q.question.id && !done;
    return {
      key: q.question.id,
      icon: "ask",
      kind: `${askerName(q)} asks`,
      // qa-company-3 (round 3): "Show the text" only where it adds something: Oracle's text
      // names codes (each carrying its card there), as on an "Oracle did" row.
      quote: q.asked_by.kind === "oracle" && CODE_LIKE.test(prompt) ? prompt : null,
      item: (
        <>
          {/* Opened to answer, the row's line is the question in full; the form does not repeat it. */}
          <span className={opened ? "min-w-0 break-words whitespace-normal" : "min-w-0 truncate"} title={prompt} data-testid="question-prompt">
            {prompt}
          </span>
          {done && (
            <Chip kind="pass" data-testid="question-settled">
              {done.label}
            </Chip>
          )}
        </>
      ),
      context: (
        <span className="block truncate" title={context}>
          {context}
        </span>
      ),
      at: q.question.created_at,
      // Settled here: out of the count at once; under Done once the tab changes.
      ...(done ? { counted: done.moved, ...(done.moved ? { state: "done" as const } : {}) } : {}),
      action: (
        <>
          {!done && (
            <Button aria-expanded={open === q.question.id} onClick={() => answer(q.question.id)}>
              Answer
            </Button>
          )}
          {/* qa-company-7 (round 3): Open is outlined, as on every other row's Open. */}
          {href && (
            <LinkButton href={href} aria-label={`Open ${q.subject.title}`}>
              Open
            </LinkButton>
          )}
          {href && from && (
            <LinkButton variant="ghost" href={discussionHref(href, q.question.discussion_id!)}>
              Open discussion
            </LinkButton>
          )}
        </>
      ),
      detail:
        opened ? (
          <AnswerQuestion question={q} showPrompt={false} onSettled={(_, label) => settle(q, label)} onCancel={() => setOpen(null)} />
        ) : undefined,
    };
  });

  const sheetQuestion = sheet ? questions.find((q) => q.question.id === sheet) : undefined;
  const sheetNode = (
    <Sheet open={!!sheetQuestion} title="Answer" onClose={() => setSheet(null)} testId="answer-sheet">
      {sheetQuestion && (
        <div className="p-4">
          <AnswerQuestion question={sheetQuestion} onSettled={(_, label) => settle(sheetQuestion, label)} />
        </div>
      )}
    </Sheet>
  );

  return { rows, sheet: sheetNode, moveSettled };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyAll,
  applyCard,
  chooseChoice,
  hasPending,
  PENDING_POLL_MS,
  retryMessage,
  sendApplied,
  sendCardChanged,
  type ChatMessage,
  type ChatThread as Thread,
} from "@/lib/api/simple-chat";
import { errorMessage } from "@/lib/use-query";

import { ChatCard } from "./ChatCard";

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** A change-by-chat thread (Simple S9): the lines oldest first, Oracle's cards, and the composer. */
/** Words typed into a chat box for the person, and which ask put them there. */
export type Typed = { text: string; n: number };

export function ChatThreadView({
  thread,
  send,
  placeholder,
  hint,
  testId,
  onCardChanged,
  onThread,
  typed,
  note,
}: {
  thread: Thread | null;
  send: (text: string) => Promise<unknown>;
  placeholder: string;
  hint?: string;
  testId: string;
  onCardChanged?: () => void;
  /** chat-reader: Retry, a choice or Apply all answered this thread. */
  onThread?: (t: Thread) => void;
  /** Words typed in for the person (a goal's "Suggest from the chat", a PRD question's Ask Oracle); they go on
   * writing after them. `n` counts the asks, so the same words asked again fill the box again. */
  typed?: Typed;
  /** A line under the message box (the item's talk: "Just you and Oracle · kept with this item"). */
  note?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [count]);

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid={testId}>
      <ChatMessages
        messages={thread?.messages ?? []}
        onCardChanged={onCardChanged}
        onThread={onThread}
      />
      <div ref={end} />
      <ChatComposer
        send={send}
        placeholder={placeholder}
        hint={hint}
        typed={typed}
        note={note}
      />
    </div>
  );
}

/** The chat's box and Send (Enter sends, Shift+Enter a new line); `send` failing keeps the text and says why. */
export function ChatComposer({
  send,
  placeholder,
  hint,
  typed,
  note,
}: {
  send: (text: string) => Promise<unknown>;
  placeholder: string;
  hint?: string;
  /** Words typed in for the person (a goal's "Suggest from the chat", a PRD question's Ask Oracle); they go on
   * writing after them. `n` counts the asks, so the same words asked again fill the box again. */
  typed?: Typed;
  /** A line under the message box (the item's talk: "Just you and Oracle · kept with this item"). */
  note?: string;
}) {
  const [text, setText] = useState(typed?.text ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  const [had, setHad] = useState(typed?.n ?? 0);
  if ((typed?.n ?? 0) !== had) {
    setHad(typed?.n ?? 0);
    if (typed?.text) setText(typed.text);
  }
  useEffect(() => {
    const words = typed?.text;
    if (!words) return;
    const t = box.current;
    if (t) {
      t.focus();
      window.setTimeout(
        () => t.setSelectionRange(words.length, words.length),
        0,
      );
    }
  }, [typed]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await send(t);
      setText("");
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {hint && (
        <p className="simple-small text-text2" data-testid="chat-hint">
          {hint}
        </p>
      )}
      <textarea
        ref={box}
        aria-label="Message Oracle"
        rows={2}
        maxLength={2000}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        className="min-h-16 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-text"
      />
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      <div>
        <button
          type="submit"
          className="simple-button simple-button-primary"
          disabled={busy || !text.trim()}
        >
          Send
        </button>
      </div>
      {note && (
        <p className="simple-small text-text2" data-testid="chat-note">
          {note}
        </p>
      )}
    </form>
  );
}

/** chat-reader: while a line of `thread` is pending (Oracle's reader is reading it), `reload` it every ~1.5 s. */
export function usePendingPoll(
  thread: { messages: ChatMessage[] } | null,
  reload: () => Promise<unknown> | void,
) {
  const pending = hasPending(thread);
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  // `thread` changes on each read, so each read that is still pending schedules the next.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(
      () => void latest.current(),
      PENDING_POLL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pending, thread]);
}

/**
 * S9's lines, oldest first, with Oracle's cards (a thread's, or those shown in an Ask chat).
 * chat-reader's states: a pending line ("Reading that…"), a failed one with Retry, a clarify
 * question's choices, and Apply all on a line with two or more open cards; each answers the
 * thread, which `onThread` takes.
 */
export function ChatMessages({
  messages,
  onCardChanged,
  onThread,
}: {
  messages: Thread["messages"];
  onCardChanged?: () => void;
  onThread?: (t: Thread) => void;
}) {
  const corrected = useCorrections();
  return (
    <ol className="flex flex-col gap-3" aria-label="Messages">
      {shownLines(messages).map((m) => (
        <ChatLine
          key={m.id}
          message={m}
          onCardChanged={onCardChanged}
          onThread={onThread}
          corrected={corrected}
        />
      ))}
    </ol>
  );
}

/** The lines a chat shows: a line handed to Oracle's Ask (kind "ask") lives in Ask's chat, so neither it nor the person's line shows. */
export function shownLines(messages: Thread["messages"]): Thread["messages"] {
  const handed = new Set(
    messages.filter((m) => m.kind === "ask").flatMap((m) => [m.id, m.reply_to]),
  );
  return messages.filter((m) => !handed.has(m.id));
}

/** roadmap-talk: the values typed into each card's open Correct form (by card id), for Apply all. */
export type Corrections = {
  corrections: Map<string, Record<string, string | null>>;
  onCorrecting: (
    id: string,
    values: Record<string, string | null> | null,
  ) => void;
};

/** A chat's open Correct forms: one map per chat, kept across its reads. */
export function useCorrections(): Corrections {
  const [corrections] = useState(
    () => new Map<string, Record<string, string | null>>(),
  );
  const onCorrecting = useCallback(
    (id: string, values: Record<string, string | null> | null) => {
      if (values) corrections.set(id, values);
      else corrections.delete(id);
    },
    [corrections],
  );
  return { corrections, onCorrecting };
}

/** One line of a chat (an <li>): its author, its words, its actions and Oracle's cards. */
export function ChatLine({
  message: m,
  onCardChanged,
  onThread,
  corrected,
}: {
  message: ChatMessage;
  onCardChanged?: () => void;
  onThread?: (t: Thread) => void;
  /** roadmap-talk: the chat's open Correct forms (Apply all applies them with their typed values). */
  corrected?: Corrections;
}) {
  return (
    <li
      data-testid="chat-message"
      data-kind={m.kind}
      data-author={m.author_kind}
      className={`flex flex-col gap-2 ${m.author_kind === "person" ? "items-end" : "items-start"}`}
    >
      <div
        className={`max-w-[95%] rounded-xl px-3 py-2 ${m.author_kind === "person" ? "bg-accent-soft text-accent-ink" : "bg-surface2 text-text"}`}
      >
        <p className="simple-small font-semibold">{m.author_name}</p>
        {m.kind === "pending" ? (
          <p
            className="whitespace-pre-wrap text-text2"
            data-testid="chat-pending"
            role="status"
          >
            <span data-testid="chat-message-body">{m.body}</span>
          </p>
        ) : (
          <p className="whitespace-pre-wrap" data-testid="chat-message-body">
            {m.body}
          </p>
        )}
        {m.source && (
          <p
            className="simple-small text-text2 [overflow-wrap:anywhere]"
            data-testid="chat-message-source"
          >
            {m.source}
          </p>
        )}
      </div>
      <LineActions
        message={m}
        onThread={onThread}
        corrections={corrected?.corrections}
      />
      {m.cards.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          {m.cards.map((c) => (
            <ChatCard
              key={c.id}
              card={c}
              onChanged={onCardChanged}
              onCorrecting={corrected?.onCorrecting}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * A line's own actions (chat-reader): Retry, the choices, Apply all; the outcome of each.
 * Apply all applies a card with an open Correct form with its typed values first, then the
 * rest; the roadmap reads again and each applied item's bar flashes.
 */
function LineActions({
  message: m,
  onThread,
  corrections,
}: {
  message: ChatMessage;
  onThread?: (t: Thread) => void;
  corrections?: Map<string, Record<string, string | null>>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const run = async (fn: () => Promise<Thread | null>) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const t = await fn();
      if (t) onThread?.(t);
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  };
  const open = m.cards.filter((c) => c.status === "open" && c.may !== null);
  const retry = m.kind === "failed" && m.retry;
  const choices = m.choices.length > 0;
  if (!retry && !choices && open.length < 2 && !said && !error) return null;
  return (
    <div className="flex w-full flex-col gap-2">
      {retry && (
        <div>
          <button
            type="button"
            className="simple-button"
            disabled={busy}
            onClick={() => void run(() => retryMessage(m.id))}
          >
            Retry
          </button>
        </div>
      )}
      {choices && (
        <div
          className="flex min-w-0 flex-wrap gap-2"
          role="group"
          aria-label="Choices"
          data-testid="chat-choices"
        >
          {m.choices.map((c) => (
            <button
              key={c.index}
              type="button"
              className="simple-button simple-button-wrap"
              disabled={busy || m.picked !== null}
              aria-pressed={
                m.picked === null ? undefined : m.picked === c.index
              }
              onClick={() => void run(() => chooseChoice(m.id, c.index))}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {open.length >= 2 && (
        <div>
          <button
            type="button"
            className="simple-button simple-button-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const flashed: string[] = [];
                let done = 0;
                try {
                  for (const c of open) {
                    const values = corrections?.get(c.id);
                    if (!values) continue;
                    const one = await applyCard(c.id, null, values);
                    done += 1;
                    if (one.card.status === "applied" && one.card.item_id)
                      flashed.push(one.card.item_id);
                  }
                  // Every card was corrected and applied: nothing is left for Apply all.
                  if (done === open.length) return null;
                  const r = await applyAll(m.id);
                  if (r.stopped)
                    setSaid(
                      `Applied ${done + r.applied.length} of ${open.length}. Stopped at “${r.stopped.summary}”: ${r.stopped.reason.replace(/\.$/, "")}.`,
                    );
                  const cards =
                    r.thread.messages.find((x) => x.id === m.id)?.cards ?? [];
                  for (const c of cards)
                    if (
                      r.applied.includes(c.id) &&
                      c.status === "applied" &&
                      c.item_id
                    )
                      flashed.push(c.item_id);
                  return r.thread;
                } finally {
                  sendCardChanged();
                  for (const id of flashed) sendApplied(id);
                }
              })
            }
          >
            Apply all
          </button>
        </div>
      )}
      {said && (
        <p
          role="status"
          className="simple-small text-text"
          data-testid="chat-apply-all-stopped"
        >
          {said}
        </p>
      )}
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

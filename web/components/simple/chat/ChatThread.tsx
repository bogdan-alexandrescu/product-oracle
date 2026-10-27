"use client";

import { useEffect, useRef, useState } from "react";

import type { ChatThread as Thread } from "@/lib/api/simple-chat";
import { errorMessage } from "@/lib/use-query";

import { ChatCard } from "./ChatCard";

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** A change-by-chat thread (Simple S9): the lines oldest first, Oracle's cards, and the composer. */
export function ChatThreadView({
  thread,
  send,
  placeholder,
  hint,
  testId,
  onCardChanged,
}: {
  thread: Thread | null;
  send: (text: string) => Promise<unknown>;
  placeholder: string;
  hint?: string;
  testId: string;
  onCardChanged?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [count]);

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
    <div className="flex min-h-0 flex-col gap-3" data-testid={testId}>
      <ol className="flex flex-col gap-3" aria-label="Messages">
        {thread?.messages.map((m) => (
          <li key={m.id} data-testid="chat-message" data-kind={m.kind} data-author={m.author_kind} className={`flex flex-col gap-2 ${m.author_kind === "person" ? "items-end" : "items-start"}`}>
            <div className={`max-w-[95%] rounded-xl px-3 py-2 ${m.author_kind === "person" ? "bg-accent-soft text-accent-ink" : "bg-surface2 text-text"}`}>
              <p className="simple-small font-semibold">{m.author_name}</p>
              <p className="whitespace-pre-wrap" data-testid="chat-message-body">
                {m.body}
              </p>
            </div>
            {m.cards.length > 0 && (
              <div className="flex w-full flex-col gap-2">
                {m.cards.map((c) => (
                  <ChatCard key={c.id} card={c} onChanged={onCardChanged} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div ref={end} />
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
          <button type="submit" className="simple-button simple-button-primary" disabled={busy || !text.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button, LinkButton } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import type { InboxOut } from "../runs/_lib";

type FeedbackRow = InboxOut["items"][number];

/**
 * What an action did, said once above the rows; `undo` where the routes allow it: Decline,
 * and Accept, Close or Merge (not Send answer: the reply is posted on the thread).
 */
export type Acted = { id: string; message: string; undo?: () => Promise<unknown> };
export type OnActed = (a: Acted) => void;

/** How long the "what happened" line, and its Undo, stays. */
export const UNDO_MS = 10_000;

type Primary = "Accept" | "Send answer" | "Close" | "Merge";

/**
 * The row's one-click decision on Oracle's open suggestion (D14): Accept section text,
 * Send an answer, Close on "nothing to change", Merge a duplicate; none without one.
 */
export function primaryOf(f: Pick<FeedbackRow, "suggestion_id" | "suggestion_kind">): Primary | null {
  if (!f.suggestion_id) return null;
  if (f.suggestion_kind === "section_text") return "Accept";
  if (f.suggestion_kind === "answer") return "Send answer";
  if (f.suggestion_kind === "none") return "Close";
  if (f.suggestion_kind === "duplicate") return "Merge";
  return null;
}

function doneMessage(f: FeedbackRow, primary: Primary): string {
  if (primary === "Accept") return `Staged for draft ${(f.latest_version ?? f.raised_on_version) + 1}: ${f.summary}`;
  if (primary === "Send answer") return `Answer sent: ${f.summary}`;
  if (primary === "Close") return `Nothing to change, closed: ${f.summary}`;
  return `Merged with the earlier item: ${f.summary}`;
}

const feedbackPath = (id: string) => ({ params: { path: { feedback_id: id } } });
const suggestionPath = (id: string) => ({ params: { path: { suggestion_id: id } } });

/**
 * A live feedback row's actions (D14): the primary decision on Oracle's suggestion, Decline
 * (not on a duplicate) and Open. Accept on an item Oracle pushed back on asks "Why keep your
 * call?" first (C1b); Decline asks for an optional note, the item's resolution note. An
 * error stays on the row. `compact` (Home): the primary action, or Decline, and Open.
 */
export function InboxActions({
  f,
  href,
  compact = false,
  onActed,
}: {
  f: FeedbackRow;
  href: string;
  compact?: boolean;
  onActed: OnActed;
}) {
  const [mode, setMode] = useState<"idle" | "reason" | "decline">("idle");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  const primary = primaryOf(f);
  const sid = f.suggestion_id;

  async function run(call: () => Promise<unknown>, done: string, acted: Omit<Acted, "id">) {
    setBusy(true);
    setError(null);
    try {
      await call();
      // Until the reload moves the row, it says what happened.
      setSettled(done);
      setMode("idle");
      onActed({ id: f.id, ...acted });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const accept = (reason?: string) =>
    run(
      () => unwrap(api.POST("/v1/suggestions/{suggestion_id}/accept", { ...suggestionPath(sid!), body: reason ? { reason } : {} })),
      primary === "Accept" ? "Staged" : "Done",
      {
        message: doneMessage(f, primary!),
        // Back to open, as before Accept; the API says why when it cannot (a build uses it).
        undo:
          primary === "Send answer"
            ? undefined
            : () => unwrap(api.POST("/v1/suggestions/{suggestion_id}/undo-accept", suggestionPath(sid!))),
      },
    );

  function onPrimary() {
    if (primary === "Accept" && f.suggestion_pushback) {
      open("reason");
      return;
    }
    void accept();
  }

  function open(next: "reason" | "decline") {
    setMode(next);
    setText("");
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (mode === "reason") {
      if (!value) {
        setError("Say why you keep your call.");
        field.current?.focus();
        return;
      }
      void accept(value);
      return;
    }
    const note = value || null;
    void run(
      sid
        ? () => unwrap(api.POST("/v1/suggestions/{suggestion_id}/dismiss", { ...suggestionPath(sid), body: { reason: note, decline: true } }))
        : () => unwrap(api.PATCH("/v1/feedback/{feedback_id}", { ...feedbackPath(f.id), body: { status: "declined", resolution_note: note } })),
      "Declined",
      {
        message: `Declined: ${f.summary}`,
        // Re-open the item; Oracle's dismissed suggestion stays dismissed.
        undo: () => unwrap(api.PATCH("/v1/feedback/{feedback_id}", { ...feedbackPath(f.id), body: { status: "open", resolution_note: null } })),
      },
    );
  }

  const errorLine = error && (
    <span role="alert" data-testid="inbox-action-error" className="w-full text-left text-sm leading-5 whitespace-normal text-crit">
      {error}
    </span>
  );
  // qa-company-4 (round 3): on a phone the actions keep one line under the row, the lead
  // button then the text ones, as on a question's row; only the field's buttons stack.
  const stack = "max-[600px]:w-full";

  if (settled) {
    return (
      <span data-inbox-actions className="text-sm font-semibold text-text2" data-testid="inbox-action-settled">
        {settled}
      </span>
    );
  }

  if (mode !== "idle") {
    const label = mode === "reason" ? "Why keep your call?" : "Why? (optional)";
    const verb = mode === "reason" ? "Accept" : "Decline";
    return (
      <form
        data-inbox-actions
        onSubmit={submit}
        className="flex w-full flex-col items-stretch gap-1.5 py-1 text-left whitespace-normal"
        data-testid="inbox-action-field"
      >
        <label htmlFor={fieldId} className="text-[13px] leading-4 font-semibold text-text2">
          {label}
        </label>
        <input
          ref={field}
          id={fieldId}
          autoFocus
          value={text}
          maxLength={500}
          aria-invalid={mode === "reason" && !!error}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setMode("idle")}
          className="h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-sm"
        />
        {errorLine}
        <span className="flex justify-end gap-1.5 max-[600px]:flex-col">
          <Button type="submit" disabled={busy} className={stack}>
            {verb}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setMode("idle")} className={stack}>
            Cancel
          </Button>
        </span>
      </form>
    );
  }

  // D12: no section text to accept here: the item can go to the agents with the next draft.
  const canStage =
    !compact && primary !== "Accept" && primary !== "Merge" && (f.suggestion_kind !== "section_text" || f.suggestion_status === "dismissed");
  // qa-company-29: one rule on every row: the first action is the bordered one, the rest are
  // text. With no suggestion to act on, Stage for agents leads, else Open; Decline never does.
  const lead: "primary" | "stage" | "open" = primary ? "primary" : canStage ? "stage" : "open";
  const stage = canStage && (
    <Button
      variant={lead === "stage" ? "secondary" : "ghost"}
      disabled={busy}
      onClick={() =>
        void run(
          () => unwrap(api.POST("/v1/feedback/{feedback_id}/stage-for-agents", feedbackPath(f.id))),
          "Staged",
          { message: `Staged for draft ${(f.latest_version ?? f.raised_on_version) + 1} · agents: ${f.summary}` },
        )
      }
    >
      Stage for agents
    </Button>
  );
  const openLink = (
    <LinkButton variant={lead === "open" ? "secondary" : "ghost"} href={href} aria-label={`Open ${f.summary}`}>
      Open
    </LinkButton>
  );
  const decline = primary !== "Merge" && (
    <Button variant="ghost" disabled={busy} onClick={() => open("decline")}>
      Decline
    </Button>
  );
  return (
    <span
      data-inbox-actions
      className="inline-flex flex-wrap items-center justify-end gap-1.5 whitespace-nowrap min-[601px]:flex-nowrap max-[600px]:flex max-[600px]:w-full max-[600px]:justify-start"
    >
      {primary && (
        <Button disabled={busy} onClick={onPrimary}>
          {primary}
        </Button>
      )}
      {lead === "stage" && stage}
      {lead === "open" && openLink}
      {(!compact || !primary) && decline}
      {lead !== "stage" && stage}
      {lead !== "open" && openLink}
      {errorLine}
    </span>
  );
}

/**
 * The item's text, linking to it; hovering or focusing it shows Oracle's suggested text
 * (its first 280 characters; the document has all of it).
 */
export function SuggestionPeek({ href, summary, text }: { href: string; summary: string; text: string | null | undefined }) {
  const id = useId();
  const ref = useRef<HTMLAnchorElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // qa-company-15: the item's own text, cut with "…" in the row, heads the peek in full.
  const [cut, setCut] = useState(false);
  const show = () => {
    const el = ref.current;
    const r = el?.getBoundingClientRect();
    if (!el || !r) return;
    setCut(el.scrollWidth > el.clientWidth + 1);
    const room = document.documentElement.clientWidth;
    setAt({ left: Math.max(12, Math.min(r.left, room - 432)), top: r.bottom + 6 });
  };
  const hide = () => setAt(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [at]);
  return (
    <>
      <Link
        ref={ref}
        href={href}
        className="min-w-0 truncate hover:underline"
        title={text ? undefined : summary}
        aria-describedby={text ? id : undefined}
        onMouseEnter={text ? show : undefined}
        onMouseLeave={hide}
        onFocus={text ? show : undefined}
        onBlur={hide}
      >
        {summary}
      </Link>
      {text && (
        <span
          id={id}
          role="tooltip"
          hidden={!at}
          data-testid="suggestion-peek"
          style={at ?? undefined}
          className="fixed z-50 w-max max-w-[min(420px,calc(100vw-24px))] rounded-button bg-tip px-3.5 py-2.5 text-left text-sm leading-5 font-normal whitespace-pre-wrap text-tip-text shadow-tip"
        >
          {cut && (
            <span className="mb-2 block" data-testid="suggestion-peek-summary">
              {summary}
            </span>
          )}
          <span className="mb-1 block font-semibold">Oracle suggests</span>
          {text}
        </span>
      )}
    </>
  );
}

/**
 * After a row's action: reload what changed (the rail badge reads the same reloads) and say
 * what happened for 10 s, with Undo where the routes allow it.
 */
export function useActed(reload: () => Promise<unknown>) {
  const [acted, setActed] = useState<Acted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (!acted) return;
    const t = window.setTimeout(() => setActed(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [acted]);

  async function refresh() {
    invalidateWaiting();
    const reloads = reload();
    waitingChanged();
    await reloads;
  }

  const onActed: OnActed = (a) => {
    setActed(a);
    setError(null);
    void refresh();
  };

  /**
   * qa-company-42: another action on the page (the caller reloads): the banner says what it
   * did, replacing the last one's; with no message, the last one's simply goes.
   */
  const say = (message: string | null) => {
    setActed(message ? { id: `said-${Date.now()}`, message } : null);
    setError(null);
  };

  async function undo() {
    if (!acted?.undo) return;
    setUndoing(true);
    try {
      await acted.undo();
      setActed(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUndoing(false);
    }
  }

  const notice =
    acted || error ? (
      <div
        role="status"
        data-testid="inbox-acted"
        className="mx-4 mt-3 flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface2 px-3 py-1.5 text-[15px] max-[600px]:mx-3"
      >
        {acted && <span className="min-w-0 flex-1 truncate font-medium max-[600px]:whitespace-normal">{acted.message}</span>}
        {error && <span className="text-sm text-crit">{error}</span>}
        {acted?.undo && (
          <Button variant="ghost" disabled={undoing} onClick={() => void undo()}>
            Undo
          </Button>
        )}
      </div>
    ) : null;
  return { onActed, notice, say };
}

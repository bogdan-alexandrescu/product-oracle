"use client";

import { useState } from "react";

import { Avatar, Button, Chip, Icon, type ChipKind } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Suggestion } from "@/lib/api/client";
import { CLASSIFICATION_LABEL } from "@/lib/format";
import { plainText } from "@/lib/markdown";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

const STATUS: Record<Suggestion["status"], { label: string; kind: ChipKind }> = {
  open: { label: "Suggested", kind: "warn" },
  accepted: { label: "Accepted", kind: "pass" },
  dismissed: { label: "Dismissed", kind: "na" },
  applied: { label: "Applied", kind: "pass" },
  superseded: { label: "Superseded", kind: "na" },
};

/** qa4-docs-20: how strong a pushback's source is, in words; never the raw 0..1 score. */
function evidenceWord(confidence: number): string {
  if (confidence >= 0.7) return "strong evidence";
  if (confidence >= 0.4) return "fair evidence";
  return "weak evidence";
}

type Mode = null | "edit" | "keep" | "dismiss";

/** Proposed text longer than this is collapsed to a few lines until "Show all". */
const LONG_CHARS = 240;
const LONG_LINES = 4;

/**
 * An approver's decision on a suggestion: accept, edit and accept, keep their call over a
 * pushback, or dismiss. The feedback item draws the buttons and the open form at its top.
 */
export function useSuggestionDecision(s: Suggestion, onChanged: () => void) {
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState(s.edited_text ?? s.text ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      setMode(null);
      onChanged();
      // What is staged and what waits in the Inbox changed: the build action and the badge re-read.
      invalidateWaiting();
      waitingChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const path = { params: { path: { suggestion_id: s.id } } };
  const acceptCall = (body: { text?: string | null; reason?: string | null }) =>
    unwrap(api.POST("/v1/suggestions/{suggestion_id}/accept", { ...path, body }));
  const saveCall = () => unwrap(api.PATCH("/v1/suggestions/{suggestion_id}", { ...path, body: { text } }));
  return {
    s,
    mode,
    setMode,
    text,
    setText,
    reason,
    setReason,
    busy,
    error,
    accept: (body: { text?: string | null; reason?: string | null }) => run(() => acceptCall(body)),
    dismiss: (decline: boolean) =>
      run(() =>
        unwrap(api.POST("/v1/suggestions/{suggestion_id}/dismiss", { ...path, body: { reason: reason || null, decline } })),
      ),
    saveEdit: () => run(saveCall),
    // The edited text is saved on the suggestion, then accepted.
    acceptEdited: () =>
      run(async () => {
        await saveCall();
        await acceptCall({});
      }),
  };
}

export type SuggestionDecision = ReturnType<typeof useSuggestionDecision>;

const editable = (s: Suggestion) => s.kind === "section_text" || s.kind === "answer";

/** The buttons for an open suggestion; empty once it is decided or while a form is open. */
export function SuggestionActions({ d }: { d: SuggestionDecision }) {
  const { s, busy, mode, setMode } = d;
  if (s.status !== "open" || mode !== null) return null;
  return (
    <>
      {s.pushback ? (
        <>
          <Button variant="solid" icon="check" disabled={busy} onClick={() => d.dismiss(true)}>
            Take the advice
          </Button>
          {/* qa4-docs-52: the button names the outcome (accepting against the advice). */}
          <Button disabled={busy} onClick={() => setMode("keep")}>
            Accept anyway
          </Button>
        </>
      ) : (
        <Button variant="solid" icon="check" disabled={busy} onClick={() => d.accept({})}>
          Accept
        </Button>
      )}
      {editable(s) && (
        <Button disabled={busy} onClick={() => setMode("edit")}>
          {s.pushback ? "Edit" : "Edit and accept"}
        </Button>
      )}
      <Button variant="ghost" disabled={busy} onClick={() => setMode("dismiss")}>
        Dismiss
      </Button>
    </>
  );
}

/** The open form (edit, keep my call, dismiss) and any error, under the buttons. */
export function SuggestionForm({ d }: { d: SuggestionDecision }) {
  const { s, mode, setMode, busy, text, setText, reason, setReason } = d;
  return (
    <>
      {mode === "edit" && (
        <div className="mt-2 flex flex-col gap-2">
          <label className={FIELD_LABEL}>
            {s.kind === "answer" ? "Answer" : "Proposed section text"}
            <textarea
              autoFocus
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={`${TEXTAREA} max-h-[50vh] min-h-24 resize-y`}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {!s.pushback && (
              <Button variant="solid" icon="check" disabled={busy || !text.trim()} onClick={d.acceptEdited}>
                Accept edited text
              </Button>
            )}
            <Button variant={s.pushback ? "solid" : "secondary"} disabled={busy || !text.trim()} onClick={d.saveEdit}>
              Save edit
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === "keep" && (
        <div className="mt-2 flex flex-col gap-2">
          <label className={FIELD_LABEL}>
            Why accept against the advice? (logged for later review)
            <textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
          </label>
          <div className="flex gap-1.5">
            <Button variant="solid" disabled={busy || !reason.trim()} onClick={() => d.accept({ reason })}>
              Accept against the advice
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === "dismiss" && (
        <div className="mt-2 flex flex-col gap-2">
          <label className={FIELD_LABEL}>
            Reason (optional)
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={`h-9 ${TEXTAREA}`} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button disabled={busy} onClick={() => d.dismiss(false)}>
              Dismiss, keep feedback open
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => d.dismiss(true)}>
              Dismiss and decline feedback
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {d.error && <InlineError>{d.error}</InlineError>}
    </>
  );
}

/**
 * Oracle's suggestion on a feedback item: its classification and group, the proposed
 * section text or answer (long text collapsed to a few lines), and a pushback when the
 * feedback contradicts confirmed goals or high-confidence evidence. The decision buttons sit
 * at the top of the feedback item (SuggestionActions); nothing changes the document until
 * the next draft built from it is applied (C1e: accepted section text is staged; "Build
 * draft N+1" on the PRD page builds every staged change in one job).
 */
export function SuggestionCard({
  suggestion: s,
  canDecide,
  editing = false,
  heading,
}: {
  suggestion: Suggestion;
  canDecide: boolean;
  /** qa-docs-72: the title of the section the text is for (never its internal key). */
  heading?: string;
  /** The editor is open at the item's top: the text is not shown twice. */
  editing?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // qa4-docs-11: the proposed text is markdown; it reads as plain text (no "**").
  const raw = s.edited_text ?? s.text;
  const shown = raw ? plainText(raw) : raw;
  const long = !!shown && (shown.length > LONG_CHARS || shown.split("\n").length > LONG_LINES);
  const collapsed = long && !expanded;

  return (
    <div className="mt-2.5 rounded-button border border-line bg-surface2 px-3 py-2.5" data-testid="suggestion" data-kind={s.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name="Oracle" initials="O" tone="oracle" />
        <span className="font-semibold">Oracle</span>
        <Chip kind="line">{CLASSIFICATION_LABEL[s.classification]}</Chip>
        {/* qa-docs-12: the grouping key is Oracle's own, not shown to people. */}
        <span className="ml-auto">
          <Chip kind={STATUS[s.status].kind}>{STATUS[s.status].label}</Chip>
        </span>
      </div>
      {/* qa4-docs-12: an open duplicate is not resolved yet: it closes when the earlier item does. */}
      {s.kind === "duplicate" && (
        <p className="mt-1.5 text-sm text-text2" data-testid="duplicate-note">
          {s.status === "open" ? "Duplicate of an earlier item; resolved when that one is." : "Duplicate of an earlier item; resolved with it."}
        </p>
      )}
      {shown && !editing && (
        <div className="mt-2">
          <p className="text-[13px] font-semibold tracking-[0.02em] text-text2">
            {s.kind === "answer" ? "Suggested answer" : heading ? `Proposed text for ${heading}` : "Proposed text for this section"}
            {s.edited_text && " (edited)"}
          </p>
          <div className="mt-1 rounded-lg border border-line bg-surface px-2.5 py-2">
            <p
              className={`text-sm leading-5 whitespace-pre-wrap text-text ${collapsed ? "line-clamp-4" : ""}`}
              data-testid="suggestion-text"
              data-collapsed={long ? String(collapsed) : undefined}
            >
              {collapsed ? shown.replace(/\n\s*\n/g, "\n") : shown}
            </p>
          </div>
          {long && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 h-7 rounded-md px-1 text-sm font-semibold text-accent-ink hover:underline"
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
      {s.rationale && <p className="mt-1.5 text-sm leading-5 text-text2">{s.rationale}</p>}
      {s.pushback && (
        <div className="mt-2 rounded-lg bg-warn-bg px-2.5 py-2 text-sm leading-5 text-warn" data-testid="pushback" role="note">
          <p className="font-semibold">Oracle pushes back</p>
          <p className="mt-0.5 text-text">{s.pushback.reason}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {s.pushback.sources.map((src) => (
              <li key={src.ref} className="text-text">
                <span className="font-semibold text-warn">{src.kind === "goal" ? "Confirmed goal" : "Evidence"}: </span>
                {src.url ? (
                  <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    {src.title}
                  </a>
                ) : (
                  src.title
                )}
                {src.confidence != null && <span className="text-text2" data-testid="pushback-strength"> · {evidenceWord(src.confidence)}</span>}
                {src.excerpt && <span className="block text-text2">“{src.excerpt}”</span>}
              </li>
            ))}
          </ul>
          {s.override_reason && (
            <p className="mt-1 text-text">
              <span className="font-semibold">Accepted against the advice:</span> {s.override_reason}
            </p>
          )}
        </div>
      )}
      {canDecide && s.status === "accepted" && s.kind === "section_text" && s.applied_in_version == null && (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm font-medium text-text2" data-testid="suggestion-staged">
          <Icon name="doc" size={16} />
          Staged for the next draft
        </p>
      )}
    </div>
  );
}

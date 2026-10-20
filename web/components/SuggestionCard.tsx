"use client";

import { useState } from "react";

import { Avatar, Button, Chip, type ChipKind } from "@/components/ds";
import { FIELD_LABEL, InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Suggestion } from "@/lib/api/client";
import { CLASSIFICATION_LABEL } from "@/lib/format";

const STATUS: Record<Suggestion["status"], { label: string; kind: ChipKind }> = {
  open: { label: "Suggested", kind: "warn" },
  accepted: { label: "Accepted", kind: "pass" },
  dismissed: { label: "Dismissed", kind: "na" },
  applied: { label: "Applied", kind: "pass" },
  superseded: { label: "Superseded", kind: "na" },
};

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
          <Button disabled={busy} onClick={() => setMode("keep")}>
            Keep my call
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
            Why keep your call? (logged for later review)
            <textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
          </label>
          <div className="flex gap-1.5">
            <Button variant="solid" disabled={busy || !reason.trim()} onClick={() => d.accept({ reason })}>
              Accept anyway
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
              Dismiss suggestion
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => d.dismiss(true)}>
              Dismiss and decline the feedback
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
 * at the top of the feedback item (SuggestionActions); nothing changes the document until a
 * refinement built from an accepted suggestion is accepted.
 */
export function SuggestionCard({
  suggestion: s,
  canDecide,
  editing = false,
}: {
  suggestion: Suggestion;
  canDecide: boolean;
  /** The editor is open at the item's top: the text is not shown twice. */
  editing?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = s.edited_text ?? s.text;
  const long = !!shown && (shown.length > LONG_CHARS || shown.split("\n").length > LONG_LINES);
  const collapsed = long && !expanded;

  return (
    <div className="mt-2.5 rounded-button border border-line bg-surface2 px-3 py-2.5" data-testid="suggestion" data-kind={s.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name="Oracle" initials="O" tone="oracle" />
        <span className="font-semibold">Oracle</span>
        <Chip kind="line">{CLASSIFICATION_LABEL[s.classification]}</Chip>
        {s.group_key && (
          <span className="truncate font-mono text-[13px] text-text2" title={`group: ${s.group_key}`}>
            {s.group_key}
          </span>
        )}
        <span className="ml-auto">
          <Chip kind={STATUS[s.status].kind}>{STATUS[s.status].label}</Chip>
        </span>
      </div>
      {s.kind === "duplicate" && <p className="mt-1.5 text-sm text-text2">Duplicate of an earlier item; resolved with it.</p>}
      {shown && !editing && (
        <div className="mt-2">
          <p className="text-[13px] font-semibold tracking-[0.02em] text-text2">
            {s.kind === "answer" ? "Suggested answer" : `Proposed text for #${s.section_key}`}
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
                {src.confidence != null && <span className="tnum text-text2"> · confidence {src.confidence.toFixed(2)}</span>}
                {src.excerpt && <span className="block text-text2">“{src.excerpt}”</span>}
              </li>
            ))}
          </ul>
          {s.override_reason && (
            <p className="mt-1 text-text">
              <span className="font-semibold">Kept the call:</span> {s.override_reason}
            </p>
          )}
        </div>
      )}
      {canDecide && s.status === "accepted" && s.kind === "section_text" && (
        <p className="mt-1.5 text-sm text-text2">Accepted: use “Refine section” on #{s.section_key} for the next version.</p>
      )}
    </div>
  );
}

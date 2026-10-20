"use client";

import { useState } from "react";

import { Avatar, Button, Chip, Icon, type ChipKind } from "@/components/ds";
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

/** The approver's controls on a suggestion: the action buttons and the form each one opens. */
export function useSuggestionControls(s: Suggestion, canDecide: boolean, onChanged: () => void) {
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState(s.edited_text ?? s.text ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = s.kind === "section_text" || s.kind === "answer";

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
  const accept = (body: { text?: string | null; reason?: string | null }) =>
    run(() => unwrap(api.POST("/v1/suggestions/{suggestion_id}/accept", { ...path, body })));
  const dismiss = (decline: boolean) =>
    run(() =>
      unwrap(api.POST("/v1/suggestions/{suggestion_id}/dismiss", { ...path, body: { reason: reason || null, decline } })),
    );
  const saveEdit = () => run(() => unwrap(api.PATCH("/v1/suggestions/{suggestion_id}", { ...path, body: { text } })));

  const actions =
    canDecide && s.status === "open" && mode === null ? (
      <div className="flex flex-wrap gap-1.5" data-testid="suggestion-actions">
        {s.pushback ? (
          <>
            <Button variant="solid" icon="check" disabled={busy} onClick={() => dismiss(true)}>
              Take the advice
            </Button>
            <Button disabled={busy} onClick={() => setMode("keep")}>
              Keep my call
            </Button>
          </>
        ) : (
          <Button variant="solid" icon="check" disabled={busy} onClick={() => accept({})}>
            Accept
          </Button>
        )}
        {editable && (
          <Button disabled={busy} onClick={() => setMode("edit")}>
            Edit
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => setMode("dismiss")}>
          Dismiss
        </Button>
      </div>
    ) : null;

  const forms = (
    <>
      {mode === "edit" && (
        <div className="mt-2 flex flex-col gap-2">
          <label className={FIELD_LABEL}>
            {s.kind === "answer" ? "Answer" : "Proposed section text"}
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
          </label>
          <div className="flex gap-1.5">
            <Button variant="solid" icon="check" disabled={busy || !text.trim()} onClick={saveEdit}>
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
            <Button variant="solid" disabled={busy || !reason.trim()} onClick={() => accept({ reason })}>
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
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={`h-9 ${TEXTAREA}`} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button disabled={busy} onClick={() => dismiss(false)}>
              Dismiss suggestion
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => dismiss(true)}>
              Dismiss and decline the feedback
            </Button>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
    </>
  );
  return { actions, forms, editing: mode === "edit" };
}

/**
 * Oracle's suggestion on a feedback item: its classification and group, the proposed
 * section text (folded when long) or answer, and a pushback when the feedback contradicts
 * confirmed goals or high-confidence evidence. Approvers accept, edit or dismiss it with
 * the controls from useSuggestionControls, which the feedback card puts at its top;
 * nothing changes the document until a draft built from it is applied.
 */
export function SuggestionCard({ suggestion: s, editing = false }: { suggestion: Suggestion; editing?: boolean }) {
  const shown = s.edited_text ?? s.text;
  const long = !!shown && shown.length > 160;
  return (
    <div className="mt-2.5 rounded-button border border-line bg-surface2 px-3 py-2.5" data-testid="suggestion" data-kind={s.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name="Oracle" initials="O" tone="oracle" />
        <span className="font-semibold">Oracle</span>
        <Chip kind="line">{CLASSIFICATION_LABEL[s.classification]}</Chip>
        {s.group_key && (
          <span className="min-w-0 truncate font-mono text-[13px] text-text2" title={`group: ${s.group_key}`}>
            {s.group_key}
          </span>
        )}
        <span className="ml-auto">
          <Chip kind={STATUS[s.status].kind}>{STATUS[s.status].label}</Chip>
        </span>
      </div>
      {s.kind === "duplicate" && <p className="mt-1.5 text-sm text-text2">Duplicate of an earlier item; resolved with it.</p>}
      {shown && !editing && (
        <details className="group mt-2" open={!long || undefined} data-testid="suggestion-proposed">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold tracking-[0.02em] text-text2 hover:text-text [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" size={16} className="transition-transform group-open:rotate-90" />
            {s.kind === "answer" ? "Suggested answer" : `Proposed text for #${s.section_key}`}
            {s.edited_text && " (edited)"}
          </summary>
          <p
            className="mt-1 rounded-lg border border-line bg-surface px-2.5 py-2 text-sm leading-5 break-words whitespace-pre-wrap text-text"
            data-testid="suggestion-text"
          >
            {shown}
          </p>
        </details>
      )}
      {s.rationale && <p className="mt-1.5 text-sm leading-5 text-text2">{s.rationale}</p>}
      {s.pushback && (
        <div className="mt-2 rounded-lg bg-warn-bg px-2.5 py-2 text-sm leading-5 text-warn" data-testid="pushback" role="note">
          <p className="font-semibold">Oracle pushes back</p>
          <p className="mt-0.5 text-text">{s.pushback.reason}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {s.pushback.sources.map((src) => (
              <li key={src.ref} className="break-words text-text">
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
      {s.status === "accepted" && s.kind === "section_text" && (
        <p className="mt-1.5 text-sm text-text2">Accepted: use “Refine section” on #{s.section_key} for the next version.</p>
      )}
    </div>
  );
}

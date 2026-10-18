"use client";

import { useState } from "react";

import { Badge, Button, INPUT } from "@/components/ui";
import { api, unwrap, type Suggestion } from "@/lib/api/client";
import { CLASSIFICATION_LABEL } from "@/lib/format";

const STATUS: Record<Suggestion["status"], { label: string; tone: "neutral" | "green" | "blue" }> = {
  open: { label: "Suggested", tone: "blue" },
  accepted: { label: "Accepted", tone: "green" },
  dismissed: { label: "Dismissed", tone: "neutral" },
  applied: { label: "Applied", tone: "green" },
  superseded: { label: "Superseded", tone: "neutral" },
};

type Mode = null | "edit" | "keep" | "dismiss";

/**
 * Oracle's suggestion on a feedback item: its classification and group, the proposed
 * section text or answer, and a pushback when the feedback contradicts confirmed goals or
 * high-confidence evidence. Approvers accept, edit or dismiss it; nothing changes the
 * document until a refinement built from it is accepted.
 */
export function SuggestionCard({
  suggestion: s,
  canDecide,
  onChanged,
}: {
  suggestion: Suggestion;
  canDecide: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState(s.edited_text ?? s.text ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = s.edited_text ?? s.text;
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

  return (
    <div className="mt-2 rounded-md border border-sky-200 bg-sky-50/50 px-2.5 py-2" data-testid="suggestion" data-kind={s.kind}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-sky-900">Oracle</span>
        <Badge>{CLASSIFICATION_LABEL[s.classification]}</Badge>
        {s.group_key && <span className="text-neutral-500">group: {s.group_key}</span>}
        <span className="ml-auto">
          <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
        </span>
      </div>
      {s.kind === "duplicate" && <p className="mt-1 text-xs text-neutral-700">Duplicate of an earlier item; resolved with it.</p>}
      {shown && mode !== "edit" && (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-neutral-500 uppercase">
            {s.kind === "answer" ? "Suggested answer" : `Proposed text for #${s.section_key}`}
            {s.edited_text && " (edited)"}
          </p>
          <p className="mt-0.5 rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs whitespace-pre-wrap text-neutral-800" data-testid="suggestion-text">
            {shown}
          </p>
        </div>
      )}
      {s.rationale && <p className="mt-1 text-xs text-neutral-600">{s.rationale}</p>}
      {s.pushback && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950" data-testid="pushback" role="note">
          <p className="font-medium">Oracle pushes back</p>
          <p className="mt-0.5">{s.pushback.reason}</p>
          <ul className="mt-1 list-disc pl-4">
            {s.pushback.sources.map((src) => (
              <li key={src.ref}>
                <span className="text-amber-800">{src.kind === "goal" ? "Confirmed goal" : "Evidence"}: </span>
                {src.url ? (
                  <a href={src.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    {src.title}
                  </a>
                ) : (
                  src.title
                )}
                {src.confidence != null && <span className="text-amber-800"> · confidence {src.confidence.toFixed(2)}</span>}
                {src.excerpt && <span className="block text-amber-900/80">“{src.excerpt}”</span>}
              </li>
            ))}
          </ul>
          {s.override_reason && (
            <p className="mt-1">
              <span className="font-medium">Kept the call:</span> {s.override_reason}
            </p>
          )}
        </div>
      )}

      {canDecide && s.status === "open" && mode === null && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {s.pushback ? (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => dismiss(true)}>
                Take the advice
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setMode("keep")}>
                Keep my call
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => accept({})}>
              Accept
            </Button>
          )}
          {editable && (
            <Button size="sm" disabled={busy} onClick={() => setMode("edit")}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("dismiss")}>
            Dismiss
          </Button>
        </div>
      )}
      {canDecide && s.status === "accepted" && s.kind === "section_text" && (
        <p className="mt-1.5 text-xs text-neutral-600">Accepted: use “Refine section” on #{s.section_key} to work it into the next version.</p>
      )}

      {mode === "edit" && (
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            {s.kind === "answer" ? "Answer" : "Proposed section text"}
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} className={INPUT} />
          </label>
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={saveEdit}>
              Save edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === "keep" && (
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            Why keep your call? (logged for later review)
            <textarea autoFocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
          </label>
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" disabled={busy || !reason.trim()} onClick={() => accept({ reason })}>
              Accept anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === "dismiss" && (
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            Reason (optional)
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => dismiss(false)}>
              Dismiss suggestion
            </Button>
            <Button size="sm" disabled={busy} onClick={() => dismiss(true)}>
              Dismiss and decline the feedback
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

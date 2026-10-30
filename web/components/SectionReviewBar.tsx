"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button, Chip, type IconName } from "@/components/ds";
import { FIELD_LABEL, InlineError, LockedChip, TEXTAREA, VerdictChip } from "@/components/review/parts";
import type { Schemas, Verdict } from "@/lib/api/client";
import { formatDateTime, VERDICT_LABEL } from "@/lib/format";

const ACTIONS: { verdict: Verdict; label: string; icon: IconName }[] = [
  { verdict: "approved", label: "Approve", icon: "check" },
  { verdict: "changes_requested", label: "Request changes", icon: "comment" },
  { verdict: "rejected", label: "Reject", icon: "x" },
];

/**
 * qa-docs-51: the same rule as the spec design review: Request changes and Reject need a note
 * saying what should change; Approve's note is optional.
 */
const NOTE_REQUIRED: Record<Verdict, boolean> = { approved: false, changes_requested: true, rejected: true };

/** Per-section verdict: approve, or request changes / reject with a note saying what should change. */
export function SectionReviewBar({
  heading,
  verdict,
  readOnly,
  onSubmit,
}: {
  heading: string;
  verdict?: Schemas["SectionVerdict"] | null;
  readOnly?: boolean;
  onSubmit: (verdict: Verdict, note: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  // qa-docs-9: the opened note and its Save scroll clear of a phone's bottom bars (the page's
  // scroll padding), not left under them.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (draft) formRef.current?.scrollIntoView({ block: "nearest" });
  }, [draft]);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!draft || (NOTE_REQUIRED[draft] && !note.trim())) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(draft, note.trim());
      setDraft(null);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the verdict.");
    } finally {
      setSaving(false);
    }
  }

  // A lapsed approval (approver demoted or removed, token or grant revoked) never counts.
  const lapsed = verdict?.verdict === "approved" && Boolean(verdict.lapsed_at);
  const locked = verdict?.verdict === "approved" && !lapsed;

  return (
    <div className="mt-4 rounded-button border border-line bg-surface2" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="verdict-state">
          {verdict ? (
            <>
              {lapsed ? (
                <Chip kind="warn" data-testid="verdict-lapsed" title={verdict.lapse_reason ?? "This approval no longer counts"}>
                  Lapsed
                </Chip>
              ) : (
                <VerdictChip verdict={verdict.verdict} />
              )}
              {locked && <LockedChip />}
              {verdict.note && (
                <span className="min-w-0 truncate text-sm text-text" title={verdict.note}>
                  “{verdict.note}”
                </span>
              )}
              <span className="tnum flex-none text-[13px] text-text2 max-[600px]:hidden">{formatDateTime(verdict.created_at)}</span>
            </>
          ) : (
            // qa-docs-48: the text colour, not the muted status grey, so it reads at 4.5:1 or better on
            // the bar and on a selected row, light and dark.
            <Chip kind="line" data-testid="verdict-none">
              Not reviewed
            </Chip>
          )}
        </div>
        {!readOnly && (
          // qa-docs-12: a phone keeps one row of three with the full labels (no "Changes" for
          // Request changes): the icons give way instead.
          <div
            role="group"
            aria-label={`Verdict for ${heading}`}
            className="flex flex-wrap gap-1.5 max-[600px]:w-full max-[600px]:flex-nowrap"
          >
            {ACTIONS.map((a) => (
              <Button
                key={a.verdict}
                icon={a.icon}
                variant={draft === a.verdict ? "solid" : "secondary"}
                aria-pressed={verdict?.verdict === a.verdict}
                className="max-[600px]:min-w-0 max-[600px]:flex-auto max-[600px]:px-2 max-[600px]:[&>svg]:hidden"
                onClick={() => setDraft((d) => (d === a.verdict ? null : a.verdict))}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {draft && (
        <form ref={formRef} onSubmit={save} className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          <label className={FIELD_LABEL}>
            {draft === "approved" ? "Note (optional)" : "What should change?"}
            <textarea
              autoFocus
              rows={2}
              required={NOTE_REQUIRED[draft]}
              aria-describedby={NOTE_REQUIRED[draft] ? hintId : undefined}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                if (e.key === "Escape") setDraft(null);
              }}
              className={TEXTAREA}
            />
          </label>
          {NOTE_REQUIRED[draft] && (
            <p id={hintId} data-testid="verdict-note-hint" className="text-[13px] leading-4 text-text2">
              Needed to {draft === "rejected" ? "reject" : "request changes"}: the writer sees it.
            </p>
          )}
          {error && <InlineError>{error}</InlineError>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="solid" icon="check" disabled={saving || (NOTE_REQUIRED[draft] && !note.trim())}>
              {saving ? "Saving…" : `Save: ${VERDICT_LABEL[draft]}`}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            {/* qa-docs-5: a disabled Save says what it waits for. */}
            {NOTE_REQUIRED[draft] && !note.trim() && !saving && (
              <span data-testid="verdict-save-hint" className="text-[13px] text-text2">
                Write a note first
              </span>
            )}
            <span className="ml-auto text-[13px] text-text2 max-[600px]:hidden">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      )}
    </div>
  );
}

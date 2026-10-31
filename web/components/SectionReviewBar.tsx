"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button, Chip, type IconName } from "@/components/ds";
import { FIELD_LABEL, InlineError, LockedChip, TEXTAREA, VERDICT_KIND, VerdictChip } from "@/components/review/parts";
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
  readOnlyNote,
  onSubmit,
}: {
  heading: string;
  verdict?: Schemas["SectionVerdict"] | null;
  readOnly?: boolean;
  /** qa-docs-77: read-only, who may review instead (a short line beside the state). */
  readOnlyNote?: string;
  onSubmit: (verdict: Verdict, note: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  // qa-docs-74: the state reads the choice being made until it is saved or cancelled.
  const needsNote = !!draft && NOTE_REQUIRED[draft] && !note.trim();
  const pending = !readOnly && draft && draft !== verdict?.verdict ? draft : null;
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

  const state = verdict ? (
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
      <span className="tnum flex-none text-[13px] whitespace-nowrap text-text2 max-[600px]:hidden" data-testid="verdict-date">
        {formatDateTime(verdict.created_at)}
      </span>
    </>
  ) : (
    // qa-docs-48: the text colour, not the muted status grey, so it reads at 4.5:1 or better on
    // the bar and on a selected row, light and dark.
    <Chip kind="line" data-testid="verdict-none">
      Not reviewed
    </Chip>
  );

  // qa-docs-77: someone who may not review sees one compact status line, and who can.
  if (readOnly)
    return (
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="review-bar">
        <div className="flex min-w-0 items-center gap-2" data-testid="verdict-state">
          {state}
        </div>
        {readOnlyNote && (
          <span className="text-[13px] text-text2" data-testid="review-bar-note">
            {readOnlyNote}
          </span>
        )}
      </div>
    );

  return (
    <div className="mt-4 rounded-button border border-line bg-surface2" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        {/* The state wraps within its own room (14rem at least, else the buttons go to the next
            line): never under the buttons. */}
        <div className="flex min-w-0 flex-[1_1_14rem] flex-wrap items-center gap-x-2 gap-y-1" data-testid="verdict-state">
          {pending ? (
            <>
              <Chip kind={VERDICT_KIND[pending]} data-testid="verdict-pending">
                {VERDICT_LABEL[pending]}
              </Chip>
              <span className="text-[13px] whitespace-nowrap text-text2">Not saved yet</span>
            </>
          ) : (
            state
          )}
        </div>
        {/* One Approve per bar: while a verdict is being written its form's button says the
            action (and Cancel goes back to the three), so the three are not shown twice over. */}
        {!readOnly && !draft && (
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
              aria-describedby={needsNote ? hintId : undefined}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                if (e.key === "Escape") setDraft(null);
              }}
              className={TEXTAREA}
            />
          </label>
          {error && <InlineError>{error}</InlineError>}
          <div className="flex flex-wrap items-center gap-2">
            {/* qa-docs-74: the button says the action it takes, not the state it saves. */}
            <Button
              type="submit"
              variant="solid"
              icon={ACTIONS.find((a) => a.verdict === draft)!.icon}
              disabled={saving || needsNote}
              data-testid="verdict-submit"
            >
              {saving ? "Saving…" : ACTIONS.find((a) => a.verdict === draft)!.label}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            {/* qa-docs-5, qa-docs-74: one hint, saying what the disabled button waits for and why. */}
            {needsNote && !saving && (
              <span id={hintId} data-testid="verdict-save-hint" className="text-[13px] text-text2">
                Write a note first: the writer sees it
              </span>
            )}
            <span className="ml-auto text-[13px] text-text2 max-[600px]:hidden">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      )}
    </div>
  );
}

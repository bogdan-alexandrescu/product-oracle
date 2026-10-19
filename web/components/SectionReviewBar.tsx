"use client";

import { useState, type FormEvent } from "react";

import { Button, Chip, type IconName } from "@/components/ds";
import { FIELD_LABEL, InlineError, LockedChip, TEXTAREA, VerdictChip } from "@/components/review/parts";
import type { Schemas, Verdict } from "@/lib/api/client";
import { formatDateTime, VERDICT_LABEL } from "@/lib/format";

const ACTIONS: { verdict: Verdict; label: string; icon: IconName }[] = [
  { verdict: "approved", label: "Approve", icon: "check" },
  { verdict: "changes_requested", label: "Request changes", icon: "comment" },
  { verdict: "rejected", label: "Reject", icon: "x" },
];

/** Per-section verdict: approve / request changes / reject, each with an optional note. */
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

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!draft) return;
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

  const locked = verdict?.verdict === "approved";

  return (
    <div className="mt-4 rounded-button border border-line bg-surface2" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="verdict-state">
          {verdict ? (
            <>
              <VerdictChip verdict={verdict.verdict} />
              {locked && <LockedChip />}
              {verdict.note && (
                <span className="min-w-0 truncate text-sm text-text" title={verdict.note}>
                  “{verdict.note}”
                </span>
              )}
              <span className="tnum flex-none text-[13px] text-text2 max-[600px]:hidden">{formatDateTime(verdict.created_at)}</span>
            </>
          ) : (
            <Chip kind="na">Not reviewed</Chip>
          )}
        </div>
        {!readOnly && (
          <div role="group" aria-label={`Verdict for ${heading}`} className="flex flex-wrap gap-1.5">
            {ACTIONS.map((a) => (
              <Button
                key={a.verdict}
                icon={a.icon}
                variant={draft === a.verdict ? "solid" : "secondary"}
                aria-pressed={verdict?.verdict === a.verdict}
                onClick={() => setDraft((d) => (d === a.verdict ? null : a.verdict))}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {draft && (
        <form onSubmit={save} className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
          <label className={FIELD_LABEL}>
            {draft === "approved" ? "Note (optional)" : "What should change? (optional)"}
            <textarea
              autoFocus
              rows={2}
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
          <div className="flex items-center gap-2">
            <Button type="submit" variant="solid" icon="check" disabled={saving}>
              {saving ? "Saving…" : `Save: ${VERDICT_LABEL[draft]}`}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <span className="ml-auto text-[13px] text-text2 max-[600px]:hidden">Ctrl/⌘ + Enter</span>
          </div>
        </form>
      )}
    </div>
  );
}

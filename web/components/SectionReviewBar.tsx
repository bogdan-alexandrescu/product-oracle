"use client";

import { useState, type FormEvent } from "react";

import { Button, Chip, type IconName } from "@/components/ds";
import { FIELD_LABEL, InlineError, LockedChip, TEXTAREA, VerdictChip } from "@/components/review/parts";
import type { Schemas, Verdict } from "@/lib/api/client";
import { formatDateTime, VERDICT_LABEL } from "@/lib/format";

const ACTIONS: { verdict: Verdict; label: string; short?: string; icon: IconName }[] = [
  { verdict: "approved", label: "Approve", icon: "check" },
  { verdict: "changes_requested", label: "Request changes", short: "Changes", icon: "comment" },
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
            <Chip kind="na">Not reviewed</Chip>
          )}
        </div>
        {!readOnly && (
          // A phone gets one row of three: short labels, the full ones as the buttons' names.
          <div
            role="group"
            aria-label={`Verdict for ${heading}`}
            className="flex flex-wrap gap-1.5 max-[600px]:grid max-[600px]:w-full max-[600px]:grid-cols-3"
          >
            {ACTIONS.map((a) => (
              <Button
                key={a.verdict}
                icon={a.icon}
                variant={draft === a.verdict ? "solid" : "secondary"}
                aria-pressed={verdict?.verdict === a.verdict}
                aria-label={a.short ? a.label : undefined}
                className="max-[600px]:gap-1.5 max-[600px]:px-2"
                onClick={() => setDraft((d) => (d === a.verdict ? null : a.verdict))}
              >
                {a.short ? (
                  <>
                    <span className="max-[600px]:hidden">{a.label}</span>
                    <span className="min-[601px]:hidden">{a.short}</span>
                  </>
                ) : (
                  a.label
                )}
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

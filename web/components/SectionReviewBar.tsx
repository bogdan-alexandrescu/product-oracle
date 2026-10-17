"use client";

import { useState, type FormEvent } from "react";

import { Button, LockIcon, VerdictBadge } from "@/components/ui";
import type { Schemas, Verdict } from "@/lib/api/client";
import { formatDateTime, VERDICT_LABEL } from "@/lib/format";

const ACTIONS: { verdict: Verdict; label: string }[] = [
  { verdict: "approved", label: "Approve" },
  { verdict: "changes_requested", label: "Request changes" },
  { verdict: "rejected", label: "Reject" },
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
    <div className="mt-4 rounded-md border border-neutral-200 text-sm" data-testid="review-bar">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-neutral-600" data-testid="verdict-state">
          {verdict ? (
            <>
              <VerdictBadge verdict={verdict.verdict} />
              {locked && (
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium text-neutral-700"
                  title="Approved sections are reported as locked to the agent track"
                >
                  <LockIcon /> Locked
                </span>
              )}
              {verdict.note && <span className="truncate text-neutral-700">“{verdict.note}”</span>}
              <span className="shrink-0 text-xs text-neutral-400">{formatDateTime(verdict.created_at)}</span>
            </>
          ) : (
            <span className="text-neutral-500">Not reviewed</span>
          )}
        </div>
        {!readOnly && (
          <div role="group" aria-label={`Verdict for ${heading}`} className="flex gap-1">
            {ACTIONS.map((a) => (
              <Button
                key={a.verdict}
                size="sm"
                variant={draft === a.verdict ? "primary" : "secondary"}
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
        <form onSubmit={save} className="flex flex-col gap-2 border-t border-neutral-200 px-3 py-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
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
              className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900"
            />
          </label>
          {error && <p className="text-xs text-rose-700">{error}</p>}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={saving}>
              {saving ? "Saving…" : `Save: ${VERDICT_LABEL[draft]}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <span className="ml-auto text-xs text-neutral-400">Ctrl/⌘ + Enter to save</span>
          </div>
        </form>
      )}
    </div>
  );
}

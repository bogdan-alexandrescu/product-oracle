"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import type { Update } from "./lib";

/**
 * Who sees an update (owners only; H8 §5): Share with the whole company, or back to owners and
 * approvers, always with a reason (the change is audited with it).
 */
export function VisibilityDialog({ update, onClose, onChanged }: { update: Update; onClose: () => void; onChanged: (u: Update) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const opening = update.visibility === "approvers";
  // qa-company-17: a sharing action, said as one.
  const action = opening ? "Share with the whole company" : "Limit to owners and approvers";
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setError("Say why");
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.PATCH("/v1/documents/{doc}/visibility", {
          params: { path: { doc: update.slug } },
          body: { visibility: opening ? "company" : "approvers", reason: reason.trim() },
        }),
      );
      onChanged(out);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-visibility-title"
        tabIndex={-1}
        className="w-full max-w-lg min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="update-visibility-title" className="font-display text-xl font-bold tracking-heading">
            {action}
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <p className="text-[15px] text-text">
            {opening
              ? `Every member will see “${update.title}”, its versions and its feedback.`
              : `Only owners and approvers will see “${update.title}”; commenters and viewers will not.`}
          </p>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Reason
            <textarea data-autofocus className={INPUT} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {opening ? "Share" : action}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

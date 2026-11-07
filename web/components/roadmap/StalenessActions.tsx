"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

type Item = Schemas["RoadmapItemOut"];

/**
 * A stale roadmap item's actions: Mark under review; Still valid… with a one-line reason. The
 * Items tab and the Plan item panel's Review (the stale-marks walk) share it, so both settle
 * the item the same way; the API's refusals read in plain words.
 */
export function StalenessActions({
  doc,
  n,
  itemKey,
  freshness,
  onChanged,
  open = false,
  onCancel,
}: {
  doc: string;
  /** The roadmap version; none: the one the API picks. */
  n?: number | null;
  itemKey: string;
  freshness?: string | null;
  onChanged: (items: Item[]) => void | Promise<void>;
  /** Start with the reason field open (the Plan's Review). */
  open?: boolean;
  /** Cancel also closes the actions (the Plan's Review); else only the reason field. */
  onCancel?: () => void;
}) {
  const [asking, setAsking] = useState(open);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "review" | "reconcile") {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/roadmaps/{doc}/items/staleness", {
          params: { path: { doc } },
          body: { action, version: n ?? null, item_keys: [itemKey], reason: action === "reconcile" ? reason.trim() : null },
        }),
      );
      await onChanged(out.items);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) void act("reconcile");
  };

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="staleness-actions">
      <div className="flex flex-wrap gap-2">
        {freshness === "potentially_stale" && (
          <Button onClick={() => act("review")} disabled={busy}>
            Mark under review
          </Button>
        )}
        {!asking && (
          <Button variant="ghost" onClick={() => setAsking(true)} disabled={busy}>
            Still valid…
          </Button>
        )}
      </div>
      {asking && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Why it is still valid
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              className="h-10 rounded-button border border-line-strong bg-surface px-2.5 text-[15px] font-normal text-text"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>
              Mark still valid
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAsking(false);
                onCancel?.();
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

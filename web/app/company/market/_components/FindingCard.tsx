"use client";

import { useState } from "react";

import { Button, Chip } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

import { FINDING_KIND, findingDate, type Change, type Finding } from "./lib";

/**
 * One web finding from the monthly search: Not vetted, its kind, source host and date; the
 * title and summary as plain text (never Markdown or HTML: they came from outside the
 * company), the excerpt in quotes, and the page in a new tab. Approvers and owners Promote it
 * to the change log or Dismiss it (with an optional reason); others see no buttons (#370).
 */
export function FindingCard({
  finding,
  canDecide,
  showCompetitor = true,
  onPromoted,
  onDismissed,
}: {
  finding: Finding;
  canDecide: boolean;
  showCompetitor?: boolean;
  onPromoted?: (change: Change) => void;
  onDismissed?: (f: Finding) => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { finding_id: finding.id } } };

  async function act(call: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <article data-testid="web-finding" data-status={finding.status} className="flex min-w-0 flex-col gap-1.5 py-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text2">
        {finding.status === "open" ? (
          <Chip kind="warn" data-testid="not-vetted">
            Not vetted
          </Chip>
        ) : (
          <Chip kind={finding.status === "promoted" ? "pass" : "na"}>{finding.status === "promoted" ? "Promoted" : "Dismissed"}</Chip>
        )}
        <span>{FINDING_KIND[finding.kind]}</span>
        <span aria-hidden>·</span>
        <span data-testid="finding-host">{finding.host}</span>
        <span aria-hidden>·</span>
        <span className="tnum">{findingDate(finding)}</span>
        {showCompetitor && (
          <>
            <span aria-hidden>·</span>
            <span>{finding.competitor_name}</span>
          </>
        )}
      </div>
      <h3 className="text-[15px] font-semibold">{finding.title}</h3>
      <p className="text-[15px]">{finding.summary}</p>
      {finding.excerpt && <blockquote className="border-l-2 border-line-strong pl-3 text-sm text-text2">“{finding.excerpt}”</blockquote>}
      <div className="flex flex-wrap items-center gap-2">
        <a href={finding.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sm text-accent-ink hover:underline">
          Open page on {finding.host} ↗
        </a>
        {canDecide && finding.status === "open" && !dismissing && (
          <>
            <span className="flex-1" />
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const change = await unwrap(api.POST("/v1/competitor-web-findings/{finding_id}/promote", { ...path, body: {} }));
                  onPromoted?.(change);
                })
              }
            >
              Promote to change log
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDismissing(true)}>
              Dismiss
            </Button>
          </>
        )}
      </div>
      {dismissing && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const out = await unwrap(api.POST("/v1/competitor-web-findings/{finding_id}/dismiss", { ...path, body: { reason: reason.trim() || null } }));
              onDismissed?.(out);
            });
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold text-text2">
            Why dismiss (optional)
            <input className={INPUT} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy}>
            Dismiss finding
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setDismissing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </article>
  );
}

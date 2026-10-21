"use client";

import { useEffect, useState } from "react";

import { Button, InfoTip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery, type Query } from "@/lib/use-query";

type Status = Schemas["TriageStatus"];

/** How often the header re-reads a triage run under way. */
const POLL_MS = 2_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "just now", "2 min ago", "3 h ago". */
function ago(at: string | null | undefined, now: number): string {
  if (!at) return "just now";
  const min = Math.floor((now - Date.parse(at)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

/** Oracle's latest triage run, re-read every few seconds while it is under way. */
export function useTriage(): Query<Status> {
  const q = useQuery("request-triage", () => unwrap(api.GET("/v1/requests/triage")));
  const active = q.data?.active ?? false;
  const { reload } = q;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, reload]);
  return q;
}

/** "started 2 min ago", kept current while shown (rendered only once a run has loaded). */
function Started({ at }: { at: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return <>started {ago(at, now)}</>;
}

/**
 * The header's status line (C1 "Classify now"): "Oracle is classifying · started 2 min ago"
 * while a run is under way, then what it suggested and found in your own sources.
 */
export function TriageStatusLine({ status }: { status: Status | undefined }) {
  if (!status?.run_id) return null;
  return (
    <span data-testid="triage-status" className="text-sm text-text2" role="status">
      {status.active ? (
        <>
          Oracle is classifying · <Started at={status.started_at} />
        </>
      ) : status.status === "succeeded" ? (
        `${plural(status.suggestions, "suggestion")}, ${status.found} found in your sources`
      ) : (
        `Oracle's last triage did not finish${status.error ? `: ${status.error}` : ""}`
      )}
    </span>
  );
}

/** Classify now (approvers and owners): starts Oracle's triage run; it decides nothing. */
export function ClassifyNow({ triage }: { triage: Query<Status> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = triage.data?.active ?? false;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/requests/triage", { body: {} }));
      await triage.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      {error && (
        <span role="alert" className="text-sm text-crit">
          {error}
        </span>
      )}
      <Button variant="secondary" disabled={busy || active} onClick={start} data-testid="classify-now">
        Classify now
      </Button>
      <InfoTip label="Classify now">
        Oracle suggests a theme, goals, a duplicate and a feature for every new request, and looks through your own
        sources for requests. You accept or ignore each suggestion. Oracle also classifies new requests every day at
        07:00 PT.
      </InfoTip>
    </span>
  );
}

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

/** The daily triage's part of the status line: off, or who the 07:00 PT run acts as. */
function daily(status: Status): string {
  if (!status.daily_on) return "Daily triage is off";
  if (status.daily_as) return `Daily triage at 07:00 PT runs as ${status.daily_as}`;
  return "Daily triage is on, but no active approver or owner can run it";
}

/**
 * The header's status line (C1 "Classify now"): "Oracle is classifying · started 2 min ago"
 * while a run is under way, then what it suggested and found in your own sources, followed by
 * whether the daily triage is off or who it runs as; or why Oracle's daily run did not start,
 * until a later run.
 */
export function TriageStatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null;
  if (status.daily_skipped)
    return (
      <span data-testid="triage-status" className="text-sm text-text2" role="status">
        {status.daily_skipped}
      </span>
    );
  return (
    <span data-testid="triage-status" className="text-sm text-text2" role="status">
      {status.run_id && (
        <>
          {status.active ? (
            <>
              Oracle is classifying · <Started at={status.started_at} />
            </>
          ) : status.status === "succeeded" ? (
            `${plural(status.suggestions, "suggestion")}, ${status.found} found in your sources`
          ) : (
            `Oracle's last triage did not finish${status.error ? `: ${status.error}` : ""}`
          )}
          {" · "}
        </>
      )}
      {daily(status)}
    </span>
  );
}

/**
 * "Daily triage at 07:00 PT" (owner decision 2026-10-21: off by default). Approvers and owners
 * turn it on or off; commenters and viewers see its state only.
 */
export function DailyTriageSwitch({ triage, canChange }: { triage: Query<Status>; canChange: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = triage.data;

  async function turn(on: boolean) {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.PUT("/v1/requests/triage/daily", { body: { on } }));
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
      <label
        className={`inline-flex items-center gap-2 text-sm font-semibold text-text ${canChange ? "cursor-pointer" : ""}`}
      >
        <input
          type="checkbox"
          role="switch"
          className="size-4 accent-[var(--accent)]"
          checked={status?.daily_on ?? false}
          disabled={!canChange || busy || !status}
          onChange={(e) => void turn(e.target.checked)}
          data-testid="daily-triage-switch"
        />
        Daily triage at 07:00 PT
      </label>
      <InfoTip label="Daily triage">
        While this is on, Oracle classifies new requests every day at 07:00 PT, about $1.50 a run. It runs as whoever
        turned it on, while they are an approver or owner, otherwise as the longest-standing owner. Approvers and owners
        turn it on or off.
        {status?.daily_changed_by && ` Last turned ${status.daily_on ? "on" : "off"} by ${status.daily_changed_by}.`}
      </InfoTip>
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
        07:00 PT while Daily triage is on.
      </InfoTip>
    </span>
  );
}

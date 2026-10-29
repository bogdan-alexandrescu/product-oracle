"use client";

import { useEffect, useState } from "react";

import { Button, Chip, InfoTip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { dailyTime, failedAt, formatAge, plural } from "@/lib/format";

/** When the daily triage runs (api/oracle/requests/triage.py: 07:00 Pacific), in the Company time zone. */
const DAILY_AT = () => dailyTime("07:00", "America/Los_Angeles");
import { errorMessage, useQuery, type Query } from "@/lib/use-query";

type Status = Schemas["TriageStatus"];

/** How often the header re-reads a triage run under way. */
const POLL_MS = 2_000;

/** "just now", "2m ago", "3h ago": the app's one way to write an age (formatAge). */
function ago(at: string | null | undefined, now: number): string {
  const age = at ? formatAge(at, now) : "now";
  return !age || age === "now" ? "just now" : `${age} ago`;
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

/** What the daily triage switch says beside its name: off, or who the 07:00 PT run acts as (qa-work-38). */
function daily(status: Status): { text: string; warn: boolean } {
  if (!status.daily_on) return { text: "Off", warn: false };
  if (status.daily_as) return { text: `On, runs as ${status.daily_as}`, warn: false };
  return { text: "On, but no active approver or owner can run it", warn: true };
}

/** What Oracle's last finished run did: the requests it left suggestions on, and what was new in your sources (qa-work-5). */
function lastRun(status: Status): string {
  const found = status.found ? `found ${plural(status.found, "new possible request")} in your sources` : "found nothing new in your sources";
  return `Oracle's last triage left suggestions on ${plural(status.suggestions, "request")} and ${found}`;
}

/**
 * The header's status line (C1 "Classify now"): "Oracle is classifying · started 2 min ago"
 * while a run is under way, then what the last run did ("left suggestions on 4 requests and
 * found nothing new in your sources", so its count never reads as the found panel's); or why
 * Oracle's daily run did not start, until a later run. The daily triage's state is the
 * switch's own (qa-work-38), not repeated here.
 */
export function TriageStatusLine({ status }: { status: Status | undefined }) {
  if (!status) return null;
  if (status.daily_skipped)
    return (
      <span data-testid="triage-status" className="text-sm text-text2" role="status">
        {status.daily_skipped}
      </span>
    );
  if (!status.run_id) return null;
  return (
    <span data-testid="triage-status" className="text-sm text-text2" role="status">
      {status.active ? (
        <>
          Oracle is classifying · <Started at={status.started_at} />
        </>
      ) : status.status === "succeeded" ? (
        lastRun(status)
      ) : (
        // When it failed, then what was so then (#633 re-review).
        <>
          {/* The ". " follows the sentence whenever more follows it: a when, a why or both. */}
          Oracle&apos;s last triage did not finish{status.error || (status.status === "failed" && status.finished_at) ? ". " : ""}
          {status.status === "failed" && status.finished_at && <span data-testid="failed-at">{failedAt(status.finished_at)}. </span>}
          {status.error}
        </>
      )}
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
  const said = status ? daily(status) : null;

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
    <span className="flex items-center gap-1.5 max-[600px]:w-full max-[600px]:flex-wrap">
      {error && (
        <span role="alert" className="text-sm text-crit max-[600px]:basis-full">
          {error}
        </span>
      )}
      {canChange ? (
        <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-sm font-semibold text-text max-[600px]:min-h-11 max-[600px]:flex-1">
          <input
            type="checkbox"
            role="switch"
            className="size-4 flex-none accent-[var(--accent)] max-[600px]:size-5"
            checked={status?.daily_on ?? false}
            disabled={busy || !status}
            onChange={(e) => void turn(e.target.checked)}
            data-testid="daily-triage-switch"
          />
          <span>
            Daily triage at {DAILY_AT()}
            {said && (
              <span data-testid="daily-triage-said" className={`font-medium ${said.warn ? "text-warn" : "text-text2"}`}>
                {" · "}
                {said.text}
              </span>
            )}
          </span>
        </label>
      ) : (
        // #370: commenters and viewers can never turn it, so they read its state, no switch.
        status && (
          <Chip kind={status.daily_on ? "pass" : "na"} data-testid="daily-triage-state" title={said?.text}>
            Daily triage {status.daily_on ? "on" : "off"}
          </Chip>
        )
      )}
      <InfoTip label="Daily triage">
        While this is on, Oracle classifies new requests every day at {DAILY_AT()}, about $1.50 a run. It runs as whoever
        turned it on, while they are an approver or owner, otherwise as the longest-standing owner.
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
    <span className="flex items-center gap-1.5 max-[600px]:w-full max-[600px]:flex-wrap">
      {error && (
        <span role="alert" className="text-sm text-crit max-[600px]:basis-full">
          {error}
        </span>
      )}
      <Button
        className="max-[600px]:h-11 max-[600px]:flex-1"
        variant="secondary"
        disabled={busy || active}
        title={active ? "Oracle is classifying now" : undefined}
        onClick={start}
        data-testid="classify-now"
      >
        Classify now
      </Button>
      <InfoTip label="Classify now">
        Oracle suggests a theme, goals, a duplicate and a feature for every new request, and looks through your own
        sources for requests. You accept or ignore each suggestion. Oracle also classifies new requests every day at{" "}
        {DAILY_AT()} while Daily triage is on.
      </InfoTip>
    </span>
  );
}

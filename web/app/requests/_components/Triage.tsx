"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Chip, InfoTip } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, todayIn, useCompanyZone, zoneInstant } from "@/lib/dates";
import { failedAt, formatAge, plural } from "@/lib/format";
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

/** What the daily triage switch says under its name: off, or who the daily run acts as (qa-work-38). */
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
 * The header's status line (C1 "Sort now"): "Oracle is sorting · started 2 min ago"
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
          Oracle is sorting · <Started at={status.started_at} />
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
 * When the daily run starts, in the Company time zone (qa-onboarding-9: the API runs it at
 * 07:00 there): "7:00 AM PT", "7:00 AM Berlin time", the app's 12-hour style (rirs-26).
 */
export function useTriageTime(): string {
  const zone = useCompanyZone();
  const shown = formatInZone(zoneInstant(todayIn(zone), "07:00", zone), zone, { hour: "numeric", minute: "2-digit" });
  const m = /^(\d{1,2}:\d{2}\s[AP]M)\s(.+)$/.exec(shown);
  if (!m) return shown;
  const [, time, name] = m;
  // "PDT"/"PST" read as "PT"; a zone with only an offset name reads as its city's time.
  if (/^[A-Z][SD]T$/.test(name)) return `${time} ${name[0]}T`;
  if (/^(GMT|UTC)[+-]/.test(name)) return `${time} ${(zone.split("/").pop() ?? zone).replace(/_/g, " ")} time`;
  return `${time} ${name}`;
}

/**
 * The header's one triage control (rirs-35): "Auto-sort: Off" opens a panel with the daily
 * switch and Sort now, so the header keeps two primary actions. Approvers and owners get the
 * panel; commenters and viewers read its state only.
 */
export function TriageMenu({ triage, canChange, canStart }: { triage: Query<Status>; canChange: boolean; canStart: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const status = triage.data;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>("[data-triage-menu-button]")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  if (!canChange && !canStart) {
    // #370: commenters and viewers can never turn it, so they read its state, no switch.
    const said = status ? daily(status) : null;
    return status ? (
      <Chip kind={status.daily_on ? "pass" : "na"} data-testid="daily-triage-state" title={said?.text}>
        Auto-sort {status.daily_on ? "on" : "off"}
      </Chip>
    ) : null;
  }
  return (
    <div ref={root} className="relative max-[600px]:w-full">
      <Button
        data-triage-menu-button=""
        data-testid="triage-menu"
        variant="secondary"
        aria-expanded={open}
        aria-controls="triage-menu-panel"
        className="max-[600px]:h-11 max-[600px]:w-full"
        onClick={() => setOpen((o) => !o)}
      >
        Auto-sort: {status?.daily_on ? "On" : "Off"}
      </Button>
      {open && (
        <div
          id="triage-menu-panel"
          role="group"
          aria-label="Auto-sort new requests"
          data-testid="triage-menu-panel"
          className="absolute top-full right-0 z-30 mt-2 flex w-80 max-w-[calc(100vw-1.25rem)] flex-col gap-3 rounded-panel border border-line bg-surface p-3 text-left shadow-tip max-[600px]:w-full"
        >
          {canChange && <DailyTriageSwitch triage={triage} canChange />}
          {canStart && <ClassifyNow triage={triage} />}
        </div>
      )}
    </div>
  );
}

/**
 * "Auto-sort new requests daily at 7:00 AM PT" (owner decision 2026-10-21: off by default).
 * An approver or owner turns it on or off; commenters and viewers see its state only.
 */
export function DailyTriageSwitch({ triage, canChange }: { triage: Query<Status>; canChange: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = triage.data;
  const said = status ? daily(status) : null;
  const at = useTriageTime();

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
    <span className="flex flex-wrap items-start gap-1.5">
      {error && (
        <span role="alert" className="basis-full text-sm text-crit">
          {error}
        </span>
      )}
      {canChange ? (
        <label className="inline-flex min-h-8 min-w-0 flex-1 cursor-pointer items-start gap-2 text-sm font-semibold text-text max-[600px]:min-h-11">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5 size-4 flex-none accent-[var(--accent)] max-[600px]:size-5"
            checked={status?.daily_on ?? false}
            disabled={busy || !status}
            onChange={(e) => void turn(e.target.checked)}
            data-testid="daily-triage-switch"
          />
          <span className="min-w-0">
            Auto-sort new requests daily at {at}
            {said && (
              <span data-testid="daily-triage-said" className={`block font-medium ${said.warn ? "text-warn" : "text-text2"}`}>
                {said.text}
              </span>
            )}
          </span>
        </label>
      ) : (
        status && (
          <Chip kind={status.daily_on ? "pass" : "na"} data-testid="daily-triage-state" title={said?.text}>
            Auto-sort {status.daily_on ? "on" : "off"}
          </Chip>
        )
      )}
      <InfoTip label="Auto-sort">
        While this is on, Oracle sorts new requests every day at {at}, about $1.50 a run. It runs as whoever turned it on,
        while they are an approver or owner, otherwise as the longest-standing owner.
        {status?.daily_changed_by && ` Last turned ${status.daily_on ? "on" : "off"} by ${status.daily_changed_by}.`}
      </InfoTip>
    </span>
  );
}

/** Sort now (approvers and owners): starts Oracle's triage run; it decides nothing. */
export function ClassifyNow({ triage }: { triage: Query<Status> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = triage.data?.active ?? false;
  const at = useTriageTime();

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
    <span className="flex flex-wrap items-center gap-1.5">
      {error && (
        <span role="alert" className="basis-full text-sm text-crit">
          {error}
        </span>
      )}
      <Button
        className="max-[600px]:h-11 max-[600px]:flex-1"
        variant="secondary"
        disabled={busy || active}
        title={active ? "Oracle is sorting now" : undefined}
        onClick={start}
        data-testid="classify-now"
      >
        Sort now
      </Button>
      <InfoTip label="Sort now">
        Oracle suggests a theme, goals, a duplicate and a feature for every new request, and looks through your own
        sources for requests. You accept or ignore each suggestion. Oracle also sorts new requests every day at {at}
        while Auto-sort is on.
      </InfoTip>
    </span>
  );
}

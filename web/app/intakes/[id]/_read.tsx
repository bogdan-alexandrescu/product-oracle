"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { plural } from "@/lib/format";

import { dayMonth, when } from "./_lib";

type AiRead = Schemas["AiReadOut"];

const LIVE = new Set<AiRead["state"]>(["queued", "running"]);
const POLL_MS = 10_000;

function line(read: AiRead, openGaps: number, asked: number): string {
  if (read.state === "off") {
    if (read.off_reason === "company") return "Oracle's read is off for this company.";
    // qa-onboarding-22: the questions below are Oracle's, from what the brief says; only
    // the deeper read (with the sources) has not run.
    return asked > 0
      ? `Oracle asked ${plural(asked, "question")} from what the brief says; it has not analysed it with your sources yet.`
      : "Oracle hasn't read this brief.";
  }
  if (LIVE.has(read.state)) return `Oracle is reading your brief and ${plural(read.sources, "source")}`;
  if (read.state === "failed") return read.error?.message ?? "Oracle's read failed. The rules read stands.";
  // rirs-29: plain words, not "inferences" and "gaps". qa-work-3: the open gaps are the Gaps
  // tab's count (the rules read's and Oracle's), not only those this read added.
  const added = read.added ?? { items: 0, gaps: 0 };
  return `${plural(added.items, "thing Oracle assumed", "things Oracle assumed")} (private to you), ${plural(openGaps, "open gap")}`;
}

/** The day the read started or finished, as the line ends with it (never split: qa-onboarding-40). */
function lineDay(read: AiRead): string | null {
  if (read.state === "off" || read.state === "failed") return null;
  if (LIVE.has(read.state)) return read.started_at ? `started ${dayMonth(read.started_at)}` : null;
  return read.finished_at ? dayMonth(read.finished_at) : null;
}

/**
 * INT2: Oracle's read of the brief, the author's only, and Read again. The author starts
 * at most `reads_per_day` reads a Company day (owner decision 2026-10-26; the reads on
 * create and repin are not counted): the count shows before the button, and at the cap
 * the button waits with the API's sentence. While a read runs the page reads the summary
 * again every 10 s.
 */
export function ReadLine({
  read,
  openGaps,
  asked,
  mayRead,
  busy,
  onRead,
  onPoll,
}: {
  read: AiRead;
  /** The brief's open gaps, as the Gaps tab counts them. */
  openGaps: number;
  /** The questions Oracle has asked so far, in every batch. */
  asked: number;
  mayRead: boolean;
  busy: boolean;
  onRead: () => void;
  onPoll: () => void;
}) {
  const live = LIVE.has(read.state);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(onPoll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, onPoll]);

  const refused = read.read_again_refused ?? null;
  // The day in the line, its full time on hover.
  const at = live ? read.started_at : read.finished_at;
  const day = lineDay(read);
  const left = Math.max(0, read.reads_per_day - read.reads_today);
  const showButton = mayRead && !live && !(read.state === "off" && read.off_reason === "company");
  return (
    <div data-testid="intake-read" className="-mt-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text2">
      <span title={at ? when(at) : undefined}>
        {line(read, openGaps, asked)}
        {day && (
          <>
            {" · "}
            <span data-testid="intake-read-day" className="whitespace-nowrap">
              {day}
            </span>
          </>
        )}
      </span>
      {read.fallback && <span>{read.fallback.message}</span>}
      {read.state === "done" && read.path === "swarmcloud" && read.run_id && (
        <Link href={`/runs/${read.run_id}`} className="font-medium text-text hover:underline">
          View run
        </Link>
      )}
      {showButton && (
        <span className="flex items-center gap-2">
          {refused ? (
            <span data-testid="intake-read-capped" className="font-medium text-text">
              {refused}
            </span>
          ) : (
            // qa-onboarding-28: the day's cap shows before the first read, not only after it.
            <span data-testid="intake-read-count" className="whitespace-nowrap">
              {/* qa-work-31: what is counted. */}
              {plural(left, "analysis", "analyses")} left today
            </span>
          )}
          {/* rirs-29: this reads the brief and its sources again (capped); the menu's "Rank the
              questions again" only re-orders the questions not asked yet. */}
          <Button
            disabled={busy || refused !== null}
            title={refused ?? "Oracle reads the brief and its sources again"}
            onClick={onRead}
          >
            {read.state === "off" ? "Analyse with Oracle" : read.state === "failed" ? "Try again" : "Read the brief again"}
          </Button>
        </span>
      )}
    </div>
  );
}

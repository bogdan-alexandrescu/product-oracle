"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { when } from "./_lib";

type AiRead = Schemas["AiReadOut"];

const LIVE = new Set<AiRead["state"]>(["queued", "running"]);
const POLL_MS = 10_000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function line(read: AiRead): string {
  if (read.state === "off") return read.off_reason === "company" ? "Oracle's read is off for this company." : "Oracle hasn't read this brief.";
  if (LIVE.has(read.state)) {
    return `Oracle is reading your brief and ${plural(read.sources, "source")}${read.started_at ? ` · started ${when(read.started_at)}` : ""}`;
  }
  if (read.state === "failed") return read.error?.message ?? "Oracle's read failed. The rules read stands.";
  const added = read.added ?? { items: 0, gaps: 0 };
  return `Oracle added ${plural(added.items, "inference")} and ${plural(added.gaps, "gap")} · private to you${read.finished_at ? ` · ${when(read.finished_at)}` : ""}`;
}

/**
 * INT2: Oracle's read of the brief, the author's only, and Read again. The author starts
 * at most `reads_per_day` reads a Company day (owner decision 2026-10-26; the reads on
 * create and repin are not counted): the count shows before the button, and at the cap
 * the button waits with the API's sentence. While a read runs the page reads the summary
 * again every 10 s.
 */
export function ReadLine({ read, mayRead, busy, onRead, onPoll }: { read: AiRead; mayRead: boolean; busy: boolean; onRead: () => void; onPoll: () => void }) {
  const live = LIVE.has(read.state);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(onPoll, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, onPoll]);

  const refused = read.read_again_refused ?? null;
  const showButton = mayRead && !live && !(read.state === "off" && read.off_reason === "company");
  return (
    <div data-testid="intake-read" className="-mt-1 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text2">
      <span>{line(read)}</span>
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
            read.reads_today > 0 && (
              <span data-testid="intake-read-count">
                ({read.reads_today} of {read.reads_per_day} today)
              </span>
            )
          )}
          <Button disabled={busy || refused !== null} title={refused ?? undefined} onClick={onRead}>
            {read.state === "off" ? "Analyse with Oracle" : read.state === "failed" ? "Try again" : "Read again"}
          </Button>
        </span>
      )}
    </div>
  );
}

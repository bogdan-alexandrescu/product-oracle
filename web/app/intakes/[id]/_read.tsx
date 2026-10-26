"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ds";
import { InlineError } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { displayZone, zoneTime } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

import type { Summary } from "./_lib";

type AiRead = NonNullable<Summary["ai_read"]>;

/** How often the page reads the summary again while Oracle reads (spec-INT2: every 10 s). */
export const READ_POLL_MS = 10_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const at = (iso: string | null | undefined) => (iso ? zoneTime(iso, displayZone()) : null);

/** Whether Oracle's read is under way (the page polls while it is). */
export const reading = (r: Summary["ai_read"]) => r?.state === "queued" || r?.state === "running";

/** Which path produced (or is producing) the read, in plain words (owner answer Q3). */
function pathLine(r: AiRead): string | null {
  if (r.path === "swarmcloud") return "Read on SwarmCloud";
  if (r.path === "job") return r.fallback?.message ?? "Read by Oracle's built-in model";
  return null;
}

function headline(r: AiRead): string {
  const sources = r.sources > 0 ? ` and ${plural(r.sources, "source")}` : "";
  switch (r.state) {
    case "off":
      return r.off_reason === "company" ? "Oracle's read is off for this company. The rules read stands." : "Oracle hasn't read this brief. The rules read stands.";
    case "queued":
    case "running": {
      const started = at(r.started_at);
      const where = r.path === "job" ? " on Oracle's built-in model" : "";
      return `Oracle is reading your brief${sources}${where}${started ? ` · started ${started}` : ""}`;
    }
    case "done": {
      if (r.note) return r.note;
      const added = r.added ?? { items: 0, gaps: 0 };
      const finished = at(r.finished_at);
      return `Oracle added ${plural(added.items, "inference")} and ${plural(added.gaps, "gap")} · private to you${finished ? ` · ${finished}` : ""}`;
    }
    case "failed":
      return r.error?.message ?? "Oracle's read failed. The rules read stands.";
  }
}

/**
 * INT2 Oracle's read of the brief, for its author only (the summary's ai_read is null for
 * anyone else): reading, what it added and which path produced it (SwarmCloud, or Oracle's
 * built-in model when SwarmCloud could not), or why it failed, with Analyse with Oracle or
 * Try again. Re-analyse (More actions) still runs the rules only.
 */
export function ReadLine({ intakeId, read, mayStart, onStarted }: { intakeId: string; read: AiRead; mayStart: boolean; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/intakes/{intake_id}/ai-read", { params: { path: { intake_id: intakeId } } }));
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const live = reading(read);
  const companyOff = read.state === "off" && read.off_reason === "company";
  const path = read.state === "done" || read.state === "failed" ? pathLine(read) : null;
  const action = mayStart && !live && !companyOff && (
    <Button disabled={busy} onClick={() => void start()}>
      {read.state === "failed" ? "Try again" : "Analyse with Oracle"}
    </Button>
  );
  return (
    <div
      data-testid="intake-read"
      role="status"
      className={`-mt-1 mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm ${read.state === "failed" ? "text-crit" : "text-text2"}`}
    >
      <span className="min-w-0 break-words font-medium">{headline(read)}</span>
      {path && <span className="min-w-0 break-words text-[13px] text-text2">{path}</span>}
      {read.run_id && read.path === "swarmcloud" && (read.state === "done" || read.state === "failed") && (
        <Link href={`/runs/${read.run_id}`} className="text-[13px] text-acc hover:underline">
          View run
        </Link>
      )}
      {action}
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}

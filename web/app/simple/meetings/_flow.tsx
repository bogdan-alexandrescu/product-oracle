"use client";

import type { ReactNode } from "react";

import type { Schemas } from "@/lib/api/client";
import { formatInZone } from "@/lib/dates";

import { FlowPanel, subjectOf } from "@/components/simple/FlowVisual";

/** qa-simple-decide-30: the one link style of Meetings, a meeting and Decisions. */
export const LINK = "font-semibold text-accent-ink hover:underline";

/**
 * qa-simple-decide-31: one way to write a moment on Meetings, a meeting and Decisions:
 * "Thu Oct 29, 7:01 PM" in the company zone (each page names the zone once); `day` alone
 * gives "Thu Oct 29", as the API's decided label words it.
 */
export function momentWords(at: string, zone: string, day = false, zoned = false): string {
  const d = formatInZone(at, zone, { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  if (day) return d;
  // A stamp that stands alone keeps its zone ("Wed Nov 4, 4:41 PM PST"); in a list under a zoned heading it is dropped.
  const time = formatInZone(at, zone, { hour: "numeric", minute: "2-digit" });
  return `${d}, ${zoned ? time : time.replace(/ (?:[A-Z]{2,5}|GMT[+-][\d:]+)$/, "")}`;
}

/**
 * A decision in a list, with the new flow or feature it decided (S8: each decided flow is
 * linked): its flow in S10's one flow viewer (pick A's row: the thumbnail opens it across the
 * page, a full-height sheet on a phone), or "No flow yet" while S10 has drawn none.
 */
export function DecidedItem({ flow, id, className, testId, children }: { flow?: Schemas["SimpleDecidedFlow"] | null; id?: string; className?: string; testId?: string; children: ReactNode }) {
  const drawn = flow?.flow ?? null;
  return (
    <li id={id} data-testid={testId} className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      {children}
      {flow &&
        (drawn ? (
          <div className="basis-full">
            <FlowPanel row subject={subjectOf(drawn) ?? { kind: flow.kind, id: flow.id }} openLabel={`Open the flow for ${flow.title}`} showHint={false} />
          </div>
        ) : (
          <span className="rounded-md border border-dashed border-line px-2 py-1 text-[length:var(--simple-small)] text-text2" data-testid="flow-none">
            No flow yet
          </span>
        ))}
    </li>
  );
}

"use client";

import { useState, type ReactNode } from "react";

import { Sheet } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatInZone } from "@/lib/dates";

import { FlowDetail, FlowThumb } from "@/components/simple/Flow";

import { usePhone } from "../priorities/priorities";

/** qa-simple-decide-30: the one link style of Meetings, a meeting and Decisions. */
export const LINK = "font-semibold text-accent-ink hover:underline";

/**
 * qa-simple-decide-31: one way to write a moment on Meetings, a meeting and Decisions:
 * "Thu Oct 29, 7:01 PM" in the company zone (each page names the zone once); `day` alone
 * gives "Thu Oct 29", as the API's decided label words it.
 */
export function momentWords(at: string, zone: string, day = false): string {
  const d = formatInZone(at, zone, { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  return day ? d : `${d}, ${formatInZone(at, zone, { hour: "numeric", minute: "2-digit" }).replace(/ (?:[A-Z]{2,5}|GMT[+-][\d:]+)$/, "")}`;
}

/**
 * A decision in a list, with the new flow or feature it decided (S8: each decided flow is
 * linked): train T's flow thumbnail widens the row in place to the user flow and the
 * wireframe (a full-height sheet on a phone), or "No flow yet" while S10 has drawn none.
 */
export function DecidedItem({ flow, id, className, testId, children }: { flow?: Schemas["SimpleDecidedFlow"] | null; id?: string; className?: string; testId?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  const drawn = flow?.flow ?? null;
  const wide = open && !phone && !!drawn;
  return (
    <li id={id} data-testid={testId} data-wide={wide ? "true" : "false"} className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      {children}
      {flow &&
        (drawn ? (
          <button type="button" aria-label={`Open the flow for ${flow.title}`} aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md border border-line bg-surface p-1" data-testid="flow-thumb">
            <FlowThumb flow={drawn} />
          </button>
        ) : (
          <span className="rounded-md border border-dashed border-line px-2 py-1 text-[length:var(--simple-small)] text-text2" data-testid="flow-none">
            No flow yet
          </span>
        ))}
      {wide && drawn && (
        <div className="basis-full">
          <FlowDetail flow={drawn} />
        </div>
      )}
      {phone && drawn && (
        <Sheet open={open} title={drawn.title} onClose={() => setOpen(false)} full testId="flow-sheet">
          <FlowDetail flow={drawn} />
        </Sheet>
      )}
    </li>
  );
}

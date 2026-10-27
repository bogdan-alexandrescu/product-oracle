"use client";

import { useState, type ReactNode } from "react";

import { Sheet } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { FlowDetail, FlowThumb } from "@/components/simple/Flow";

import { usePhone } from "../priorities/priorities";

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

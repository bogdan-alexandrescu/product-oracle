"use client";

import { createContext, useContext, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { DateBasisDialog, shortDay, type Basis, type DateRights } from "@/components/DateBasisDialog";
import { Button } from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { IGNORE_ATTR } from "@/lib/anchor";
import { api, unwrap, type DateMarkOut } from "@/lib/api/client";

/**
 * What a marker needs to act (F3): the roadmap's PRD, its sections' text (for the reference
 * a date names), the reader's date rights, and what to do once a basis is recorded. Without
 * it (Present, exports) a marker is a label with a tooltip, as before.
 */
export type DateMarkCtx = {
  prd: string | null;
  sectionText: (key: string) => string;
  rights: DateRights | null;
  onChanged: () => void;
};
export const DateMarkContext = createContext<DateMarkCtx | null>(null);

const ignore = { [IGNORE_ATTR]: "" };

/** The reference a date names in its section's text, "Beta by 2026-11-30 (ENG-412 estimate)". */
export function namedReference(text: string, date: string): string {
  const at = text.indexOf(date);
  const after = at >= 0 ? text.slice(at + date.length, at + date.length + 80) : "";
  const key = /^[\s,;:]*\(?\s*([A-Za-z][A-Za-z0-9]*-\d+)/.exec(after) ?? /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(text);
  return key?.[1] ?? "";
}

function title(mark: DateMarkOut): string {
  return mark.status === "withdrawn"
    ? `The basis of this date (${mark.bases.join(", ")}) was withdrawn`
    : "No verified estimate, capacity or commitment of the PRD supports this date";
}

/** The marker after a date that rests on no verified basis (not part of the anchored text). */
export function DateMarker({ mark }: { mark: DateMarkOut }) {
  const ctx = useContext(DateMarkContext);
  const id = useId();
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [withdrawn, setWithdrawn] = useState<{
    basis: Basis;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!open || mark.status !== "withdrawn" || !ctx?.prd) return;
    let live = true;
    unwrap(
      api.GET("/v1/schedule-bases", {
        params: { query: { prd: ctx.prd, status: "withdrawn" } },
      }),
    )
      .then(async (rows) => {
        const basis =
          rows.find((b) => mark.bases.includes(b.reference) && b.supports_date === mark.date) ??
          rows.find((b) => mark.bases.includes(b.reference));
        if (!basis) return;
        const people = await peopleByIds([basis.withdrawn_by]);
        if (live)
          setWithdrawn({
            basis,
            name: (basis.withdrawn_by && people.get(basis.withdrawn_by)?.name) || "a member",
          });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, mark, ctx?.prd]);

  if (!ctx) {
    return (
      <span {...ignore} className="date-mark" data-date-mark={mark.status} title={title(mark)}>
        {mark.label}
      </span>
    );
  }
  const mayRecord = !!ctx.rights?.rights;
  return (
    <>
      {/* One inline element right after the date (the anchored text skips it); the popover
          is drawn on the body. */}
      <button
        {...ignore}
        type="button"
        className="date-mark cursor-pointer"
        data-date-mark={mark.status}
        title={title(mark)}
        aria-expanded={!!open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen((o) =>
            o
              ? null
              : {
                  top: r.bottom + 4,
                  left: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
                },
          );
        }}
      >
        {mark.label}
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            role="dialog"
            aria-label={`Date ${mark.text}`}
            data-testid="date-mark-popover"
            style={{ top: open.top, left: open.left }}
            className="fixed z-30 block w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-surface p-3 text-left text-sm font-normal text-text shadow-tip"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="block">
              {mark.status === "withdrawn"
                ? withdrawn
                  ? `${withdrawn.basis.reference} was withdrawn by ${withdrawn.name} on ${shortDay(withdrawn.basis.withdrawn_at ?? mark.date)}${
                      withdrawn.basis.withdrawn_reason ? `: ${withdrawn.basis.withdrawn_reason}` : ""
                    }.`
                  : `${mark.bases.join(", ")} was withdrawn.`
                : "No verified basis supports this date."}
            </span>
            <span className="mt-2 block">
              {mayRecord ? (
                <Button variant="solid" onClick={() => setRecording(true)}>
                  {mark.status === "withdrawn" ? "Record a new basis" : "Record basis"}
                </Button>
              ) : (
                <span className="text-text2">The engineering lead verifies dates</span>
              )}
            </span>
          </div>,
          document.body,
        )}
      {recording && ctx.rights && (
        <DateBasisDialog
          rights={ctx.rights}
          prefill={{
            prd: ctx.prd ?? undefined,
            supports_date: mark.date,
            reference: namedReference(ctx.sectionText(mark.section_key), mark.text),
          }}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            setOpen(null);
            ctx.onChanged();
          }}
        />
      )}
    </>
  );
}

"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ds/Button";

/** How long an acted row keeps its outcome (and Undo) before the list settles. */
export const SETTLE_MS = 1200;

export type Acted = { key: string; outcome: string; undo?: () => void };

/**
 * After a destructive action the acted row stays where it was, showing its outcome and
 * Undo, for SETTLE_MS; meanwhile every other row ignores the pointer, so a second click
 * (or the click that closed the confirm dialog) never lands on another row's Remove or
 * Revoke that moved under it. `settle` runs when the time is up (drop the row, refetch).
 */
export function useActed() {
  const [acted, setActed] = useState<Acted | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const after = useRef<(() => void) | null>(null);

  const finish = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const fn = after.current;
    after.current = null;
    setActed(null);
    fn?.();
  }, []);

  const mark = useCallback(
    (next: Acted, settle?: () => void) => {
      if (timer.current) finish();
      after.current = settle ?? null;
      setActed(next);
      timer.current = setTimeout(finish, SETTLE_MS);
    },
    [finish],
  );

  /** Undo: cancels the settle and runs the row's undo. */
  const undo = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    after.current = null;
    const fn = acted?.undo;
    setActed(null);
    fn?.();
  }, [acted]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  /** Row attributes: the acted row is marked, the others are inert to the pointer. */
  const rowAttrs = (key: string): Record<string, string | undefined> =>
    acted ? (acted.key === key ? { "data-acted": "true" } : { "data-settling": "true" }) : {};

  return { acted, mark, undo, rowAttrs };
}

/** Classes for a list wrapper: rows marked settling ignore the pointer. */
export const SETTLING = "[&_[data-settling]]:pointer-events-none";

/** The acted row's outcome in place of its action, with Undo when there is one. */
export function ActedCell({ acted, onUndo }: { acted: Acted; onUndo: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" role="status" data-testid="acted">
      <span className="text-sm font-semibold text-text2">{acted.outcome}</span>
      {acted.undo && (
        <Button variant="ghost" onClick={onUndo}>
          Undo
        </Button>
      )}
    </span>
  );
}

/**
 * A control that cannot be used here, kept visible and focusable with the reason in a
 * tooltip (hover or focus): aria-disabled rather than disabled, so the tooltip still
 * opens and screen readers read the reason with the control.
 */
export function Unavailable({
  reason,
  children,
  testId,
}: {
  reason: string;
  children: (props: { "aria-disabled": true; "aria-describedby": string; onClick: (e: { preventDefault(): void }) => void }) => ReactNode;
  testId?: string;
}) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  // Fixed to the viewport, so a table's overflow clip never cuts it: below the control,
  // right-aligned with it.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const show = () => {
    const r = root.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) });
  };
  return (
    <span
      ref={root}
      className="inline-flex"
      data-testid={testId}
      onMouseEnter={show}
      onMouseLeave={() => setAt(null)}
      onFocus={show}
      onBlur={() => setAt(null)}
    >
      {children({ "aria-disabled": true, "aria-describedby": id, onClick: (e) => e.preventDefault() })}
      <span
        id={id}
        role="tooltip"
        hidden={!at}
        style={at ? { position: "fixed", top: at.top, right: at.right } : undefined}
        className="z-50 w-max max-w-[min(300px,calc(100vw-24px))] rounded-button bg-tip px-3 py-2 text-left text-sm leading-5 font-normal whitespace-normal text-tip-text shadow-tip"
      >
        {reason}
      </span>
    </span>
  );
}

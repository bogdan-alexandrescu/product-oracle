"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";

export type ToastAsk = {
  message: string;
  /** One action beside the message ("Undo"); the toast closes when it is pressed. */
  action?: { label: string; onClick: () => void };
  /** "corner": bottom-right on a desktop, clear of a wide chart (Simple's Roadmap, #34);
   * a phone keeps the centred strip. Every other toast stays centred. */
  place?: "corner";
};

type Shown = ToastAsk & { id: number };

let show: ((ask: ToastAsk) => void) | null = null;
const LIFETIME_MS = 10_000;

/** A message at the bottom of the screen for ten seconds; a new one replaces it (#482). */
export function toast(ask: ToastAsk) {
  show?.(ask);
}

/** Draws what `toast` says (one per app: the shell mounts it). */
export function ToastHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const next = useRef(0);
  useEffect(() => {
    show = (ask) => setShown({ ...ask, id: ++next.current });
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown((s) => (s?.id === shown.id ? null : s)), LIFETIME_MS);
    return () => window.clearTimeout(t);
  }, [shown]);
  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-3 max-[600px]:bottom-20${shown?.place === "corner" ? " min-[601px]:inset-x-auto min-[601px]:right-4 min-[601px]:justify-end min-[601px]:px-0" : ""}`}
    >
      {shown && (
        <div
          key={shown.id}
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex max-w-[min(560px,100%)] min-w-0 items-center gap-3 rounded-panel border border-line bg-hero px-4 py-2.5 text-[15px] text-hero-text shadow-tip"
        >
          <span className="min-w-0 break-words">{shown.message}</span>
          {shown.action && (
            <button
              type="button"
              className="h-8 flex-none rounded-lg px-2.5 text-sm font-semibold text-hero-text underline-offset-2 hover:bg-hero-2 hover:underline"
              onClick={() => {
                const act = shown.action!.onClick;
                setShown(null);
                act();
              }}
            >
              {shown.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            className="grid size-8 flex-none place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"
            onClick={() => setShown(null)}
          >
            <Icon name="x" size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

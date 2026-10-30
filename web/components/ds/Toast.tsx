"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "./Icon";

export type ToastAsk = {
  message: string;
  /** One action beside the message ("Undo"); the toast closes when it is pressed. */
  action?: { label: string; onClick: () => void };
  /** "corner": bottom-right on a desktop, clear of a wide chart (Simple's Roadmap, #34);
   * "rail": bottom-left on a desktop, over Simple's rail, clear of the main column's buttons
   * (qa-simple-home-30); a phone keeps the centred strip. Every other toast stays centred. */
  place?: "corner" | "rail";
};

type Shown = ToastAsk & { id: number };

let show: ((ask: ToastAsk) => void) | null = null;
/** Where a toast sits when it does not say (a page sets it while it is open: Simple's Home, "rail"). */
let pagePlace: ToastAsk["place"];

/** A page's own default place for its toasts, until it returns the cleanup (qa-simple-home-30). */
export function setToastPlace(place: ToastAsk["place"]): () => void {
  pagePlace = place;
  return () => {
    if (pagePlace === place) pagePlace = undefined;
  };
}
const LIFETIME_MS = 10_000;

/** A message at the bottom of the screen for ten seconds (paused while hovered or focused); a new one replaces it (#482). */
export function toast(ask: ToastAsk) {
  show?.(ask);
}

/** Draws what `toast` says (one per app: the shell mounts it). */
export function ToastHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const next = useRef(0);
  // Hovered or focused, the toast holds: its time left waits until the pointer and focus leave.
  // (Held by its id: a toast closed while hovered never holds the next one.)
  const [heldId, setHeldId] = useState<number | null>(null);
  const held = shown != null && heldId === shown.id;
  const left = useRef(LIFETIME_MS);
  useEffect(() => {
    show = (ask) => setShown({ place: pagePlace, ...ask, id: ++next.current });
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    left.current = LIFETIME_MS;
  }, [shown?.id]);
  useEffect(() => {
    if (!shown || held) return;
    const from = Date.now();
    const t = window.setTimeout(() => setShown((s) => (s?.id === shown.id ? null : s)), left.current);
    return () => {
      window.clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - from));
    };
  }, [shown, held]);
  return (
    // While a sheet or a modal dialog is open, the message moves to the top, clear of its controls;
    // the Roadmap's own messages sit in the corner on a desktop.
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-3 max-[600px]:bottom-20 [body:has([aria-modal=true])_&]:bottom-auto [body:has([aria-modal=true])_&]:top-4${shown?.place === "corner" ? " min-[601px]:inset-x-auto min-[601px]:right-4 min-[601px]:justify-end min-[601px]:px-0" : ""}${shown?.place === "rail" ? " min-[601px]:inset-x-auto min-[601px]:left-4 min-[601px]:justify-start min-[601px]:px-0" : ""}`}
    >
      {shown && (
        <div
          key={shown.id}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setHeldId(shown.id)}
          onMouseLeave={() => setHeldId(null)}
          onFocus={() => setHeldId(shown.id)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeldId(null);
          }}
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

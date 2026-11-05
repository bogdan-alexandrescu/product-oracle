"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "./Icon";

export type ToastAsk = {
  message: string;
  /** One action beside the message ("Undo"); the toast closes when it is pressed. */
  action?: { label: string; onClick: () => void };
  /** "corner": bottom-right on a desktop, clear of a wide chart (Simple's Roadmap, #34);
   * "rail": bottom-left on a desktop, just right of Simple's rail (qa4-simple-home-11: never over
   * its Ask Oracle and account), clear of the main column's buttons on the right
   * (qa-simple-home-30); a phone keeps the centred strip. Every other toast stays centred. */
  place?: "corner" | "rail";
  /** What the message must not cover (a CSS selector: the row its action came from, roadmap-decide
   * review): where it would at the bottom, it sits at the top of the screen instead. */
  avoid?: string;
};

/** How much of the `avoid` elements a toast `w` wide at `x`, between `top` and `top + h`, would cover. */
function covers(avoid: string, x: number, w: number, top: number, h: number): number {
  let area = 0;
  for (const el of document.querySelectorAll(avoid)) {
    const r = el.getBoundingClientRect();
    area += Math.max(0, Math.min(r.right, x + w) - Math.max(r.left, x)) * Math.max(0, Math.min(r.bottom, top + h) - Math.max(r.top, top));
  }
  return area;
}

type Shown = ToastAsk & { id: number };

let show: ((ask: ToastAsk) => void) | null = null;
let hide: ((message: string) => void) | null = null;
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

/** Closes the toast on screen if it still says `message` (a message about a state that is gone, qa4-simple-roadmap-43). */
export function clearToast(message: string) {
  hide?.(message);
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
  // Up: at the top of the screen, as its `avoid` would be covered at the bottom (checked again as the page scrolls or redraws).
  const host = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  const avoid = shown?.avoid;
  useLayoutEffect(() => {
    setUp(false);
    if (!avoid) return;
    const check = () => {
      const box = host.current?.querySelector('[role="status"]')?.getBoundingClientRect();
      if (!box) return;
      const bottom = window.innerHeight - (window.innerWidth <= 600 ? 80 : 16) - box.height;
      setUp(covers(avoid, box.left, box.width, bottom, box.height) > covers(avoid, box.left, box.width, 16, box.height));
    };
    check();
    const t = window.setInterval(check, 200);
    window.addEventListener("resize", check);
    document.addEventListener("scroll", check, true);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", check);
      document.removeEventListener("scroll", check, true);
    };
  }, [shown?.id, avoid]);
  useEffect(() => {
    show = (ask) => setShown({ place: pagePlace, ...ask, id: ++next.current });
    hide = (message) => setShown((s) => (s?.message === message ? null : s));
    return () => {
      show = null;
      hide = null;
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
      ref={host}
      data-testid="toasts"
      data-up={up ? "" : undefined}
      className={`pointer-events-none fixed left-0 right-[var(--backdrop-room,0px)] bottom-4 z-[60] flex justify-center px-3 max-[600px]:bottom-20 [body:has([aria-modal=true])_&]:bottom-auto [body:has([aria-modal=true])_&]:top-4${shown?.place === "corner" ? " min-[601px]:inset-x-auto min-[601px]:right-4 min-[601px]:justify-end min-[601px]:px-0" : ""}${shown?.place === "rail" ? " min-[601px]:inset-x-auto min-[601px]:left-[calc(var(--simple-rail-width,232px)+16px)] min-[601px]:justify-start min-[601px]:px-0" : ""}${up ? " bottom-auto! top-4" : ""}`}
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

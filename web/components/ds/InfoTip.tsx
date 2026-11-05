"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * The (i) tooltip that holds every explanation (I3 rule 1: no visible prose).
 * Opens on hover, keyboard focus or click; Escape or a click outside closes it.
 * The text is always in the DOM and named by aria-describedby, so screen readers
 * read it with the button.
 */
export function InfoTip({
  label,
  children,
  align = "end",
  side = "top",
  hero = false,
  trigger,
  testId = "info-tip",
}: {
  /** What the tip is about; the button's name is "About <label>". */
  label: string;
  children: ReactNode;
  /** Which edge of the tip lines up with the (i). */
  align?: "start" | "end";
  side?: "top" | "bottom";
  /** On a dark Inspector head. */
  hero?: boolean;
  /** What opens the tip in place of the (i), e.g. a "3 warnings" chip: the button's name is its text. */
  trigger?: ReactNode;
  testId?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const shown = open || pinned;
  // The open tip is fixed to the window, placed beside its (i), so a cell or panel that cuts
  // off what overflows it (a truncated table cell, the Inspector) never clips it, and it
  // paints above the rows round it. It stays inside the window with a 12 px margin: narrowed
  // to the room there, then shifted in. qa-docs-19: `flip` puts it on the other side when
  // the window has no room on its own.
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    const el = tip.current;
    if (!shown || !el || !root.current) {
      setFlip(false);
      return;
    }
    const place = () => {
      const at = root.current?.getBoundingClientRect();
      if (!at) return;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      Object.assign(el.style, { left: "0px", top: "0px", maxWidth: "" });
      // A transformed ancestor makes itself the fixed tip's frame: measure that frame's offset.
      const base = el.getBoundingClientRect();
      const width = Math.min(base.width, vw - 24);
      if (width < base.width) el.style.maxWidth = `${width}px`;
      const height = el.getBoundingClientRect().height;
      // Unshifted, the tip keeps the edge `align` names 12 px past the (i).
      const want = align === "end" ? at.right + 12 - width : at.left - 12;
      const left = Math.min(Math.max(want, 12), vw - 12 - width);
      const above = at.top - 10 - height;
      const below = at.bottom + 10;
      const flipped = side === "top" ? above < 0 && vh - at.bottom > at.top : below + height > vh && at.top > vh - at.bottom;
      const top = (side === "top") !== flipped ? above : below;
      Object.assign(el.style, { left: `${left - base.left}px`, top: `${top - base.top}px` });
      setFlip(flipped);
    };
    place();
    // Kept beside its (i) as the page or a panel scrolls, or the window resizes.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [shown, align, side]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [shown]);

  const ring = hero ? "border-hero-text2 text-hero-text2" : "border-text2 text-text2";
  return (
    <span
      ref={root}
      className="relative inline-flex flex-none self-center align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={trigger ? undefined : `About ${label}`}
        aria-describedby={id}
        aria-expanded={shown}
        data-testid={testId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setPinned((p) => !p)}
        // A 24 px hit area round the 20 px (i) (qa-company-49), 44 px on a phone (an invisible
        // pad); never stretched by a row or a touch sheet's 44 px min-height (qa-shell-21).
        className={
          trigger
            ? "relative inline-flex min-h-0! flex-none self-center rounded-full before:absolute before:inset-0 before:rounded-full before:content-[''] max-[600px]:before:-inset-y-2.5"
            : "relative grid size-6 min-h-6! flex-none place-items-center self-center rounded-full before:absolute before:inset-0 before:rounded-full before:content-[''] max-[600px]:before:-inset-2.5"
        }
      >
        {trigger ?? (
          <span
            aria-hidden
            className={`grid size-5 place-items-center rounded-full border-[1.5px] font-serif text-[13px] leading-none font-bold italic ${
              shown ? "border-accent bg-accent text-on-accent" : ring
            }`}
          >
            i
          </span>
        )}
      </button>
      <span
        ref={tip}
        id={id}
        role="tooltip"
        data-side={(side === "top") !== flip ? "top" : "bottom"}
        hidden={!shown}
        className="fixed z-50 w-max max-w-[min(380px,calc(100vw-24px))] rounded-button bg-tip px-3.5 py-2.5 text-left text-sm leading-5 font-normal tracking-normal whitespace-normal text-tip-text not-italic shadow-tip"
      >
        {children}
      </span>
    </span>
  );
}

"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
}: {
  /** What the tip is about; the button's name is "About <label>". */
  label: string;
  children: ReactNode;
  /** Which edge of the tip lines up with the (i). */
  align?: "start" | "end";
  side?: "top" | "bottom";
  /** On a dark Inspector head. */
  hero?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const shown = open || pinned;

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
      className="relative inline-flex flex-none align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={id}
        aria-expanded={shown}
        data-testid="info-tip"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setPinned((p) => !p)}
        className={`grid size-5 place-items-center rounded-full border-[1.5px] font-serif text-[13px] leading-none font-bold italic ${
          shown ? "border-accent bg-accent text-on-accent" : ring
        }`}
      >
        i
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!shown}
        className={`absolute z-50 w-max max-w-[min(380px,calc(100vw-24px))] rounded-button bg-tip px-3.5 py-2.5 text-left text-sm leading-5 font-normal tracking-normal whitespace-normal text-tip-text not-italic shadow-tip ${
          side === "top" ? "bottom-[calc(100%+10px)]" : "top-[calc(100%+10px)]"
        } ${align === "end" ? "-right-3" : "-left-3"}`}
      >
        {children}
      </span>
    </span>
  );
}

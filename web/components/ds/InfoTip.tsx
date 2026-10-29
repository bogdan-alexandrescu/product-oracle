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
  const tip = useRef<HTMLSpanElement>(null);
  const shown = open || pinned;
  // Keep an open tip inside the viewport, or inside a scrolling panel that clips it (the
  // Inspector), with a 12 px margin: narrow it to the room there, then shift it in.
  // qa-docs-19: `flip` puts it on the other side when the window has no room on its own.
  const [fit, setFit] = useState<{ shift: number; width?: number; flip?: boolean }>({ shift: 0 });

  useLayoutEffect(() => {
    if (!shown || !tip.current) {
      setFit({ shift: 0 });
      return;
    }
    let lo = 0;
    let hi = document.documentElement.clientWidth;
    for (let el = root.current?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (getComputedStyle(el).overflowX !== "visible") {
        const r = el.getBoundingClientRect();
        lo = Math.max(lo, r.left);
        hi = Math.min(hi, r.right);
        break;
      }
    }
    lo += 12;
    hi -= 12;
    const box = tip.current.getBoundingClientRect();
    const width = Math.min(box.width, hi - lo);
    // Unshifted, the tip keeps the edge `align` names next to the (i).
    const left = align === "end" ? box.right - fit.shift - width : box.left - fit.shift;
    const shift = left < lo ? lo - left : left + width > hi ? hi - (left + width) : 0;
    // Cut off by the window's top (bottom) edge, with more room on the other side of the (i).
    const view = document.documentElement.clientHeight;
    const at = root.current?.getBoundingClientRect();
    const flip = !!at && (side === "top" ? box.top < 0 && view - at.bottom > at.top : box.bottom > view && at.top > view - at.bottom);
    setFit({ shift, width: width < box.width ? width : undefined, flip });
    // Measured once per opening; fitting does not re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

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
        aria-label={`About ${label}`}
        aria-describedby={id}
        aria-expanded={shown}
        data-testid="info-tip"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setPinned((p) => !p)}
        // A 24 px hit area round the 20 px (i) (qa-company-49), 44 px on a phone (an invisible
        // pad); never stretched by a row or a touch sheet's 44 px min-height (qa-shell-21).
        className="relative grid size-6 min-h-6! flex-none place-items-center self-center rounded-full before:absolute before:inset-0 before:rounded-full before:content-[''] max-[600px]:before:-inset-2.5"
      >
        <span
          aria-hidden
          className={`grid size-5 place-items-center rounded-full border-[1.5px] font-serif text-[13px] leading-none font-bold italic ${
            shown ? "border-accent bg-accent text-on-accent" : ring
          }`}
        >
          i
        </span>
      </button>
      <span
        ref={tip}
        id={id}
        role="tooltip"
        data-side={(side === "top") !== !!fit.flip ? "top" : "bottom"}
        hidden={!shown}
        style={{
          ...(fit.shift ? { transform: `translateX(${fit.shift}px)` } : {}),
          ...(fit.width ? { maxWidth: fit.width } : {}),
        }}
        className={`absolute z-50 w-max max-w-[min(380px,calc(100vw-24px))] rounded-button bg-tip px-3.5 py-2.5 text-left text-sm leading-5 font-normal tracking-normal whitespace-normal text-tip-text not-italic shadow-tip ${
          (side === "top") !== !!fit.flip ? "bottom-[calc(100%+10px)]" : "top-[calc(100%+10px)]"
        } ${align === "end" ? "-right-3" : "-left-3"}`}
      >
        {children}
      </span>
    </span>
  );
}

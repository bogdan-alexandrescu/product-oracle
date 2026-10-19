"use client";

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { Icon } from "./Icon";

/**
 * A one-line strip that scrolls sideways (sections, tabs). When items overflow, the edge
 * with more to see fades and a chevron button beside the strip scrolls it, so a cut-off
 * item reads as "more". The buttons sit outside the scrolling area: the strip never runs
 * under adjacent content. The current item (aria-current or aria-selected) is kept in full
 * view, clear of the fades. `ref` and the other props go to the scrolling element.
 */
/** Room kept between the current item and an edge: the fade (32 px) plus a little air. */
const REVEAL_PAD = 40;

/** Scrolls the strip so its current item sits in full view, clear of the edge fades. */
function reveal(s: HTMLElement) {
  if (s.scrollWidth <= s.clientWidth) return;
  const on = s.querySelector<HTMLElement>('[aria-current="page"], [aria-current="true"], [aria-selected="true"]');
  if (!on) return;
  const box = s.getBoundingClientRect();
  const item = on.getBoundingClientRect();
  const pad = Math.min(REVEAL_PAD, Math.max(0, (box.width - item.width) / 2));
  if (item.right > box.right - pad) s.scrollLeft += item.right - (box.right - pad);
  else if (item.left < box.left + pad) s.scrollLeft -= box.left + pad - item.left;
}

export function ScrollStrip({
  children,
  className = "",
  stripClassName = "",
  ref,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "className"> & {
  children: ReactNode;
  /** The wrapper (strip plus buttons). */
  className?: string;
  /** The scrolling element. */
  stripClassName?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const s = el.current;
    if (!s) return;
    const left = s.scrollLeft > 1;
    const right = s.scrollLeft + s.clientWidth < s.scrollWidth - 1;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);

  useEffect(() => {
    const s = el.current;
    if (!s) return;
    // On mount and resize only, so the reader can still scroll the current item away.
    const settle = () => {
      reveal(s);
      measure();
    };
    settle();
    // Showing a chevron narrows the strip after the first measure: settle again.
    const raf = requestAnimationFrame(settle);
    const ro = new ResizeObserver(settle);
    ro.observe(s);
    for (const c of s.children) ro.observe(c);
    s.addEventListener("scroll", measure, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      s.removeEventListener("scroll", measure);
    };
  }, [measure, children]);

  const setRef = (node: HTMLDivElement | null) => {
    el.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  const page = (dir: 1 | -1) => {
    const s = el.current;
    if (s) s.scrollBy({ left: dir * Math.max(80, s.clientWidth * 0.7), behavior: "smooth" });
  };
  const button = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      data-testid={dir === 1 ? "strip-more-right" : "strip-more-left"}
      onClick={() => page(dir)}
      className="grid w-7 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
    >
      <Icon name={dir === 1 ? "chevron-right" : "chevron-left"} size={16} />
    </button>
  );

  return (
    <div className={`flex min-w-0 items-stretch ${className}`}>
      {more.left && button(-1)}
      <div
        ref={setRef}
        {...rest}
        data-more-left={more.left || undefined}
        data-more-right={more.right || undefined}
        className={`flex min-w-0 flex-1 overflow-x-auto scroll-fade ${stripClassName}`}
      >
        {children}
      </div>
      {more.right && button(1)}
    </div>
  );
}

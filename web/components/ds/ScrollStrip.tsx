"use client";

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { Icon } from "./Icon";

/**
 * A one-line strip that scrolls sideways (sections, tabs). When items overflow, the edge
 * with more to see fades and a chevron button beside the strip scrolls it, so a cut-off
 * item reads as "more". The buttons sit outside the scrolling area: the strip never runs
 * under adjacent content. `ref` and the other props go to the scrolling element.
 */
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
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    for (const c of s.children) ro.observe(c);
    s.addEventListener("scroll", measure, { passive: true });
    return () => {
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

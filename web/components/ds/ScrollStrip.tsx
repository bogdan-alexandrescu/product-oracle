"use client";

import { useCallback, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { Icon } from "./Icon";

/**
 * A one-line strip that scrolls sideways (sections, tabs). When items overflow, a pair of
 * named chevron buttons beside the strip pages it by whole items, and the edge with more to
 * see fades. The strip snaps to item starts (a swipe never stops mid-word), and an item cut
 * by an edge is faded out up to the first whole item, so no label shows cut mid-word: the
 * faint remainder reads as "more". The buttons sit outside the scrolling area: the strip
 * never runs under them or adjacent content. The current item (aria-current or
 * aria-selected) is kept in full view when it changes. `ref` and the other props go to the
 * scrolling element.
 */
const CURRENT = '[aria-current="page"], [aria-current="true"], [aria-selected="true"]';

/** The strip's items as [start, end] in scrollLeft terms (sr-only and empty children skipped). */
function spans(s: HTMLElement): [number, number][] {
  const pad = parseFloat(getComputedStyle(s).paddingLeft) || 0;
  const out: [number, number][] = [];
  for (const c of s.children) {
    if (!(c instanceof HTMLElement) || c.offsetWidth <= 1) continue;
    out.push([c.offsetLeft - pad, c.offsetLeft - pad + c.offsetWidth]);
  }
  return out;
}

const maxScroll = (s: HTMLElement) => Math.max(0, s.scrollWidth - s.clientWidth);

/** The snap position (an item start, or the end) that shows [start, end] whole, scrolling least. */
function showing(s: HTMLElement, items: [number, number][], [start, end]: [number, number]) {
  const max = maxScroll(s);
  if (start < s.scrollLeft) return Math.max(0, Math.min(max, start));
  // The first item start from which `end` is in view.
  const need = end - s.clientWidth;
  const at = items.find(([a]) => a >= need - 0.5);
  return Math.max(0, Math.min(max, at ? Math.min(at[0], start) : start));
}

/** Scrolls the strip so its current item sits in full view, at a snap position. */
function reveal(s: HTMLElement) {
  if (s.scrollWidth <= s.clientWidth) return;
  const on = s.querySelector<HTMLElement>(CURRENT);
  if (!on) return;
  const items = spans(s);
  const pad = parseFloat(getComputedStyle(s).paddingLeft) || 0;
  const span: [number, number] = [on.offsetLeft - pad, on.offsetLeft - pad + on.offsetWidth];
  const L = s.scrollLeft;
  if (span[0] >= L - 0.5 && span[1] <= L + s.clientWidth + 0.5) return;
  s.scrollLeft = showing(s, items, span);
}

export function ScrollStrip({
  children,
  className = "",
  stripClassName = "",
  itemsName,
  ref,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "className"> & {
  children: ReactNode;
  /** The wrapper (strip plus buttons). */
  className?: string;
  /** The scrolling element. */
  stripClassName?: string;
  /** What the strip holds, for its chevrons' names ("tabs": Scroll tabs right); none: Scroll right. */
  itemsName?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const s = el.current;
    if (!s) return;
    const left = s.scrollLeft > 1;
    const right = s.scrollLeft + s.clientWidth < s.scrollWidth - 1;
    // How far in from each edge the first whole item starts: the fade (scroll-fade) hides
    // a cut item up to there, so no label shows cut mid-word.
    let cutL = 0;
    let cutR = 0;
    if (left || right) {
      const L = s.scrollLeft;
      const R = L + s.clientWidth;
      const whole = spans(s).filter(([a, b]) => a >= L - 0.5 && b <= R + 0.5);
      if (whole.length) {
        cutL = Math.max(0, whole[0][0] - L);
        cutR = Math.max(0, R - whole[whole.length - 1][1]);
      }
      const cap = s.clientWidth / 2;
      cutL = Math.min(cutL, cap);
      cutR = Math.min(cutR, cap);
    }
    s.style.setProperty("--cut-l", `${Math.round(cutL)}px`);
    s.style.setProperty("--cut-r", `${Math.round(cutR)}px`);
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);

  // Until the reader moves the strip themselves (a chevron, a swipe, the wheel), layout
  // changes (the chevrons appearing, web fonts arriving) keep the current item in view.
  // After that only a NEW current item is revealed: reveal() used to run on every render
  // and snapped the strip back after each chevron click.
  const moved = useRef(false);
  const revealed = useRef<Element | null>(null);

  // Observers on mount only (children change identity on every render).
  useEffect(() => {
    const s = el.current;
    if (!s) return;
    // Snap positions are item starts measured from the content box: pad the snapport alike.
    const cs = getComputedStyle(s);
    s.style.scrollPaddingInline = `${cs.paddingLeft} ${cs.paddingRight}`;
    const settle = () => {
      if (!moved.current) reveal(s);
      measure();
    };
    const raf = requestAnimationFrame(settle);
    const ro = new ResizeObserver(settle);
    const observe = () => {
      ro.disconnect();
      ro.observe(s);
      for (const c of s.children) ro.observe(c);
    };
    observe();
    const mo = new MutationObserver(() => {
      observe();
      settle();
    });
    mo.observe(s, { childList: true });
    const byReader = () => {
      moved.current = true;
    };
    s.addEventListener("scroll", measure, { passive: true });
    s.addEventListener("wheel", byReader, { passive: true });
    s.addEventListener("touchstart", byReader, { passive: true });
    s.addEventListener("pointerdown", byReader, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      s.removeEventListener("scroll", measure);
      s.removeEventListener("wheel", byReader);
      s.removeEventListener("touchstart", byReader);
      s.removeEventListener("pointerdown", byReader);
    };
  }, [measure]);

  // A new current item: reveal it (and let layout keep it in view until the reader moves).
  useEffect(() => {
    const s = el.current;
    if (!s) return;
    const on = s.querySelector(CURRENT);
    if (on === revealed.current) return;
    revealed.current = on;
    moved.current = false;
    reveal(s);
    measure();
  });

  const setRef = (node: HTMLDivElement | null) => {
    el.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  // Pages by whole items: right brings the first item cut at the right edge to the left
  // edge; left brings the last item cut at the left edge fully into view at the right.
  const page = (dir: 1 | -1) => {
    const s = el.current;
    moved.current = true;
    if (!s) return;
    const items = spans(s);
    const L = s.scrollLeft;
    const R = L + s.clientWidth;
    let target: number;
    if (dir === 1) {
      const next = items.find(([a, b]) => b > R + 0.5 && a > L + 0.5);
      target = next ? next[0] : maxScroll(s);
    } else {
      const prev = [...items].reverse().find(([a]) => a < L - 0.5);
      // The first item start from which `prev` ends in view (at most its own start).
      const at = prev && items.find(([a]) => a >= prev[1] - s.clientWidth - 0.5);
      target = prev ? Math.min(at ? at[0] : prev[0], prev[0]) : 0;
    }
    s.scrollTo({ left: Math.max(0, Math.min(maxScroll(s), target)), behavior: "smooth" });
  };
  const autoId = useId();
  const id = rest.id ?? autoId;
  const overflow = more.left || more.right;
  // Both buttons show while anything overflows (the layout stays put as the reader pages,
  // and keyboard focus is not lost when one runs out); the one with nothing further is dimmed.
  const button = (dir: 1 | -1) => {
    const live = dir === 1 ? more.right : more.left;
    return (
      <button
        type="button"
        aria-label={`Scroll ${itemsName ? `${itemsName} ` : ""}${dir === 1 ? "right" : "left"}`}
        aria-controls={id}
        aria-disabled={live ? undefined : true}
        data-testid={dir === 1 ? "strip-more-right" : "strip-more-left"}
        onClick={() => live && page(dir)}
        className={`grid h-7 w-7 flex-none place-items-center self-center rounded-lg ${
          live ? "text-text2 hover:bg-surface2 hover:text-text" : "cursor-default text-text2 opacity-40"
        }`}
      >
        <Icon name={dir === 1 ? "chevron-right" : "chevron-left"} size={16} />
      </button>
    );
  };

  return (
    <div className={`flex min-w-0 items-stretch ${className}`}>
      {overflow && button(-1)}
      <div
        ref={setRef}
        {...rest}
        id={id}
        data-more-left={more.left || undefined}
        data-more-right={more.right || undefined}
        // relative: absolutely positioned children (.sr-only labels) are clipped by the
        // strip; without it they escaped to the page and widened it (21,825 px on a
        // 102-section PRD).
        // The 1 px spacer after the last item: items have fractional widths while the scroll
        // range is whole pixels, so without it the last item ends up to a pixel past the
        // strip's edge at the end of the scroll, clipped there.
        className={`relative flex min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto scroll-fade after:w-px after:flex-none after:content-[''] [&>*]:snap-start ${stripClassName}`}
      >
        {children}
      </div>
      {overflow && button(1)}
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** The room a floating panel keeps from the viewport's edges. */
export const FIT_MARGIN = 16;
/** Marks a fitted panel's scrolling body (below its header with the title and close). */
export const FIT_BODY = "data-fit-body";

// PageDown / PageUp move the body by most of its height; End / Home to its foot / head.
const STEPS: Record<string, number> = { PageDown: 0.9, PageUp: -0.9, End: Infinity, Home: -Infinity };
const TYPING = 'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"], [role="combobox"]';

/**
 * BGD (Nov 10): a floating panel always fits the viewport. An absolute panel (`top` in its
 * offset parent) opens below its anchor where it fits, else above `anchor` (its bar) when that
 * fits, else as high as it needs, never above the viewport's top; any panel's height is capped to
 * the viewport less a margin (`follow`: a sticky or in-flow panel, its cap kept as the page
 * scrolls). Its body ([data-fit-body]) scrolls inside, the header staying in view
 * (useScrollInside). Returns the `top` to apply (undefined: as given)
 * and the `maxHeight`.
 */
export function useFitViewport(
  ref: RefObject<HTMLElement | null>,
  { on = true, top, anchor, follow = false }: { on?: boolean; top?: number; anchor?: () => Element | null; follow?: boolean },
): { top?: number; maxHeight?: number } {
  const [fit, setFit] = useState<{ top?: number; maxHeight?: number }>({});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return setFit({});
    const bodyOf = () => el.querySelector<HTMLElement>(`[${FIT_BODY}]`) ?? el;
    const measure = () => {
      const body = bodyOf();
      const vh = window.innerHeight;
      const room = vh - 2 * FIT_MARGIN;
      // The panel's whole height were it never capped: its header and its body's full content.
      const whole = body === el ? el.scrollHeight : el.offsetHeight - body.clientHeight + body.scrollHeight;
      const h = Math.min(whole, room);
      const r = el.getBoundingClientRect();
      if (top == null) {
        const cap = Math.max(160, vh - FIT_MARGIN - Math.max(FIT_MARGIN, r.top));
        return setFit((f) => (f.top == null && f.maxHeight === cap ? f : { maxHeight: cap }));
      }
      // Where the offset parent's top edge is on screen (independent of the top applied now).
      const edge = r.top - el.offsetTop;
      let at = edge + top;
      if (at + h > vh - FIT_MARGIN) {
        const bar = anchor?.()?.getBoundingClientRect();
        at = bar && bar.top - 6 - h >= FIT_MARGIN ? bar.top - 6 - h : Math.max(FIT_MARGIN, vh - FIT_MARGIN - h);
      }
      const next = Math.round(at - edge);
      setFit((f) => (f.top === next && f.maxHeight === room ? f : { top: next, maxHeight: room }));
    };
    measure();
    // The panel's content grows (a picker, a reason opened): placed again.
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    const grows = new MutationObserver(measure);
    grows.observe(el, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    if (follow) window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      seen.disconnect();
      grows.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [ref, on, top, anchor, follow]);
  useScrollInside(ref, on);
  return on ? fit : {};
}

/**
 * A panel whose body ([data-fit-body], or the panel itself) scrolls: the wheel or a trackpad over
 * its header and PageDown / PageUp / Home / End on it scroll the body, never the page behind.
 */
export function useScrollInside(ref: RefObject<HTMLElement | null>, on = true) {
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const bodyOf = () => el.querySelector<HTMLElement>(`[${FIT_BODY}]`) ?? el;
    // The wheel over the header scrolls the body, not the page behind.
    const onWheel = (e: WheelEvent) => {
      const body = bodyOf();
      if (body === el || body.contains(e.target as Node) || body.scrollHeight <= body.clientHeight) return;
      body.scrollTop += e.deltaY;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const step = STEPS[e.key];
      if (step == null || e.defaultPrevented || (e.target as Element | null)?.closest?.(TYPING)) return;
      const body = bodyOf();
      body.scrollTop = Number.isFinite(step) ? body.scrollTop + step * body.clientHeight : step > 0 ? body.scrollHeight : 0;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
    };
  }, [ref, on]);
}

/** A fixed panel pinned 16 px from the viewport's top, with no ref to fit: its height capped to
 * the viewport less the margins, scrolling inside (the milestone panel). */
export const FIT_FIXED = "max-h-[calc(100dvh-32px)] overflow-y-auto overscroll-contain";

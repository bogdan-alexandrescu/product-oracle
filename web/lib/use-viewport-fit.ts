"use client";

import { useEffect, type RefObject } from "react";

/**
 * Caps a sticky column at the viewport below its top: max-height = 100dvh - its top - `gap`
 * (its top is the sticky offset once the page has scrolled, its place on the page before).
 * Its bottom is then always on screen, and it scrolls inside itself, however tall its
 * content or the page. Only while `media` matches; otherwise the cap is removed.
 */
export function useViewportFit(ref: RefObject<HTMLElement | null>, media: string, gap = 16) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia(media);
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!mq.matches) {
          el.style.maxHeight = "";
          return;
        }
        const top = Math.max(0, el.getBoundingClientRect().top);
        el.style.maxHeight = `${Math.max(240, window.innerHeight - top - gap)}px`;
      });
    };
    fit();
    window.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    mq.addEventListener("change", fit);
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      mq.removeEventListener("change", fit);
      ro.disconnect();
      el.style.maxHeight = "";
    };
  }, [ref, media, gap]);
}

"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Keeps a page's shared state current while it is open (e2e-review-live): `refresh` runs when
 * the window gets focus or the tab is shown again, and every `intervalMs` while the tab is
 * visible (null: no interval). With `root`, only while that element is on screen: Next keeps
 * recently visited routes mounted but hidden, and those never refresh.
 */
export function useLiveRefresh(refresh: () => void, intervalMs: number | null, root?: RefObject<HTMLElement | null>) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== "visible") return;
      const el = root?.current;
      if (root && (!el || !el.isConnected || el.getClientRects().length === 0)) return;
      refreshRef.current();
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    const t = intervalMs ? window.setInterval(run, intervalMs) : null;
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
      if (t != null) window.clearInterval(t);
    };
  }, [intervalMs, root]);
}

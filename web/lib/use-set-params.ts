"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/**
 * Rewrites the page's URL query (null or "" removes a key); the page follows the URL. Each
 * change starts from the latest URL asked for, not the one the page read when it rendered:
 * the router updates the URL only once the page has rendered it, so two quick picks (Class
 * All, then From) would otherwise lose the first.
 */
export function useSetParams() {
  const router = useRouter();
  const pathname = usePathname();
  const now = useSearchParams().toString();
  // The query last asked for, until the URL changes (it landed, or back/forward moved it).
  const asked = useRef<string | null>(null);
  useEffect(() => {
    asked.current = null;
  }, [now]);
  return useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(asked.current ?? window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      asked.current = s;
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
}

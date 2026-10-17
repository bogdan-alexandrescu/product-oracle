"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api/client";

export type Query<T> = {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (update: (prev: T | undefined) => T | undefined) => void;
};

/** Message for an unknown thrown value; network failures read as "cannot reach". */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "Cannot reach the API.";
}

/** Redirects to the login page when a call fails with 401. */
export function useAuthRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return true;
      }
      return false;
    },
    [router, pathname],
  );
}

/**
 * Loads data with an API call, re-running when `key` changes. 401 sends the user
 * to the login page; other failures land in `error`.
 */
export function useQuery<T>(key: string, load: () => Promise<T>): Query<T> {
  const [state, setState] = useState<{ key: string; data?: T; error: string | null; loading: boolean }>({
    key,
    error: null,
    loading: true,
  });
  const onAuth = useAuthRedirect();
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(async () => {
    try {
      const data = await loadRef.current();
      setState({ key, data, error: null, loading: false });
    } catch (e) {
      if (!onAuth(e)) setState((s) => ({ ...s, key, error: errorMessage(e), loading: false }));
    }
  }, [key, onAuth]);

  useEffect(() => {
    let live = true;
    loadRef
      .current()
      .then((data) => live && setState({ key, data, error: null, loading: false }))
      .catch((e) => {
        if (live && !onAuth(e)) setState((s) => ({ ...s, key, error: errorMessage(e), loading: false }));
      });
    return () => {
      live = false;
    };
  }, [key, onAuth]);

  const stale = state.key !== key;
  return {
    data: stale ? undefined : state.data,
    error: stale ? null : state.error,
    loading: stale || state.loading,
    reload: run,
    setData: (update) => setState((s) => ({ ...s, data: update(s.data) })),
  };
}

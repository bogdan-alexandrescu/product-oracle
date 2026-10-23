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
 * to the login page; other failures land in `error`. With `keepPrevious`, a new key keeps
 * showing the last data (still `loading`) until its own arrives, so nothing blanks.
 */
export function useQuery<T>(key: string, load: () => Promise<T>, { keepPrevious = false }: { keepPrevious?: boolean } = {}): Query<T> {
  const [state, setState] = useState<{ key: string; data?: T; error: string | null; loading: boolean }>({
    key,
    error: null,
    loading: true,
  });
  const onAuth = useAuthRedirect();
  const loadRef = useRef(load);
  // The key on screen: a reload begun under an older key never lands over a newer one.
  const keyRef = useRef(key);
  useEffect(() => {
    loadRef.current = load;
    keyRef.current = key;
  });

  const run = useCallback(async () => {
    try {
      const data = await loadRef.current();
      if (keyRef.current === key) setState({ key, data, error: null, loading: false });
    } catch (e) {
      if (!onAuth(e) && keyRef.current === key) setState((s) => ({ ...s, key, error: errorMessage(e), loading: false }));
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
    data: stale && !keepPrevious ? undefined : state.data,
    error: stale ? null : state.error,
    loading: stale || state.loading,
    reload: run,
    setData: (update) => setState((s) => ({ ...s, data: update(s.data) })),
  };
}

"use client";

import { useEffect, useRef, useState } from "react";

import { errorMessage } from "@/lib/use-query";

export type Live<T> = {
  /** The latest answer (kept while a newer call is pending, so nothing flickers). */
  data: T | undefined;
  error: string | null;
  /** True while the input changed and its answer has not arrived yet. */
  pending: boolean;
};

/**
 * Calls `run(input)` `ms` after `input` stops changing (inputs are compared as JSON)
 * and keeps the latest answer. Used for live validation and previews while editing.
 */
export function useLive<I, T>(input: I, run: (input: I) => Promise<T>, ms = 300, enabled = true): Live<T> {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ key: string | null; data?: T; error: string | null }>({
    key: null,
    error: null,
  });
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const timer = setTimeout(() => {
      runRef
        .current(JSON.parse(key) as I)
        .then((data) => live && setState({ key, data, error: null }))
        .catch((e) => live && setState((s) => ({ ...s, key, error: errorMessage(e) })));
    }, ms);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, ms, enabled]);

  return { data: state.data, error: state.error, pending: enabled && state.key !== key };
}

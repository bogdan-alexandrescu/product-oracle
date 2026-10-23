"use client";

import { useEffect, useRef } from "react";

/** Fired after a delete, Undo or Restore (#482): lists still mounted load again. */
const EVENT = "oracle:artifacts-changed";

export function artifactsChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function useArtifactsChanged(reload: () => unknown) {
  const ref = useRef(reload);
  useEffect(() => {
    ref.current = reload;
  });
  useEffect(() => {
    const on = () => void ref.current();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}

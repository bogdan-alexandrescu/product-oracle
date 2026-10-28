"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the head-of-product panel is open: remembered per viewer in localStorage (G7 3.2,
 * a per-viewer convenience). Storage that throws reads as closed and is never retried.
 */
export const OPEN_KEY = "oracle.hop-panel.open";

let open: boolean | null = null;
/* qa-shell-19: opened by a person (the strip, ⌘J, Simple's Ask Oracle), not restored from storage: focus its question box. */
let focusAsk = false;
const listeners = new Set<() => void>();

function read(): boolean {
  if (open === null) {
    try {
      open = window.localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      open = false;
    }
  }
  return open;
}

export function setPanelOpen(next: boolean) {
  if (next && !read()) focusAsk = true;
  open = next;
  try {
    window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
  } catch {
    // Not remembered; the panel still opens.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function usePanelOpen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Whether the panel was just opened by a person (its question box takes focus); asks once. */
export function takeAskFocus(): boolean {
  const f = focusAsk;
  focusAsk = false;
  return f;
}

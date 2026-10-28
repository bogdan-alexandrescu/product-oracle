"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the head-of-product panel is open: remembered per viewer in localStorage (G7 3.2,
 * a per-viewer convenience). Storage that throws reads as closed and is never retried.
 */
export const OPEN_KEY = "oracle.hop-panel.open";

let open: boolean | null = null;
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

/**
 * prd-questions: a line to put in Simple's Ask box when the panel opens ("Ask Oracle" on a
 * question): the box shows it, ready to send or edit; `n` grows with each ask so the same
 * line asked twice fills the box again.
 */
let prefill: { text: string; n: number } = { text: "", n: 0 };
const prefillListeners = new Set<() => void>();

export function askOracle(text: string) {
  prefill = { text, n: prefill.n + 1 };
  prefillListeners.forEach((l) => l());
  setPanelOpen(true);
}

export function useAskPrefill(): { text: string; n: number } {
  return useSyncExternalStore(
    (l) => {
      prefillListeners.add(l);
      return () => {
        prefillListeners.delete(l);
      };
    },
    () => prefill,
    () => prefill,
  );
}

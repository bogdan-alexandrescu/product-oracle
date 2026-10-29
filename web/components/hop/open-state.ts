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
let draft = "";
const draftListeners = new Set<() => void>();

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

/** `remember` false: opened for one question (Simple's Ask Oracle): not reopened on the next page load (qa-simple-decide-10). */
let transient = false;
export function setPanelOpen(next: boolean, remember = true) {
  transient = next && !remember;
  if (next && !read()) focusAsk = true;
  open = next;
  // Words no box took while it was open are dropped, never shown typed in later.
  if (!next && draft) {
    draft = "";
    draftListeners.forEach((l) => l());
  }
  try {
    window.localStorage.setItem(OPEN_KEY, next && remember ? "1" : "0");
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
 * Words typed into the Ask panel's box for the reader ("Suggest from the chat": a goal's
 * drawer opens Ask with "Suggest a feature for <goal>: " typed in). The box takes them once;
 * the panel shows its box for them (./HopPanel.tsx) and closing it drops them.
 */

export function askWith(text: string) {
  draft = text;
  draftListeners.forEach((l) => l());
  // A panel the person had open on purpose stays remembered; one opened only for these words is not.
  setPanelOpen(true, read() && !transient);
}

/** Leaving the page that opened the panel for one question (Simple's Ask Oracle, a goal's Suggest) closes it (the shell, on every page change). */
export function closeTransientPanel() {
  if (transient && read()) setPanelOpen(false);
}

/** Takes the typed-in words (they are cleared). */
export function takeAskDraft(): string {
  const t = draft;
  draft = "";
  return t;
}

export function useAskDraft(): string {
  return useSyncExternalStore(
    (l) => {
      draftListeners.add(l);
      return () => {
        draftListeners.delete(l);
      };
    },
    () => draft,
    () => "",
  );
}

/** Whether the panel was just opened by a person (its question box takes focus); asks once. */
export function takeAskFocus(): boolean {
  const f = focusAsk;
  focusAsk = false;
  return f;
}

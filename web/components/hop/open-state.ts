"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useMe } from "@/lib/me";

/**
 * Whether the head-of-product panel is open: remembered per viewer in localStorage (G7 3.2,
 * a per-viewer convenience). Storage that throws reads as closed and is never retried.
 * qa-simple-home-21: it is remembered for the person who opened it (the key holds their id),
 * so the next person signing in on this browser starts with it closed; signing out closes it;
 * a visit that starts on a Simple page starts with it closed.
 */
export const OPEN_KEY = "oracle.hop-panel.open";

/** Who has it open: their id ("1": anyone, as stored before), or null when closed. */
let stored: string | null | undefined;
/** The signed-in person, as the panel's hook last saw them. */
let user: string | null = null;
/** The last signed-in person seen (undefined: none yet). */
let seen: string | null | undefined;
/* qa-shell-19: opened by a person (the strip, ⌘J, Simple's Ask Oracle), not restored from storage: focus its question box. */
let focusAsk = false;
const listeners = new Set<() => void>();
let draft = "";
const draftListeners = new Set<() => void>();

function readStored(): string | null {
  if (stored === undefined) {
    try {
      const v = window.localStorage.getItem(OPEN_KEY);
      // Simple's Ask is a clean slate: each visit to Simple starts with it closed (qa-simple-home-21).
      stored = v && v !== "0" && !window.location.pathname.startsWith("/simple") ? v : null;
    } catch {
      stored = null;
    }
  }
  return stored;
}

function openFor(who: string | null): boolean {
  const s = readStored();
  return !!s && !!who && (s === "1" || s === who);
}

/** `remember` false: opened for one question (Simple's Ask Oracle): not reopened on the next page load (qa-simple-decide-10). */
let transient = false;
export function setPanelOpen(next: boolean, remember = true) {
  transient = next && !remember;
  if (next && !openFor(user)) focusAsk = true;
  stored = next ? (user ?? "1") : null;
  // A linked discussion it showed is let go with it: the next opening starts on its chats.
  if (!next && linked) {
    linked = null;
    linkedListeners.forEach((l) => l());
  }
  // Words no box took while it was open are dropped, never shown typed in later.
  if (!next && draft) {
    draft = "";
    draftListeners.forEach((l) => l());
  }
  try {
    window.localStorage.setItem(OPEN_KEY, next && remember ? (stored ?? "0") : "0");
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
  const { me, loading } = useMe();
  const who = me ? (me.user_id ?? me.token_id ?? "me") : null;
  useEffect(() => {
    if (loading) return;
    user = who;
    // Signed out, or someone else signed in: the panel closes (each sign-in starts closed).
    const was = seen;
    seen = who;
    if (was && was !== who && readStored()) setPanelOpen(false);
  }, [who, loading]);
  return useSyncExternalStore(subscribe, () => openFor(who), () => false);
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
  setPanelOpen(true, !!readStored() && !transient);
}

/** Leaving the page that opened the panel for one question (Simple's Ask Oracle, a goal's Suggest) closes it (the shell, on every page change). */
export function closeTransientPanel() {
  if (transient && readStored()) setPanelOpen(false);
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

/**
 * ask-phone-12: a linked discussion (`?discussion=<id>`, the Inbox's Review changes) opens in
 * the panel on desktop, the one place for threads: its id, and whether to land on its changes.
 * Opened for it alone, the panel is not remembered and its question box does not take focus.
 */
export type LinkedThread = { id: string; changes: boolean };
let linked: LinkedThread | null = null;
const linkedListeners = new Set<() => void>();

export function askThread(next: LinkedThread) {
  if (linked?.id !== next.id || linked.changes !== next.changes) {
    linked = next;
    linkedListeners.forEach((l) => l());
  }
  if (!readStored()) {
    setPanelOpen(true, false);
    focusAsk = false;
  }
}

export function useLinkedThread(): LinkedThread | null {
  return useSyncExternalStore(
    (l) => {
      linkedListeners.add(l);
      return () => {
        linkedListeners.delete(l);
      };
    },
    () => linked,
    () => null,
  );
}

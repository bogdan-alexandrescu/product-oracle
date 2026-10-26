"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { api, unwrap } from "@/lib/api/client";

/** O1f: the layer a document opens on, remembered per user (GET/PATCH /v1/me/preferences). */
export type DocumentView = "brief" | "full";

let cached: DocumentView | null = null;
/** Counts the choices made in this page, so a read begun before one never lands over it. */
let choices = 0;
const listeners = new Set<(v: DocumentView) => void>();

/**
 * The signed-in user's document view. Starts on the brief until the saved choice
 * loads; `setView` saves the new choice for this user. A choice made while the saved one
 * is still loading (Show full document, or v, on the brief shown meanwhile) wins.
 */
export function useDocumentView(): [DocumentView, (v: DocumentView) => void, boolean] {
  const [view, setLocal] = useState<DocumentView>(cached ?? "brief");
  const [loaded, setLoaded] = useState(cached !== null);

  useEffect(() => {
    const on = (v: DocumentView) => setLocal(v);
    listeners.add(on);
    let alive = true;
    const asked = choices;
    unwrap(api.GET("/v1/me/preferences"))
      .then((p) => {
        // Read before the reader's latest choice: that choice stands (its PATCH saves it).
        if (asked !== choices) return;
        cached = p.document_view;
        if (alive) setLocal(p.document_view);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
      listeners.delete(on);
    };
  }, []);

  const setView = useCallback((v: DocumentView) => {
    choices += 1;
    cached = v;
    listeners.forEach((l) => l(v));
    void api.PATCH("/v1/me/preferences", { body: { document_view: v } });
  }, []);

  return [view, setView, loaded];
}

/** F1: the Plan shows approved items and drafts ("all"), or approved items only. */
export type PlanScope = "all" | "approved";

const PLAN_SCOPE_KEY = "oracle-plan-scope";
/** The choice made this visit, when the browser would not store it (private mode, storage full). */
const unsaved = new Map<string, PlanScope>();
const scopeListeners = new Set<() => void>();

function readPlanScope(userId: string): PlanScope {
  const held = unsaved.get(userId);
  if (held) return held;
  try {
    const v = localStorage.getItem(`${PLAN_SCOPE_KEY}:${userId}`);
    return v === "approved" ? "approved" : "all";
  } catch {
    return "all";
  }
}

function subscribePlanScope(listener: () => void) {
  scopeListeners.add(listener);
  return () => {
    scopeListeners.delete(listener);
  };
}

const noSubscribe = () => () => {};

/**
 * The Plan's scope, remembered per viewer in this browser (Approved + drafts by default).
 * `ready` turns true once the saved choice can be read (in the browser, signed in), so the
 * Plan loads once.
 */
export function usePlanScope(userId: string | null | undefined): [PlanScope, (s: PlanScope) => void, boolean] {
  const scope = useSyncExternalStore(
    subscribePlanScope,
    () => (userId ? readPlanScope(userId) : "all"),
    () => "all" as PlanScope,
  );
  const browser = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const set = useCallback(
    (next: PlanScope) => {
      if (!userId) return;
      unsaved.delete(userId);
      try {
        localStorage.setItem(`${PLAN_SCOPE_KEY}:${userId}`, next);
      } catch {
        unsaved.set(userId, next);
      }
      scopeListeners.forEach((l) => l());
    },
    [userId],
  );
  return [scope, set, browser && !!userId];
}

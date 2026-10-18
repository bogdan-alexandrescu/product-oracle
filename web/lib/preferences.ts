"use client";

import { useCallback, useEffect, useState } from "react";

import { api, unwrap } from "@/lib/api/client";

/** O1f: the layer a document opens on, remembered per user (GET/PATCH /v1/me/preferences). */
export type DocumentView = "brief" | "full";

let cached: DocumentView | null = null;
const listeners = new Set<(v: DocumentView) => void>();

/**
 * The signed-in user's document view. Starts on the brief until the saved choice
 * loads; `setView` saves the new choice for this user.
 */
export function useDocumentView(): [DocumentView, (v: DocumentView) => void, boolean] {
  const [view, setLocal] = useState<DocumentView>(cached ?? "brief");
  const [loaded, setLoaded] = useState(cached !== null);

  useEffect(() => {
    const on = (v: DocumentView) => setLocal(v);
    listeners.add(on);
    let alive = true;
    unwrap(api.GET("/v1/me/preferences"))
      .then((p) => {
        cached = p.document_view;
        if (alive) {
          setLocal(p.document_view);
          setLoaded(true);
        }
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
      listeners.delete(on);
    };
  }, []);

  const setView = useCallback((v: DocumentView) => {
    cached = v;
    listeners.forEach((l) => l(v));
    void api.PATCH("/v1/me/preferences", { body: { document_view: v } });
  }, []);

  return [view, setView, loaded];
}
